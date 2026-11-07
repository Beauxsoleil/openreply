/**
 * Pure calendar helpers for the publishing studio. No React, no fetch —
 * unit-testable in node (see __tests__/publishing-calendar.test.ts).
 */
import { utcToWallParts } from "./timezone";
import type { ScheduledPost } from "./api-client";

export interface CalendarDay {
  /** YYYY-MM-DD key in local (viewer) time. */
  key: string;
  date: Date;
  day: number;
  inMonth: boolean;
}

export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Month grid: weeks starting Sunday, padded with the neighbouring month's
 * days so every week has 7 cells. `month` is 0-indexed (0 = January).
 * A month whose 1st falls late in the week with 31 days spans 6 weeks
 * (e.g. August 2026); February in a leap year has 29 days (Feb 2028).
 */
export function buildMonthGrid(year: number, month: number): CalendarDay[][] {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay(); // 0 = Sunday
  const start = new Date(year, month, 1 - startOffset);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < totalCells; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const day: CalendarDay = {
      key: dayKey(date),
      date,
      day: date.getDate(),
      inMonth: date.getMonth() === month,
    };
    const weekIndex = Math.floor(i / 7);
    if (!weeks[weekIndex]) weeks[weekIndex] = [];
    weeks[weekIndex].push(day);
  }
  return weeks;
}

/** The 7 days of the week containing `anchor`, starting Sunday. */
export function buildWeekDays(anchor: Date): CalendarDay[] {
  const sunday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i);
    return { key: dayKey(date), date, day: date.getDate(), inMonth: true };
  });
}

/**
 * Group posts by the wall date of their scheduled time in each post's own
 * timezone. Unscheduled drafts (no scheduledAt) are skipped — they have no
 * day to sit on and show in the list view instead.
 */
export function groupPostsByDay<T extends { scheduledAt: string | null; timezone: string }>(
  posts: T[]
): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const post of posts) {
    if (!post.scheduledAt) continue;
    const { date } = utcToWallParts(new Date(post.scheduledAt), post.timezone);
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(post);
  }
  return grouped;
}

/** Sort posts chronologically by scheduled time; unscheduled drafts last. */
export function sortPostsChronological<T extends ScheduledPost>(posts: T[]): T[] {
  return [...posts].sort((a, b) => {
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  });
}

export interface StatusMeta {
  label: string;
  className: string;
}

/**
 * Status -> label + Tailwind classes, using the Obsidian & Ember tokens
 * (text-accent / text-success / text-error / text-warning / text-muted).
 */
export function statusMeta(status: string): StatusMeta {
  switch (status) {
    case "DRAFT":
      return { label: "Draft", className: "bg-zinc-500/10 text-muted" };
    case "SCHEDULED":
      return { label: "Scheduled", className: "bg-accent/10 text-accent" };
    case "PREPARING":
      return { label: "Preparing", className: "bg-warning/10 text-warning" };
    case "PUBLISHING":
      return { label: "Publishing", className: "bg-warning/10 text-warning" };
    case "PUBLISHED":
      return { label: "Published", className: "bg-success/10 text-success" };
    case "FAILED":
      return { label: "Failed", className: "bg-error/10 text-error" };
    case "RECONCILE_REQUIRED":
      return { label: "Needs review", className: "bg-error/10 text-error" };
    case "CANCELED":
      return { label: "Canceled", className: "bg-zinc-500/10 text-muted" };
    default:
      return { label: status, className: "bg-zinc-500/10 text-muted" };
  }
}

/** "Nov 2026" style month label for a 0-indexed month. */
export function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(
    new Date(year, month, 1)
  );
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}
