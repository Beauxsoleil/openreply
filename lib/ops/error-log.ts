/**
 * Deduped, rate-limited OperationalEvent logging.
 *
 * In November 2026 the DM worker failed every job for six days (Upstash
 * quota exhausted + a WRONGPASS auth error) and every failed job wrote one
 * OperationalEvent row via `recordWorkerFailure`. That produced ~2.3M rows
 * and 816 MB in Neon — ~300 rows a minute — and nearly filled the database.
 *
 * This module is the guardrail: identical errors collapse into a single row
 * whose payload carries an occurrence count, and a per-minute cap on *new*
 * rows bounds the worst case even when every error is distinct. The first
 * occurrence of an error is always recorded in full; duplicates are counted,
 * not stored.
 *
 * Deliberate one-off audit writes (follow-gate rejections, token-refresh
 * failures, sweep summaries) keep writing directly through Prisma — they
 * are low-volume by construction and are not routed through here.
 */

import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export type OperationalErrorSource =
  | "WORKER"
  | "TOKEN_REFRESH"
  | "HEALTH"
  | "SYSTEM";
export type OperationalErrorLevel = "INFO" | "WARNING" | "ERROR";

export interface OperationalErrorInput {
  /**
   * May be a thunk so the workspace lookup (a database query per failure)
   * only runs when a new row is actually written. Duplicate and suppressed
   * events never touch the database at all.
   */
  workspaceId?: string | null | (() => Promise<string | null>);
  source: OperationalErrorSource;
  level: OperationalErrorLevel;
  message: string;
  payload?: Prisma.InputJsonObject;
}

export interface OperationalEventWriter {
  create(data: {
    workspaceId: string | null;
    source: OperationalErrorSource;
    level: OperationalErrorLevel;
    message: string;
    payload: Prisma.InputJsonObject;
  }): Promise<{ id: string }>;
  update(
    id: string,
    data: { payload: Prisma.InputJsonObject }
  ): Promise<unknown>;
}

export type ErrorLogOutcome = "logged" | "duplicate" | "suppressed";

export interface ErrorLogDeduperOptions {
  /** How long identical errors fold into one row. Default 1 hour. */
  dedupeWindowMs?: number;
  /** Update the row's occurrence count every N duplicates. Default 100. */
  flushEveryOccurrences?: number;
  /** Max new rows per rolling minute, across all signatures. Default 10. */
  maxNewRowsPerMinute?: number;
  /** At most one "suppressed N rows" summary row per window. Default 5 min. */
  suppressedSummaryWindowMs?: number;
  /** Max distinct signatures remembered (oldest evicted first). Default 1000. */
  maxSignatures?: number;
  now?: () => number;
}

interface SeenEntry {
  rowId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrences: number;
  lastFlushedOccurrences: number;
}

