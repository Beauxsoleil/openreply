import { describe, it, expect, vi } from "vitest";
import {
  WorkerCircuitBreaker,
  type PausableWorker,
} from "@/lib/queue/worker-circuit";

function createFakeWorker(): PausableWorker & {
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
} {
  return {
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
  };
}

describe("WorkerCircuitBreaker", () => {
  it("pauses the worker on the first trip and ignores later trips", async () => {
    const worker = createFakeWorker();
    const breaker = new WorkerCircuitBreaker();
    expect(await breaker.trip(worker, "redis-quota")).toBe(true);
    expect(await breaker.trip(worker, "redis-auth")).toBe(false);
    expect(worker.pause).toHaveBeenCalledTimes(1);
    expect(breaker.isPaused).toBe(true);
    // The first trip wins: the original reason is the one that matters.
    expect(breaker.pauseReason).toBe("redis-quota");
  });

  it("maybeResume is a no-op when not paused and never pings", async () => {
    const worker = createFakeWorker();
    const breaker = new WorkerCircuitBreaker();
    const ping = vi.fn(async () => true);
    expect(await breaker.maybeResume(worker, ping)).toBe("not-paused");
    expect(ping).not.toHaveBeenCalled();
    expect(worker.resume).not.toHaveBeenCalled();
  });

  it("does not ping before the resume interval elapses", async () => {
    let now = 1_000_000;
    const worker = createFakeWorker();
    const breaker = new WorkerCircuitBreaker({
      resumeCheckIntervalMs: 5 * 60_000,
      now: () => now,
    });
    await breaker.trip(worker, "redis-quota");
    const ping = vi.fn(async () => true);
    now += 60_000;
    expect(await breaker.maybeResume(worker, ping)).toBe("still-paused");
    expect(ping).not.toHaveBeenCalled();
  });

  it("stays paused when the ping fails and retries after the interval", async () => {
    let now = 1_000_000;
    const worker = createFakeWorker();
    const breaker = new WorkerCircuitBreaker({
      resumeCheckIntervalMs: 5 * 60_000,
      now: () => now,
    });
    await breaker.trip(worker, "redis-quota");
    const ping = vi.fn(async () => false);
    now += 5 * 60_000;
    expect(await breaker.maybeResume(worker, ping)).toBe("still-paused");
    expect(ping).toHaveBeenCalledTimes(1);
    expect(worker.resume).not.toHaveBeenCalled();
    expect(breaker.resumeCheckCount).toBe(1);
    // The next check is a full interval later, not immediately.
    now += 60_000;
    expect(await breaker.maybeResume(worker, ping)).toBe("still-paused");
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing ping as a failed check", async () => {
    let now = 1_000_000;
    const worker = createFakeWorker();
    const breaker = new WorkerCircuitBreaker({
      resumeCheckIntervalMs: 1000,
      now: () => now,
    });
    await breaker.trip(worker, "redis-auth");
    const ping = vi.fn(async () => {
      throw new Error("WRONGPASS");
    });
    now += 1000;
    expect(await breaker.maybeResume(worker, ping)).toBe("still-paused");
    expect(breaker.isPaused).toBe(true);
  });

  it("resumes the worker on the first successful ping and clears state", async () => {
    let now = 1_000_000;
    const worker = createFakeWorker();
    const breaker = new WorkerCircuitBreaker({
      resumeCheckIntervalMs: 5 * 60_000,
      now: () => now,
    });
    await breaker.trip(worker, "redis-quota");
    const ping = vi.fn(async () => true);
    now += 5 * 60_000;
    expect(await breaker.maybeResume(worker, ping)).toBe("resumed");
    expect(worker.resume).toHaveBeenCalledTimes(1);
    expect(breaker.isPaused).toBe(false);
    expect(breaker.pauseReason).toBeNull();
    expect(breaker.resumeCheckCount).toBe(0);
    // A later failure can trip the breaker again.
    expect(await breaker.trip(worker, "redis-auth")).toBe(true);
  });
});
