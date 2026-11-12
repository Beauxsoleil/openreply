/**
 * Retention policy for nonessential OperationalEvent rows.
 *
 * OperationalEvent is the audit log, so this prunes narrowly — only two
 * classes of rows, both nonessential by construction:
 *
 * 1. Repetitive Redis-failure WORKER/ERROR rows (the November 2026 flood
 *    shape: Upstash quota / WRONGPASS messages) older than
 *    `redisFailureOlderThanDays` (default 7). These carry no per-row
 *    information: the message is identical across millions of rows.
 * 2. Resolved rows (`resolvedAt` set) older than `resolvedOlderThanDays`
 *    (default 30). A resolved event has already been dealt with.
 *
 * Everything else is preserved: INFO/WARNING rows, unresolved errors,
 * non-Redis errors, token-refresh and system events, and all campaign,
 * DmLog, webhook, and publishing data (which this job never touches).
 *
 * Deletes run in bounded batches (default 500 rows) with a pause between
 * batches, so a large prune never holds long locks or balloons the
 * transaction log. Dry-run is the default: pass `dryRun: false` only from
 * the CLI with `--apply` and `OPERATIONAL_EVENT_PRUNE_CONFIRM=1`.
 *
 * This is code + a documented job only. It is never run automatically and
 * must only be run after a verified Neon backup exists (see
 * docs/operational-event-retention.md).
 */

import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import {
  REDIS_AUTH_MESSAGE_PATTERNS,
  REDIS_QUOTA_MESSAGE_PATTERNS,
} from "@/lib/queue/redis-errors";

export interface PruneOperationalEventsOptions {
  /** Prune Redis-failure WORKER/ERROR rows older than this. Default 7 days. */
  redisFailureOlderThanDays?: number;
  /** Prune resolved rows older than this. Default 30 days. */
  resolvedOlderThanDays?: number;
  /** Rows deleted per batch. Default 500. */
  batchSize?: number;
  /** Max rows deleted (or counted, in dry-run) per run. Default 100,000. */
  maxRows?: number;
  /** Count only, delete nothing. Default true. */
  dryRun?: boolean;
  /** Pause between batches, in ms. Default 100. */
  sleepMsBetweenBatches?: number;
  now?: Date;
}

export interface PruneOperationalEventsResult {
  deleted: number;
  wouldDelete: number;
  batches: number;
  stoppedEarly: boolean;
  dryRun: boolean;
}

type OperationalEventPruneDelegate = Pick<
  PrismaClient["operationalEvent"],
  "count" | "findMany" | "deleteMany"
>;

const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pruneWhere(
  redisCutoff: Date,
  resolvedCutoff: Date
): Prisma.OperationalEventWhereInput {
  return {
    OR: [
      {
        source: "WORKER",
        level: "ERROR",
        createdAt: { lt: redisCutoff },
        OR: [...REDIS_AUTH_MESSAGE_PATTERNS, ...REDIS_QUOTA_MESSAGE_PATTERNS].map(
          (pattern) => ({ message: { contains: pattern } })
        ),
      },
      // `lt` on a nullable DateTime excludes NULLs, so only rows with a
      // resolvedAt in the past match.
      { resolvedAt: { lt: resolvedCutoff } },
    ],
  };
}

export async function pruneOperationalEvents(
  client: { operationalEvent: OperationalEventPruneDelegate },
  options: PruneOperationalEventsOptions = {}
): Promise<PruneOperationalEventsResult> {
  const redisFailureOlderThanDays = options.redisFailureOlderThanDays ?? 7;
  const resolvedOlderThanDays = options.resolvedOlderThanDays ?? 30;
  const batchSize = options.batchSize ?? 500;
  const maxRows = options.maxRows ?? 100_000;
  const dryRun = options.dryRun ?? true;
  const sleepMsBetweenBatches = options.sleepMsBetweenBatches ?? 100;
  const now = options.now ?? new Date();

  const where = pruneWhere(
    new Date(now.getTime() - redisFailureOlderThanDays * DAY_MS),
    new Date(now.getTime() - resolvedOlderThanDays * DAY_MS)
  );

  if (dryRun) {
    const total = await client.operationalEvent.count({ where });
    return {
      deleted: 0,
      wouldDelete: Math.min(total, maxRows),
      batches: 0,
      stoppedEarly: total > maxRows,
      dryRun: true,
    };
  }

  let deleted = 0;
  let batches = 0;
  let stoppedEarly = false;
  while (deleted < maxRows) {
    const take = Math.min(batchSize, maxRows - deleted);
    const rows = await client.operationalEvent.findMany({
      select: { id: true },
      where,
      orderBy: { createdAt: "asc" },
      take,
    });
    if (rows.length === 0) break;
    batches += 1;
    const result = await client.operationalEvent.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deleted += result.count;
    if (rows.length < take) break;
    if (deleted >= maxRows) {
      stoppedEarly = true;
      break;
    }
    if (sleepMsBetweenBatches > 0) await sleep(sleepMsBetweenBatches);
  }
  return { deleted, wouldDelete: 0, batches, stoppedEarly, dryRun: false };
}
