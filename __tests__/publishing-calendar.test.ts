import { describe, expect, it } from "vitest";
import type { ScheduledPost } from "../lib/publishing/api-client";
import {
  addMonths,
  buildMonthGrid,
  buildWeekDays,
  groupPostsByDay,
  monthLabel,
  sortPostsChronological,
  statusMeta,
} from "../lib/publishing/calendar";

describe("buildMonthGrid", () => {
  it("covers leap February 2028 with 29 in-month days", () => {
    const weeks = buildMonthGrid(2028, 1); // February 2028
    const cells = weeks.flat();
    expect(cells.filter((d) => d.inMonth)).toHaveLength(29);
    // Feb 1 2028 is a Tuesday, so the grid starts on Sun Jan 30 2028.
    expect(weeks[0][0].key).toBe("2028-01-30");
    expect(weeks[0][2].key).toBe("2028-02-01");
    expect(weeks[0][2].inMonth).toBe(true);
    expect(cells[cells.length - 1].key).toBe("2028-03-04");
    expect(weeks).toHaveLength(5);
    for (const week of weeks) expect(week).toHaveLength(7);
  });

  it("spans 6 weeks for August 2026 (1st is a Saturday, 31 days)", () => {
    const weeks = buildMonthGrid(2026, 7);
    expect(weeks).toHaveLength(6);
    const cells = weeks.flat();
    expect(cells).toHaveLength(42);
    expect(cells.filter((d) => d.inMonth)).toHaveLength(31);
    expect(weeks[0][0].key).toBe("2026-07-26");
    expect(weeks[0][6].key).toBe("2026-08-01");
    expect(weeks[5][1].key).toBe("2026-08-31");
    expect(weeks[5][6].key).toBe("2026-09-05");
  });

  it("starts every week on Sunday and keeps consecutive days", () => {
    const weeks = buildMonthGrid(2026, 10); // November 2026
    for (const week of weeks) {
      expect(week).toHaveLength(7);
      expect(week[0].date.getDay()).toBe(0);
    }
    const keys = weeks.flat().map((d) => d.key);
    for (let i = 1; i < keys.length; i++) {
      const prev = new Date(`${keys[i - 1]}T12:00:00`);
      const cur = new Date(`${keys[i]}T12:00:00`);
      expect(cur.getTime() - prev.getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });
});

describe("buildWeekDays", () => {
  it("returns the 7 days of the anchor's week starting Sunday", () => {
    // Wed Nov 4 2026 -> week Sun Nov 1 .. Sat Nov 7.
    const days = buildWeekDays(new Date(2026, 10, 4));
    expect(days).toHaveLength(7);
    expect(days[0].key).toBe("2026-11-01");
    expect(days[6].key).toBe("2026-11-07");
    expect(days[0].date.getDay()).toBe(0);
  });
});

describe("groupPostsByDay", () => {
  it("groups by wall date in each post's own timezone", () => {
    // 2026-11-08T02:00:00Z is Nov 7 at 19:00 in Boise (MST) but Nov 8 in UTC.
    const grouped = groupPostsByDay([
      { scheduledAt: "2026-11-08T02:00:00.000Z", timezone: "America/Boise" },
      { scheduledAt: "2026-11-08T02:00:00.000Z", timezone: "UTC" },
      { scheduledAt: "2026-11-08T17:00:00.000Z", timezone: "America/Boise" },
    ]);
    expect(Object.keys(grouped).sort()).toEqual(["2026-11-07", "2026-11-08"]);
    expect(grouped["2026-11-07"]).toHaveLength(1);
    expect(grouped["2026-11-08"]).toHaveLength(2);
  });

  it("skips unscheduled drafts", () => {
    const grouped = groupPostsByDay([
      { scheduledAt: null, timezone: "America/Boise" },
    ]);
    expect(grouped).toEqual({});
  });
});

describe("sortPostsChronological", () => {
  it("orders by scheduled time with unscheduled drafts last", () => {
    const make = (id: string, scheduledAt: string | null): ScheduledPost => ({
      id,
      scheduledAt,
      caption: "",
      kind: "IMAGE",
      status: "DRAFT",
      timezone: "UTC",
      publishedAt: null,
      instagramMediaId: null,
      lastError: null,
      attemptCount: 0,
      automationId: null,
      automationActivateOnPublish: false,
      mediaAsset: { id: "m", mimeType: "image/jpeg" },
      instagramAccount: { id: "a", username: "brand" },
    });
    const sorted = sortPostsChronological([
      make("c", null),
      make("b", "2026-11-09T10:00:00.000Z"),
      make("a", "2026-11-08T10:00:00.000Z"),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("statusMeta", () => {
  it("labels every status and color-codes by outcome", () => {
    expect(statusMeta("DRAFT")).toMatchObject({ label: "Draft" });
    expect(statusMeta("SCHEDULED").label).toBe("Scheduled");
    expect(statusMeta("SCHEDULED").className).toContain("text-accent");
    expect(statusMeta("PREPARING").className).toContain("text-warning");
    expect(statusMeta("PUBLISHING").className).toContain("text-warning");
    expect(statusMeta("PUBLISHED").label).toBe("Published");
    expect(statusMeta("PUBLISHED").className).toContain("text-success");
    expect(statusMeta("FAILED").className).toContain("text-error");
    expect(statusMeta("RECONCILE_REQUIRED").label).toBe("Needs review");
    expect(statusMeta("RECONCILE_REQUIRED").className).toContain("text-error");
    expect(statusMeta("CANCELED").className).toContain("text-muted");
  });

  it("falls back to the raw status for unknown values", () => {
    expect(statusMeta("MYSTERY")).toEqual({
      label: "MYSTERY",
      className: "bg-zinc-500/10 text-muted",
    });
  });
});

describe("monthLabel / addMonths", () => {
  it("labels months and rolls over year boundaries", () => {
    expect(monthLabel(2026, 10)).toBe("November 2026");
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});