/**
 * Strip the volatile parts of an error message so identical failures share
 * a signature: job ids, long tokens, and numbers (counts, usage figures).
 * The original message is still stored on the first row; only the dedupe
 * key is normalized.
 */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/DM worker job \S+ failed:/, "DM worker job failed:")
    .replace(/\bjob \S+ failed\b/, "job failed")
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, "<id>")
    .replace(/\b\d[\d,]*\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/** Stable dedupe key for an error: source + level + normalized message. */
export function errorSignature(
  source: OperationalErrorSource,
  level: OperationalErrorLevel,
  message: string
): string {
  return createHash("sha256")
    .update(`${source}|${level}|${normalizeErrorMessage(message)}`)
    .digest("hex");
}

const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_FLUSH_EVERY_OCCURRENCES = 100;
const DEFAULT_MAX_NEW_ROWS_PER_MINUTE = 10;
const DEFAULT_SUPPRESSED_SUMMARY_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SIGNATURES = 1000;

export class ErrorLogDeduper {
  private readonly dedupeWindowMs: number;
  private readonly flushEveryOccurrences: number;
  private readonly maxNewRowsPerMinute: number;
  private readonly suppressedSummaryWindowMs: number;
  private readonly maxSignatures: number;
  private readonly now: () => number;

  private seen = new Map<string, SeenEntry>();
  private newRowAt: number[] = [];
  private suppressedCount = 0;
  private suppressedWindowStart: number | null = null;

  constructor(options: ErrorLogDeduperOptions = {}) {
    this.dedupeWindowMs =
      options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.flushEveryOccurrences =
      options.flushEveryOccurrences ?? DEFAULT_FLUSH_EVERY_OCCURRENCES;
    this.maxNewRowsPerMinute =
      options.maxNewRowsPerMinute ?? DEFAULT_MAX_NEW_ROWS_PER_MINUTE;
    this.suppressedSummaryWindowMs =
      options.suppressedSummaryWindowMs ??
      DEFAULT_SUPPRESSED_SUMMARY_WINDOW_MS;
    this.maxSignatures = options.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
    this.now = options.now ?? Date.now;
  }

  async record(
    input: OperationalErrorInput,
    writer: OperationalEventWriter
  ): Promise<ErrorLogOutcome> {
    const now = this.now();
    const signature = errorSignature(input.source, input.level, input.message);
    const entry = this.seen.get(signature);

    // Same error inside the window: count it, write nothing. Every
    // `flushEveryOccurrences` duplicates, refresh the row's payload so the
    // count and last-seen time stay visible without a row per failure.
    if (entry && now - entry.firstSeenAt < this.dedupeWindowMs) {
      entry.occurrences += 1;
      entry.lastSeenAt = now;
      if (
        entry.occurrences - entry.lastFlushedOccurrences >=
        this.flushEveryOccurrences
      ) {
        entry.lastFlushedOccurrences = entry.occurrences;
        await writer.update(entry.rowId, {
          payload: this.countPayload(input, signature, entry),
        });
      }
      return "duplicate";
    }

    // New signature (or the window expired): the per-minute cap bounds the
    // worst case when every error is distinct.
    this.newRowAt = this.newRowAt.filter((t) => now - t < 60_000);
    if (this.newRowAt.length >= this.maxNewRowsPerMinute) {
      await this.noteSuppressed(writer, now);
      return "suppressed";
    }

    const workspaceId =
      typeof input.workspaceId === "function"
        ? await input.workspaceId()
        : (input.workspaceId ?? null);
    const row = await writer.create({
      workspaceId,
      source: input.source,
      level: input.level,
      message: input.message,
      payload: {
        ...(input.payload ?? {}),
        dedupSignature: signature,
        occurrences: 1,
        firstSeenAt: new Date(now).toISOString(),
      },
    });
    this.newRowAt.push(now);
    this.remember(signature, {
      rowId: row.id,
      firstSeenAt: now,
      lastSeenAt: now,
      occurrences: 1,
      lastFlushedOccurrences: 1,
    });
    return "logged";
  }

  private countPayload(
    input: OperationalErrorInput,
    signature: string,
    entry: SeenEntry
  ): Prisma.InputJsonObject {
    return {
      ...(input.payload ?? {}),
      dedupSignature: signature,
      occurrences: entry.occurrences,
      firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
      lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
    };
  }

  private remember(signature: string, entry: SeenEntry): void {
    // Map preserves insertion order, so the first key is the oldest entry.
    if (this.seen.size >= this.maxSignatures) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(signature, entry);
  }

  private async noteSuppressed(
    writer: OperationalEventWriter,
    now: number
  ): Promise<void> {
    this.suppressedCount += 1;
    if (this.suppressedWindowStart === null) {
      this.suppressedWindowStart = now;
      return;
    }
    if (now - this.suppressedWindowStart < this.suppressedSummaryWindowMs) {
      return;
    }
    const count = this.suppressedCount;
    const windowMinutes = Math.round(
      this.suppressedSummaryWindowMs / 60_000
    );
    this.suppressedCount = 0;
    this.suppressedWindowStart = now;
    try {
      await writer.create({
        workspaceId: null,
        source: "SYSTEM",
        level: "WARNING",
        message: `Suppressed ${count} duplicate operational error rows in the last ${windowMinutes} minutes (error-log rate limit)`,
        payload: { suppressedCount: count },
      });
    } catch {
      // The summary row is best-effort: never let it throw into the caller.
    }
  }
}

const prismaWriter: OperationalEventWriter = {
  create: (data) => prisma.operationalEvent.create({ data }),
  update: (id, data) => prisma.operationalEvent.update({ where: { id }, data }),
};

const defaultDeduper = new ErrorLogDeduper({
  dedupeWindowMs: Number(
    process.env.ERROR_LOG_DEDUPE_WINDOW_MS ?? DEFAULT_DEDUPE_WINDOW_MS
  ),
  maxNewRowsPerMinute: Number(
    process.env.ERROR_LOG_MAX_NEW_ROWS_PER_MINUTE ??
      DEFAULT_MAX_NEW_ROWS_PER_MINUTE
  ),
});

/**
 * Record a worker/system error in OperationalEvent, deduped and
 * rate-limited. Never throws: a logging failure must not break the caller.
 */
export async function recordOperationalError(
  input: OperationalErrorInput
): Promise<ErrorLogOutcome> {
  try {
    return await defaultDeduper.record(input, prismaWriter);
  } catch (error) {
    console.error(
      "[ErrorLog] Failed to record operational error:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return "suppressed";
  }
}
