import { describe, it, expect } from "vitest";
import {
  classifyRedisError,
  isRedisAuthError,
  isRedisConnectionError,
  isRedisQuotaError,
  matchesRedisFailureMessage,
  redisRetryDelayMs,
} from "@/lib/queue/redis-errors";

describe("isRedisAuthError", () => {
  it("matches the Upstash WRONGPASS message", () => {
    expect(
      isRedisAuthError(
        new Error("WRONGPASS invalid username-password pair or user is disabled.")
      )
    ).toBe(true);
  });

  it("matches NOAUTH", () => {
    expect(isRedisAuthError(new Error("NOAUTH Authentication required."))).toBe(
      true
    );
  });

  it("is case-insensitive", () => {
    expect(isRedisAuthError(new Error("wrongpass: bad password"))).toBe(true);
  });

  it("does not match quota or connection errors", () => {
    expect(
      isRedisAuthError(new Error("ERR max requests limit exceeded"))
    ).toBe(false);
    expect(isRedisAuthError(new Error("connect ECONNREFUSED"))).toBe(false);
  });
});

describe("isRedisQuotaError", () => {
  it("matches the Upstash max-requests message", () => {
    expect(
      isRedisQuotaError(
        new Error(
          "ERR max requests limit exceeded (limit 500,000, usage 500,005)"
        )
      )
    ).toBe(true);
  });

  it("does not match auth errors", () => {
    expect(isRedisQuotaError(new Error("WRONGPASS bad password"))).toBe(false);
  });
});

describe("isRedisConnectionError", () => {
  it("matches ioredis error codes", () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:6379") as Error & {
      code: string;
    };
    error.code = "ECONNREFUSED";
    expect(isRedisConnectionError(error)).toBe(true);
  });

  it("matches closed-connection messages", () => {
    expect(
      isRedisConnectionError(new Error("Connection is closed."))
    ).toBe(true);
  });

  it("does not match auth or quota errors", () => {
    expect(isRedisConnectionError(new Error("WRONGPASS"))).toBe(false);
    expect(
      isRedisConnectionError(new Error("ERR max requests limit exceeded"))
    ).toBe(false);
  });
});

describe("classifyRedisError", () => {
  it("checks auth before quota and connection", () => {
    expect(classifyRedisError(new Error("WRONGPASS"))).toBe("auth");
    expect(
      classifyRedisError(new Error("ERR max requests limit exceeded"))
    ).toBe("quota");
    expect(classifyRedisError(new Error("Connection is closed."))).toBe(
      "connection"
    );
    expect(classifyRedisError(new Error("boom"))).toBe("other");
    expect(classifyRedisError("WRONGPASS")).toBe("auth");
    expect(classifyRedisError(undefined)).toBe("other");
  });
});

describe("matchesRedisFailureMessage", () => {
  it("matches stored flood messages with job prefixes", () => {
    expect(
      matchesRedisFailureMessage(
        "DM worker job cm123 failed: ERR max requests limit exceeded (limit 500,000, usage 500,005)"
      )
    ).toBe(true);
    expect(
      matchesRedisFailureMessage(
        "DM worker job cm123 failed: WRONGPASS invalid username-password pair"
      )
    ).toBe(true);
  });

  it("does not match ordinary failures", () => {
    expect(
      matchesRedisFailureMessage(
        "DM worker job cm123 failed: MetaApiError 1: OAuthException"
      )
    ).toBe(false);
  });
});

describe("redisRetryDelayMs", () => {
  it("backs off exponentially and caps at the max", () => {
    expect(redisRetryDelayMs(1)).toBe(100);
    expect(redisRetryDelayMs(2)).toBe(200);
    expect(redisRetryDelayMs(3)).toBe(400);
    expect(redisRetryDelayMs(100)).toBe(30_000);
    expect(redisRetryDelayMs(100, 10_000)).toBe(10_000);
  });

  it("never returns null or zero", () => {
    expect(redisRetryDelayMs(0)).toBeGreaterThan(0);
    expect(redisRetryDelayMs(-5)).toBeGreaterThan(0);
  });
});
