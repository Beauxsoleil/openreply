/**
 * Redis failure classification for the DM worker.
 *
 * Pure functions — no I/O — so the worker can decide fail-fast / pause
 * behaviour from any thrown error without knowing which Redis client raised
 * it. The patterns come from the November 2026 incident, in which Upstash
 * answered every request with "ERR max requests limit exceeded" while a
 * second connection failed with "WRONGPASS invalid username-password pair",
 * and each failure wrote another OperationalEvent row until Neon ran out of
 * storage (~2.3M rows / 816 MB in six days).
 */

export type RedisFailureKind = "auth" | "quota" | "connection" | "other";

/**
 * Substrings that identify a Redis authentication failure. Case-insensitive.
 * Shared with the OperationalEvent retention prune
 * (lib/ops/prune-operational-events.ts) so the rows this classifier flags
 * are the same rows the prune job selects.
 */
export const REDIS_AUTH_MESSAGE_PATTERNS = [
  "WRONGPASS",
  "NOAUTH",
  "invalid username-password",
  "Authentication required",
  "ERR invalid password",
] as const;

/**
 * Substrings that identify an Upstash request-quota failure.
 * Case-insensitive. Upstash's message is
 * "ERR max requests limit exceeded (limit 500,000, usage 500,005)".
 */
export const REDIS_QUOTA_MESSAGE_PATTERNS = [
  "max requests limit exceeded",
  "request limit exceeded",
] as const;

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNRESET",
  "EPIPE",
]);

const CONNECTION_MESSAGE_PATTERNS = [
  "connect econnrefused",
  "connection is closed",
  "connection lost",
  "socket closed",
  "connect timed out",
] as const;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function matchesAny(message: string, patterns: readonly string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/** True when Redis rejected the credentials (WRONGPASS, NOAUTH, ...). */
export function isRedisAuthError(error: unknown): boolean {
  return matchesAny(messageOf(error), REDIS_AUTH_MESSAGE_PATTERNS);
}

/** True when the Redis provider's request quota is exhausted (Upstash). */
export function isRedisQuotaError(error: unknown): boolean {
  return matchesAny(messageOf(error), REDIS_QUOTA_MESSAGE_PATTERNS);
}

/** True when the error is a lost or refused TCP connection to Redis. */
export function isRedisConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) {
    return true;
  }
  return matchesAny(messageOf(error), CONNECTION_MESSAGE_PATTERNS);
}

/**
 * Classify a thrown error by Redis failure kind. Auth is checked first: a
 * WRONGPASS error must never be mistaken for a transient outage, because
 * retrying it can only fail the same way.
 */
export function classifyRedisError(error: unknown): RedisFailureKind {
  if (isRedisAuthError(error)) return "auth";
  if (isRedisQuotaError(error)) return "quota";
  if (isRedisConnectionError(error)) return "connection";
  return "other";
}

/**
 * True when a stored OperationalEvent message describes a Redis auth or
 * quota failure. Used by the retention prune to select exactly the
 * repetitive rows the November 2026 flood produced.
 */
export function matchesRedisFailureMessage(message: string): boolean {
  return (
    matchesAny(message, REDIS_AUTH_MESSAGE_PATTERNS) ||
    matchesAny(message, REDIS_QUOTA_MESSAGE_PATTERNS)
  );
}

/**
 * Capped exponential backoff for ioredis `retryStrategy`: 100 ms, 200 ms,
 * 400 ms, ... up to `maxDelayMs`. Without a cap, a dead Redis (e.g. an
 * exhausted Upstash quota) is re-dialled every couple of seconds forever,
 * and each reconnect attempt costs quota on AUTH. The cap keeps reconnects
 * cheap while still recovering on its own after a transient outage.
 *
 * Never returns null: returning null would stop ioredis reconnecting
 * entirely, which BullMQ connections must not do.
 */
export function redisRetryDelayMs(times: number, maxDelayMs = 30_000): number {
  const attempt = Math.max(1, Math.floor(times));
  return Math.min(100 * 2 ** (attempt - 1), maxDelayMs);
}
