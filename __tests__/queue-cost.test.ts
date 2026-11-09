import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REDIS_WORKER_DRAIN_DELAY_SECONDS,
  getRedisWorkerDrainDelaySeconds,
} from "@/lib/queue/client";

describe("Redis free-tier worker settings", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses a low-command idle polling interval by default", () => {
    vi.stubEnv("REDIS_WORKER_DRAIN_DELAY_SECONDS", "");
    expect(getRedisWorkerDrainDelaySeconds()).toBe(
      DEFAULT_REDIS_WORKER_DRAIN_DELAY_SECONDS
    );
  });

  it("allows a slower worker wake-up interval", () => {
    vi.stubEnv("REDIS_WORKER_DRAIN_DELAY_SECONDS", "60");
    expect(getRedisWorkerDrainDelaySeconds()).toBe(60);
  });

  it("rejects invalid or high-command polling intervals", () => {
    vi.stubEnv("REDIS_WORKER_DRAIN_DELAY_SECONDS", "1");
    expect(getRedisWorkerDrainDelaySeconds()).toBe(
      DEFAULT_REDIS_WORKER_DRAIN_DELAY_SECONDS
    );
    vi.stubEnv("REDIS_WORKER_DRAIN_DELAY_SECONDS", "not-a-number");
    expect(getRedisWorkerDrainDelaySeconds()).toBe(
      DEFAULT_REDIS_WORKER_DRAIN_DELAY_SECONDS
    );
  });
});
