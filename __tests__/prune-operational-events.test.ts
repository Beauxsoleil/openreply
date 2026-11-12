import { describe, it, expect, vi, beforeEach } from "vitest";
import { pruneOperationalEvents } from "@/lib/ops/prune-operational-events";

function createFakeDelegate() {
  return {
    count: vi.fn(async (_args: { where?: unknown } = {}) => {
      void _args;
      return 0;
    }),
    findMany: vi.fn(
      async (
        _args: {
          select?: unknown;
          where?: unknown;
          orderBy?: unknown;
          take?: number;
        } = {}
      ) => {
        void _args;
        return [] as Array<{ id: string }>;
      }
    ),
    deleteMany: vi.fn(
      async (_args: { where: { id: { in: string[] } } }) => {
        void _args;
        return { count: 0 };
      }
    ),
  };
}

type FakeDelegate = ReturnType<typeof createFakeDelegate>;

function asPrismaClient(delegate: FakeDelegate) {
  return { operationalEvent: delegate } as unknown as Parameters<
    typeof pruneOperationalEvents
  >[0];
}

const NOW = new Date("2026-11-12T12:00:00.000Z");

describe("pruneOperationalEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dry-run counts matches and deletes nothing", async () => {
    const delegate = createFakeDelegate();
    delegate.count.mockResolvedValue(42);
    const result = await pruneOperationalEvents(asPrismaClient(delegate), {
      now: NOW,
    });
    expect(result).toEqual({
      deleted: 0,
      wouldDelete: 42,
      batches: 0,
      stoppedEarly: false,
      dryRun: true,
    });
    expect(delegate.count).toHaveBeenCalledTimes(1);
    expect(delegate.deleteMany).not.toHaveBeenCalled();
  });

  it("dry-run caps the reported count at maxRows", async () => {
    const delegate = createFakeDelegate();
    delegate.count.mockResolvedValue(500_000);
    const result = await pruneOperationalEvents(asPrismaClient(delegate), {
      now: NOW,
      maxRows: 1000,
    });
    expect(result.wouldDelete).toBe(1000);
    expect(result.stoppedEarly).toBe(true);
  });

  it("selects only old Redis-failure errors and old resolved rows", async () => {
    const delegate = createFakeDelegate();
    await pruneOperationalEvents(asPrismaClient(delegate), {
      now: NOW,
      redisFailureOlderThanDays: 7,
      resolvedOlderThanDays: 30,
    });
    const where = delegate.count.mock.calls[0]![0]!.where;
    expect(where).toMatchObject({
      OR: expect.arrayContaining([
        expect.objectContaining({
          source: "WORKER",
          level: "ERROR",
          createdAt: { lt: new Date("2026-11-05T12:00:00.000Z") },
          OR: expect.arrayContaining([
            { message: { contains: "WRONGPASS" } },
            { message: { contains: "max requests limit exceeded" } },
          ]),
        }),
        { resolvedAt: { lt: new Date("2026-10-13T12:00:00.000Z") } },
      ]),
    });
  });

  it("deletes in bounded batches by id, oldest first", async () => {
    const delegate = createFakeDelegate();
    delegate.findMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([{ id: "c" }])
      .mockResolvedValueOnce([]);
    delegate.deleteMany.mockImplementation(
      async (args: { where: { id: { in: string[] } } }) => ({
        count: args.where.id.in.length,
      })
    );
    const result = await pruneOperationalEvents(asPrismaClient(delegate), {
      now: NOW,
      dryRun: false,
      batchSize: 2,
      sleepMsBetweenBatches: 0,
    });
    // Second batch returns 1 row (< take), so the loop stops after it.
    expect(result).toEqual({
      deleted: 3,
      wouldDelete: 0,
      batches: 2,
      stoppedEarly: false,
      dryRun: false,
    });
    expect(delegate.findMany).toHaveBeenCalledTimes(2);
    expect(delegate.findMany.mock.calls[0]![0]).toMatchObject({
      take: 2,
      orderBy: { createdAt: "asc" },
    });
    expect(delegate.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ["a", "b"] } },
    });
    expect(delegate.deleteMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ["c"] } },
    });
  });

  it("stops at maxRows and reports stoppedEarly", async () => {
    const delegate = createFakeDelegate();
    delegate.findMany.mockResolvedValue([
      { id: "a" },
      { id: "b" },
    ]);
    delegate.deleteMany.mockResolvedValue({ count: 2 });
    const result = await pruneOperationalEvents(asPrismaClient(delegate), {
      now: NOW,
      dryRun: false,
      batchSize: 2,
      maxRows: 2,
      sleepMsBetweenBatches: 0,
    });
    expect(result.deleted).toBe(2);
    expect(result.batches).toBe(1);
    expect(result.stoppedEarly).toBe(true);
    expect(delegate.findMany).toHaveBeenCalledTimes(1);
  });

  it("deletes nothing when nothing matches", async () => {
    const delegate = createFakeDelegate();
    const result = await pruneOperationalEvents(asPrismaClient(delegate), {
      now: NOW,
      dryRun: false,
      sleepMsBetweenBatches: 0,
    });
    expect(result).toEqual({
      deleted: 0,
      wouldDelete: 0,
      batches: 0,
      stoppedEarly: false,
      dryRun: false,
    });
    expect(delegate.deleteMany).not.toHaveBeenCalled();
  });
});
