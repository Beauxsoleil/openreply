/**
 * Rate Limiter — Unit Tests
 *
 * Tests the hourly private-reply cap enforcement using mocked Redis.
 * Assertions derive from RATE_LIMIT_MAX so they survive a change to the cap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGet, mockEval, mockDel, mockDecr, redisState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockEval: vi.fn(),
  mockDel: vi.fn(),
  mockDecr: vi.fn(),
  // Mutable connection state so tests can simulate a client that is still
  // connecting when the first command is issued.
  redisState: {
    status: "ready",
    readyHandler: null as (() => void) | null,
    errorHandler: null as ((error: Error) => void) | null,
  },
}));

vi.mock("ioredis", () => {
  const MockRedis = vi.fn().mockImplementation(function (
    this: Record<string, unknown>
  ) {
    this.get = mockGet;
    this.eval = mockEval;
    this.del = mockDel;
    this.decr = mockDecr;
    this.on = vi.fn();
    this.once = (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "ready") redisState.readyHandler = handler as () => void;
      else if (event === "error")
        redisState.errorHandler = handler as (error: Error) => void;
    };
    this.off = vi.fn();
    Object.defineProperty(this, "status", {
      get: () => redisState.status,
    });
    return this;
  });
  return { default: MockRedis };
});

vi.stubEnv("REDIS_URL", "redis://localhost:6379");

import {
  checkRateLimit,
  incrementDMCounter,
  reserveDMSlot,
  releaseDMSlot,
  RATE_LIMIT_MAX,
} from "../lib/utils/rate-limiter";

beforeEach(() => {
  vi.clearAllMocks();
  redisState.status = "ready";
  redisState.readyHandler = null;
  redisState.errorHandler = null;
});

describe("readiness", () => {
  it("waits for Redis to be ready before issuing the first reserve", async () => {
    redisState.status = "connecting";
    mockEval.mockResolvedValue([1, 51, 139]);

    const promise = reserveDMSlot("account_123");
    // No command while the client is still connecting: with
    // enableOfflineQueue:false an immediate eval would be rejected.
    expect(mockEval).not.toHaveBeenCalled();

    redisState.status = "ready";
    redisState.readyHandler?.();
    const result = await promise;

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rate:dm:account_123",
      RATE_LIMIT_MAX,
      3600
    );
    expect(result.allowed).toBe(true);
    expect(result.reserved).toBe(true);
  });

  it("waits for Redis to be ready before checking the count", async () => {
    redisState.status = "connecting";
    mockGet.mockResolvedValue("50");

    const promise = checkRateLimit("account_123");
    expect(mockGet).not.toHaveBeenCalled();

    redisState.status = "ready";
    redisState.readyHandler?.();
    const result = await promise;

    expect(mockGet).toHaveBeenCalledWith("rate:dm:account_123");
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(50);
  });

  it("fails fast when Redis never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      redisState.status = "connecting";
      const promise = reserveDMSlot("account_123");
      const assertion = expect(promise).rejects.toThrow(/become ready/);
      await vi.advanceTimersByTimeAsync(3000);
      await assertion;
      expect(mockEval).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("checkRateLimit", () => {
  it("should allow when count is below limit", async () => {
    mockGet.mockResolvedValue("50");

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(50);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX - 50);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(false);
    expect(result.reserved).toBe(false);
  });

  it("should allow when no previous count exists", async () => {
    mockGet.mockResolvedValue(null);

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX);
  });

  it("should deny when count reaches the limit", async () => {
    mockGet.mockResolvedValue(String(RATE_LIMIT_MAX));

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockGet.mockResolvedValue(String(RATE_LIMIT_MAX));

    const result = await checkRateLimit("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("reserveDMSlot", () => {
  it("should atomically reserve a slot when below the hourly cap", async () => {
    mockEval.mockResolvedValue([1, 51, 139]);

    const result = await reserveDMSlot("account_123");

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rate:dm:account_123",
      RATE_LIMIT_MAX,
      3600
    );
    expect(result.allowed).toBe(true);
    expect(result.reserved).toBe(true);
    expect(result.currentCount).toBe(51);
    expect(result.remainingDMs).toBe(139);
  });

  it("should recommend requeue when the atomic reserve is denied", async () => {
    mockEval.mockResolvedValue([0, RATE_LIMIT_MAX, 0]);

    const result = await reserveDMSlot("account_123", 0);

    expect(result.allowed).toBe(false);
    expect(result.reserved).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockEval.mockResolvedValue(["0", String(RATE_LIMIT_MAX), "0"]);

    const result = await reserveDMSlot("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("incrementDMCounter", () => {
  it("should use the atomic reservation path", async () => {
    mockEval.mockResolvedValue([1, 51, 139]);

    const count = await incrementDMCounter("account_123");

    expect(mockEval).toHaveBeenCalled();
    expect(count).toBe(51);
  });
});

describe("releaseDMSlot", () => {
  it("hands a reserved slot back and returns the new count", async () => {
    mockDecr.mockResolvedValue(49);

    const count = await releaseDMSlot("account_123");

    expect(mockDecr).toHaveBeenCalledWith("rate:dm:account_123");
    expect(count).toBe(49);
  });

  it("clamps to zero and clears the key when nothing was reserved", async () => {
    mockDecr.mockResolvedValue(-1);

    const count = await releaseDMSlot("account_123");

    expect(count).toBe(0);
    expect(mockDel).toHaveBeenCalledWith("rate:dm:account_123");
  });
});
