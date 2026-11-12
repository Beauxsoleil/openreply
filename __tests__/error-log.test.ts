import { describe, it, expect, vi } from "vitest";
import {
  ErrorLogDeduper,
  errorSignature,
  normalizeErrorMessage,
  type OperationalEventWriter,
} from "@/lib/ops/error-log";

const QUOTA_MESSAGE =
  "DM worker job cm123 failed: ERR max requests limit exceeded (limit 500,000, usage 500,005)";
const QUOTA_MESSAGE_OTHER_JOB =
  "DM worker job cm999 failed: ERR max requests limit exceeded (limit 500,000, usage 500,120)";

function createFakeWriter() {
  const rows: Array<{ id: string; data: Record<string, unknown> }> = [];
  let nextId = 1;
  const writer: OperationalEventWriter = {
    create: vi.fn(async (data) => {
      const row = { id: `row_${nextId++}`, data: { ...data } };
      rows.push(row);
      return { id: row.id };
    }),
    update: vi.fn(async (id: string, data: { payload: unknown }) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.data = { ...row.data, ...data };
      return {};
    }),
  };
  return { writer, rows };
}

describe("normalizeErrorMessage", () => {
  it("strips job ids and numbers so identical failures share a key", () => {
    expect(normalizeErrorMessage(QUOTA_MESSAGE)).toBe(
      normalizeErrorMessage(QUOTA_MESSAGE_OTHER_JOB)
    );
    expect(normalizeErrorMessage(QUOTA_MESSAGE)).toBe(
      "DM worker job failed: ERR max requests limit exceeded (limit #, usage #)"
    );
  });

  it("keeps distinct errors distinct", () => {
    expect(
      normalizeErrorMessage("DM worker job cm123 failed: WRONGPASS bad password")
    ).not.toBe(normalizeErrorMessage(QUOTA_MESSAGE));
  });
});

describe("errorSignature", () => {
  it("is stable across volatile parts and differs by source/level/message", () => {
    expect(
      errorSignature("WORKER", "ERROR", QUOTA_MESSAGE)
    ).toBe(errorSignature("WORKER", "ERROR", QUOTA_MESSAGE_OTHER_JOB));
    expect(errorSignature("WORKER", "ERROR", QUOTA_MESSAGE)).not.toBe(
      errorSignature("SYSTEM", "ERROR", QUOTA_MESSAGE)
    );
    expect(errorSignature("WORKER", "ERROR", QUOTA_MESSAGE)).not.toBe(
      errorSignature("WORKER", "WARNING", QUOTA_MESSAGE)
    );
  });
});

describe("ErrorLogDeduper", () => {
  it("writes the first occurrence in full", async () => {
    const { writer, rows } = createFakeWriter();
    const deduper = new ErrorLogDeduper();
    const outcome = await deduper.record(
      { source: "WORKER", level: "ERROR", message: QUOTA_MESSAGE },
      writer
    );
    expect(outcome).toBe("logged");
    expect(writer.create).toHaveBeenCalledTimes(1);
    expect(rows[0].data.message).toBe(QUOTA_MESSAGE);
    expect(rows[0].data.payload).toMatchObject({
      occurrences: 1,
      dedupSignature: expect.any(String),
    });
  });

  it("folds repeats into the same row and flushes the count periodically", async () => {
    const { writer, rows } = createFakeWriter();
    const deduper = new ErrorLogDeduper({ flushEveryOccurrences: 3 });
    const input = { source: "WORKER" as const, level: "ERROR" as const, message: QUOTA_MESSAGE };
    expect(await deduper.record(input, writer)).toBe("logged");
    expect(await deduper.record({ ...input, message: QUOTA_MESSAGE_OTHER_JOB }, writer)).toBe("duplicate");
    expect(await deduper.record(input, writer)).toBe("duplicate");
    expect(writer.create).toHaveBeenCalledTimes(1);
    expect(writer.update).not.toHaveBeenCalled();
    // 4th occurrence trips the flush threshold (3 since the last flush).
    expect(await deduper.record(input, writer)).toBe("duplicate");
    expect(writer.update).toHaveBeenCalledTimes(1);
    expect(rows[0].data.payload).toMatchObject({
      occurrences: 4,
      lastSeenAt: expect.any(String),
    });
  });

  it("writes a new row after the dedupe window expires", async () => {
    let now = 1_000_000;
    const { writer } = createFakeWriter();
    const deduper = new ErrorLogDeduper({
      dedupeWindowMs: 60_000,
      now: () => now,
    });
    const input = { source: "WORKER" as const, level: "ERROR" as const, message: QUOTA_MESSAGE };
    expect(await deduper.record(input, writer)).toBe("logged");
    now += 61_000;
    expect(await deduper.record(input, writer)).toBe("logged");
    expect(writer.create).toHaveBeenCalledTimes(2);
  });

  it("rate-limits new rows per minute and summarizes the suppressed ones", async () => {
    let now = 1_000_000;
    const { writer, rows } = createFakeWriter();
    const deduper = new ErrorLogDeduper({
      maxNewRowsPerMinute: 2,
      suppressedSummaryWindowMs: 5 * 60_000,
      now: () => now,
    });
    const make = (n: number) => ({
      source: "WORKER" as const,
      level: "ERROR" as const,
      message: `distinct failure number ${n} with text ${"x".repeat(n)}`,
    });
    expect(await deduper.record(make(1), writer)).toBe("logged");
    expect(await deduper.record(make(2), writer)).toBe("logged");
    expect(await deduper.record(make(3), writer)).toBe("suppressed");
    expect(await deduper.record(make(4), writer)).toBe("suppressed");
    expect(writer.create).toHaveBeenCalledTimes(2);
    // The summary row appears only when another suppression happens after
    // the summary window elapses. Re-saturate the per-minute limit first:
    // the first two rows of the new minute log normally, the third is
    // suppressed and flushes the summary for all three suppressed rows.
    now += 5 * 60_000 + 1;
    expect(await deduper.record(make(5), writer)).toBe("logged");
    expect(await deduper.record(make(6), writer)).toBe("logged");
    expect(await deduper.record(make(7), writer)).toBe("suppressed");
    expect(writer.create).toHaveBeenCalledTimes(5);
    expect(rows[4].data.message).toMatch(/Suppressed 3 duplicate/);
    expect(rows[4].data.level).toBe("WARNING");
  });

  it("does not resolve the lazy workspace id for duplicates", async () => {
    const { writer } = createFakeWriter();
    const deduper = new ErrorLogDeduper();
    const resolveWorkspaceId = vi.fn(async () => "workspace_1");
    const input = {
      source: "WORKER" as const,
      level: "ERROR" as const,
      message: QUOTA_MESSAGE,
      workspaceId: resolveWorkspaceId,
    };
    await deduper.record(input, writer);
    await deduper.record(input, writer);
    await deduper.record(input, writer);
    expect(resolveWorkspaceId).toHaveBeenCalledTimes(1);
    expect(writer.create).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest signature when the map is full", async () => {
    const { writer } = createFakeWriter();
    const deduper = new ErrorLogDeduper({ maxSignatures: 2 });
    const make = (label: string) => ({
      source: "WORKER" as const,
      level: "ERROR" as const,
      message: `failure ${label}`,
    });
    await deduper.record(make("aaa"), writer);
    await deduper.record(make("bbb"), writer);
    await deduper.record(make("ccc"), writer);
    // "aaa" was evicted, so it logs again instead of deduping.
    expect(await deduper.record(make("aaa"), writer)).toBe("logged");
    expect(writer.create).toHaveBeenCalledTimes(4);
  });
});
