import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRedis, mockGetRedisConnection } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const mockRedis = {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    lpush: vi.fn(async () => 1),
    ltrim: vi.fn(async () => "OK"),
    lrange: vi.fn(async () => [] as string[]),
    __store: store,
  };
  return { mockRedis, mockGetRedisConnection: vi.fn(() => mockRedis) };
});

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: mockGetRedisConnection,
}));

import {
  getWorkerHealth,
  recordWorkerHeartbeat,
} from "../lib/ops/worker-health";

beforeEach(() => {
  mockRedis.__store.clear();
  vi.clearAllMocks();
});

describe("worker health keys", () => {
  it("writes the DM and publishing heartbeats to separate keys", async () => {
    await recordWorkerHeartbeat({ pid: 111, hostname: "vm-a", startedAt: "2026-11-07T00:00:00.000Z" });
    await recordWorkerHeartbeat(
      { pid: 222, hostname: "vm-a", startedAt: "2026-11-07T00:00:00.000Z" },
      "publishing"
    );

    const dm = await getWorkerHealth();
    expect(dm.heartbeat?.worker).toBe("dm");
    expect(dm.heartbeat?.pid).toBe(111);
    const pub = await getWorkerHealth("publishing");
    expect(pub.heartbeat?.worker).toBe("publishing");
    expect(pub.heartbeat?.pid).toBe(222);
    // Neither write clobbered the other.
    expect((await getWorkerHealth()).heartbeat?.pid).toBe(111);
  });

  it("reports unhealthy when no heartbeat exists", async () => {
    const health = await getWorkerHealth("publishing");
    expect(health).toEqual({ healthy: false, heartbeat: null, ageMs: null });
  });
});
