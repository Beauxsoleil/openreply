import { describe, expect, it } from "vitest";
import { publishingInput, validateSchedule } from "../lib/publishing/validation";

const base = { instagramAccountId: "account", mediaAssetId: "asset", kind: "IMAGE" as const, caption: "Hello", timezone: "America/Boise" };
describe("publishing validation", () => {
  it("accepts an unscheduled draft", () => {
    const input = publishingInput.parse(base);
    expect(validateSchedule(input)).toBeNull();
  });
  it("rejects an invalid timezone", () => {
    expect(validateSchedule(publishingInput.parse({ ...base, timezone: "Mars/Olympus" }))).toMatch(/timezone/);
  });
  it("rejects a past publish time", () => {
    expect(validateSchedule(publishingInput.parse({ ...base, scheduledAt: "2020-01-01T10:00:00Z" }), new Date("2026-11-07T00:00:00Z"))).toMatch(/future/);
  });
  it("rejects an overly long caption", () => {
    expect(publishingInput.safeParse({ ...base, caption: "x".repeat(2201) }).success).toBe(false);
  });
});
