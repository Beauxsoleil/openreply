/**
 * Circuit breaker for the DM worker's BullMQ consumer.
 *
 * In November 2026 the worker kept pulling jobs and failing them for six
 * days while Redis was unusable (Upstash quota exhausted, plus a WRONGPASS
 * auth error). Each failure wrote an OperationalEvent row, and the
 * 5-minute comment sweep re-enqueued the same comments, so the loop never
 * stopped. Pausing the consumer breaks that loop: jobs stay queued instead
 * of failing, no error rows are written, and nothing is retried until
 * Redis answers again.
 *
 * - Quota trips recover on their own: the breaker re-pings Redis on an
 *   interval and resumes the worker as soon as a ping succeeds.
 * - Auth trips need a human: a wrong password never self-heals, so the
 *   worker stays paused (one cheap ping per interval) until the
 *   credentials are fixed and the next check succeeds.
 *
 * Connection errors do NOT trip the breaker: a transient Redis restart is
 * ioredis's job to ride out (bounded reconnect backoff in
 * lib/queue/client.ts), and pausing on every blip would stall the worker
 * for no benefit.
 */

export type CircuitTripReason = "redis-quota" | "redis-auth";

export interface PausableWorker {
  pause(): Promise<void>;
  // BullMQ's Worker.resume() is synchronous (void); other implementations
  // may be async. `await` handles both.
  resume(): Promise<void> | void;
}

export interface WorkerCircuitBreakerOptions {
  /** Minimum gap between Redis recovery checks while paused. Default 5 min. */
  resumeCheckIntervalMs?: number;
  now?: () => number;
}

export type ResumeCheckResult = "resumed" | "still-paused" | "not-paused";

const DEFAULT_RESUME_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export class WorkerCircuitBreaker {
  private readonly resumeCheckIntervalMs: number;
  private readonly now: () => number;

  private pausedAt: number | null = null;
  private reason: CircuitTripReason | null = null;
  private nextResumeCheckAt = 0;
  private resumeAttempts = 0;

  constructor(options: WorkerCircuitBreakerOptions = {}) {
    this.resumeCheckIntervalMs =
      options.resumeCheckIntervalMs ?? DEFAULT_RESUME_CHECK_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  get isPaused(): boolean {
    return this.pausedAt !== null;
  }

  get pauseReason(): CircuitTripReason | null {
    return this.reason;
  }

  get pausedSince(): number | null {
    return this.pausedAt;
  }

  get resumeCheckCount(): number {
    return this.resumeAttempts;
  }

  /**
   * Pause the worker. Returns false when already paused (the first trip
   * wins — the original reason is the one that matters).
   */
  async trip(
    worker: PausableWorker,
    reason: CircuitTripReason
  ): Promise<boolean> {
    if (this.pausedAt !== null) return false;
    const now = this.now();
    this.pausedAt = now;
    this.reason = reason;
    this.resumeAttempts = 0;
    this.nextResumeCheckAt = now + this.resumeCheckIntervalMs;
    await worker.pause();
    console.error(
      `[DM Worker] Circuit breaker tripped (${reason}): worker paused; ` +
        `re-checking Redis in ${Math.round(this.resumeCheckIntervalMs / 1000)}s` +
        (reason === "redis-auth"
          ? " (auth failures need a credential fix — the worker will not resume on its own until Redis accepts the password)"
          : "")
    );
    return true;
  }

  /**
   * If paused and the check interval has elapsed, ping Redis: resume on
   * success, stay paused on failure. Cheap no-op when not paused or when
   * the interval has not elapsed yet, so the entrypoint can call it every
   * minute.
   */
  async maybeResume(
    worker: PausableWorker,
    ping: () => Promise<boolean>
  ): Promise<ResumeCheckResult> {
    if (this.pausedAt === null) return "not-paused";
    const now = this.now();
    if (now < this.nextResumeCheckAt) return "still-paused";

    this.resumeAttempts += 1;
    let ok = false;
    try {
      ok = await ping();
    } catch {
      ok = false;
    }
    if (!ok) {
      this.nextResumeCheckAt = now + this.resumeCheckIntervalMs;
      console.error(
        `[DM Worker] Circuit breaker still open (${this.reason}): ` +
          `Redis check failed (attempt ${this.resumeAttempts}); re-checking in ` +
          `${Math.round(this.resumeCheckIntervalMs / 1000)}s`
      );
      return "still-paused";
    }

    const pausedMs = now - this.pausedAt;
    await worker.resume();
    console.log(
      `[DM Worker] Circuit breaker closed (${this.reason}): Redis recovered ` +
        `after ${Math.round(pausedMs / 1000)}s paused; worker resumed`
    );
    this.pausedAt = null;
    this.reason = null;
    this.resumeAttempts = 0;
    return "resumed";
  }
}
