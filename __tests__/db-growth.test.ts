import { describe, it, expect, vi } from "vitest";
import { checkOperationalEventGrowth } from "@/lib/ops/db-growth";

function createFakeCounter(rowsLastHour: number, workerErrorsLastHour: number, total: number) {
  const count = vi.fn(async (args?: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    if (!("createdAt" in where)) return total;
    if (where.source === "WORKER" && where.level === "ERROR") {
      return workerErrorsLastHour;
    }
    return rowsLastHour;
  });
  return { operationalEvent: { count } } as unknown as Parameters<
    typeof checkOperationalEventGrowth
  >[0];
}

describe("checkOperationalEventGrowth", () => {
  it("reports ok at normal volume", async () => {
    const result = await checkOperationalEventGrowth(
      createFakeCounter(12, 2, 1500)
    );
    expect(result.status).toBe("ok");
    expect(result.rowsLastHour).toBe(12);
    expect(result.workerErrorRowsLastHour).toBe(2);
    expect(result.totalRows).toBe(1500);
    expect(result.detail).toBe(
      "12 OperationalEvent rows in the last hour (2 WORKER/ERROR), 1500 total"
    );
  });

  it("reports warning at the warn threshold", async () => {
    const result = await checkOperationalEventGrowth(
      createFakeCounter(500, 400, 2000),
      { warnPerHour: 500, criticalPerHour: 5000 }
    );
    expect(result.status).toBe("warning");
  });

  it("reports critical at the critical threshold", async () => {
    const result = await checkOperationalEventGrowth(
      createFakeCounter(18_000, 18_000, 2_300_000),
      { warnPerHour: 500, criticalPerHour: 5000 }
    );
    expect(result.status).toBe("critical");
  });

  it("counts the last hour from now", async () => {
    const client = createFakeCounter(1, 0, 10);
    await checkOperationalEventGrowth(client);
    const count = (client.operationalEvent as { count: ReturnType<typeof vi.fn> }).count;
    const [firstCall] = count.mock.calls;
    const since = firstCall[0].where.createdAt.gt as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(59 * 60_000);
    expect(Date.now() - since.getTime()).toBeLessThanOrEqual(61 * 60_000);
  });
});
