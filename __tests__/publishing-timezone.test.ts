import { describe, expect, it } from "vitest";
import {
  COMMON_TIMEZONES,
  formatInTimezone,
  isValidIanaTimezone,
  utcToWallParts,
  wallTimeToUtc,
} from "../lib/publishing/timezone";

describe("publishing timezone helpers", () => {
  it("accepts real zones and rejects bad ones", () => {
    expect(isValidIanaTimezone("America/Boise")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
    expect(isValidIanaTimezone("Mars/Olympus")).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
  });

  it("converts a winter wall time in Boise (MST, UTC-7)", () => {
    const utc = wallTimeToUtc("2026-11-08", "10:00", "America/Boise");
    expect(utc.toISOString()).toBe("2026-11-08T17:00:00.000Z");
  });

  it("converts a summer wall time in Boise (MDT, UTC-6)", () => {
    const utc = wallTimeToUtc("2026-07-08", "10:00", "America/Boise");
    expect(utc.toISOString()).toBe("2026-07-08T16:00:00.000Z");
  });

  it("preserves wall time across the spring-forward transition", () => {
    // Mar 7 is MST, Mar 9 is MDT; the same 10:00 wall time shifts by an hour in UTC.
    expect(wallTimeToUtc("2026-03-07", "10:00", "America/Boise").toISOString()).toBe(
      "2026-03-07T17:00:00.000Z"
    );
    expect(wallTimeToUtc("2026-03-09", "10:00", "America/Boise").toISOString()).toBe(
      "2026-03-09T16:00:00.000Z"
    );
  });

  it("resolves a wall time inside the spring-forward gap forward past the gap", () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 in America/Boise. 02:30 never happens.
    const utc = wallTimeToUtc("2026-03-08", "02:30", "America/Boise");
    expect(utc.toISOString()).toBe("2026-03-08T09:30:00.000Z"); // 03:30 MDT
  });

  it("resolves an ambiguous fall-back wall time to the earlier occurrence", () => {
    // 2026-11-01: clocks fall back 02:00 -> 01:00 in America/Boise. 01:30 happens twice.
    const utc = wallTimeToUtc("2026-11-01", "01:30", "America/Boise");
    expect(utc.toISOString()).toBe("2026-11-01T07:30:00.000Z"); // 01:30 MDT (first)
  });

  it("round-trips UTC to wall parts", () => {
    expect(utcToWallParts(new Date("2026-11-08T17:00:00.000Z"), "America/Boise")).toEqual({
      date: "2026-11-08",
      time: "10:00",
    });
  });

  it("formats in the requested zone", () => {
    expect(formatInTimezone(new Date("2026-11-08T17:00:00.000Z"), "America/Boise")).toContain("10:00");
  });

  it("rejects malformed input", () => {
    expect(() => wallTimeToUtc("2026-11-8", "10:00", "America/Boise")).toThrow(/YYYY-MM-DD/);
    expect(() => wallTimeToUtc("2026-11-08", "10:00", "Mars/Olympus")).toThrow(/timezone/);
    expect(() => wallTimeToUtc("2026-13-08", "10:00", "America/Boise")).toThrow();
  });

  it("lists Boise first and only valid zones", () => {
    expect(COMMON_TIMEZONES[0]?.value).toBe("America/Boise");
    for (const zone of COMMON_TIMEZONES) {
      expect(isValidIanaTimezone(zone.value)).toBe(true);
    }
  });
});
