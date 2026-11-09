"use client";

/**
 * Calendar view: month grid, week strip, and chronological list.
 * Posts sit on their scheduled day (wall date in each post's own timezone);
 * unscheduled drafts get their own strip since they have no day.
 */
import { useMemo, useState } from "react";
import type { ScheduledPost } from "@/lib/publishing/api-client";
import {
  addMonths,
  buildMonthGrid,
  buildWeekDays,
  dayKey,
  groupPostsByDay,
  monthLabel,
  sortPostsChronological,
} from "@/lib/publishing/calendar";
import { buttonSecondaryClass, formatPostTime, StatusPill } from "./shared";

type CalendarMode = "month" | "week" | "list";

interface CalendarViewProps {
  posts: ScheduledPost[];
  onSelect: (post: ScheduledPost) => void;
}

function PostChip({ post, onSelect }: { post: ScheduledPost; onSelect: (p: ScheduledPost) => void }) {
  const time = post.scheduledAt
    ? new Date(post.scheduledAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: post.timezone,
      })
    : "Draft";
  return (
    <button
      type="button"
      onClick={() => onSelect(post)}
      className="block w-full truncate rounded-md bg-surface-hover px-2 py-1.5 text-left text-xs hover:ring-1 hover:ring-accent/40"
      title={post.caption || `${post.kind} post`}
    >
      <span className="font-medium">{time}</span>{" "}
      <span className="text-muted">{post.caption ? post.caption.slice(0, 40) : post.kind}</span>
    </button>
  );
}

function DayCell({
  day,
  posts,
  todayKey,
  onSelect,
}: {
  day: { key: string; day: number; inMonth: boolean };
  posts: ScheduledPost[];
  todayKey: string;
  onSelect: (p: ScheduledPost) => void;
}) {
  return (
    <div
      className={`min-h-24 rounded-lg border p-1.5 ${
        day.inMonth ? "border-border bg-surface" : "border-border/50 bg-background opacity-50"
      } ${day.key === todayKey ? "ring-1 ring-accent/60" : ""}`}
    >
      <p className={`text-xs font-medium ${day.key === todayKey ? "text-accent" : "text-muted"}`}>{day.day}</p>
      <div className="mt-1 space-y-1">
        {posts.slice(0, 3).map((post) => (
          <PostChip key={post.id} post={post} onSelect={onSelect} />
        ))}
        {posts.length > 3 && <p className="px-1 text-xs text-muted">+{posts.length - 3} more</p>}
      </div>
    </div>
  );
}

export default function CalendarView({ posts, onSelect }: CalendarViewProps) {
  const now = new Date();
  const [mode, setMode] = useState<CalendarMode>("month");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [weekAnchor, setWeekAnchor] = useState(now);
  const todayKey = dayKey(now);

  const grouped = useMemo(() => groupPostsByDay(posts), [posts]);
  const unscheduled = useMemo(() => posts.filter((p) => !p.scheduledAt), [posts]);
  const sorted = useMemo(() => sortPostsChronological(posts), [posts]);
  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const weekDays = useMemo(() => buildWeekDays(weekAnchor), [weekAnchor]);

  function shiftMonth(delta: number) {
    const next = addMonths(year, month, delta);
    setYear(next.year);
    setMonth(next.month);
  }

  function shiftWeek(delta: number) {
    setWeekAnchor((cur) => new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + delta * 7));
  }

  function goToday() {
    const today = new Date();
    setYear(today.getFullYear());
    setMonth(today.getMonth());
    setWeekAnchor(today);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-surface p-1" role="tablist" aria-label="Calendar layout">
          {(["month", "week", "list"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`min-h-11 rounded-md px-3 py-1.5 text-sm capitalize ${
                mode === m ? "bg-background font-medium text-foreground ring-1 ring-accent/40" : "text-muted hover:text-foreground"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        {mode !== "list" && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => (mode === "month" ? shiftMonth(-1) : shiftWeek(-1))} aria-label="Previous" className={`${buttonSecondaryClass} px-3`}>
              ←
            </button>
            <span className="min-w-32 text-center text-sm font-medium">
              {mode === "month" ? monthLabel(year, month) : `${weekDays[0].date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${weekDays[6].date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
            </span>
            <button type="button" onClick={() => (mode === "month" ? shiftMonth(1) : shiftWeek(1))} aria-label="Next" className={`${buttonSecondaryClass} px-3`}>
              →
            </button>
            <button type="button" onClick={goToday} className={buttonSecondaryClass}>
              Today
            </button>
          </div>
        )}
      </div>

      {unscheduled.length > 0 && (
        <div className="panel rounded-xl p-4">
          <h3 className="mb-2 text-sm font-semibold">Unscheduled drafts ({unscheduled.length})</h3>
          <div className="flex flex-wrap gap-2">
            {unscheduled.map((post) => (
              <button
                key={post.id}
                type="button"
                onClick={() => onSelect(post)}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm hover:border-border-hover"
              >
                <span className="font-medium">{post.kind === "REEL" ? "Reel" : post.kind === "IMAGE" ? "Image" : post.kind === "SHORT" ? "Short" : "Video"}</span>{" "}
                <span className="text-muted">{post.platform === "YOUTUBE" ? post.youtubeChannel?.title : `@${post.instagramAccount?.username}`}</span>
                {post.caption && <span className="block max-w-56 truncate text-muted">{post.caption}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === "month" && (
        <div>
          <div className="mb-1 grid grid-cols-7 gap-1.5 text-center text-xs font-medium text-muted">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="py-1">{d}</div>
            ))}
          </div>
          <div className="space-y-1.5">
            {weeks.map((week) => (
              <div key={week[0].key} className="grid grid-cols-7 gap-1.5">
                {week.map((day) => (
                  <DayCell key={day.key} day={day} posts={grouped[day.key] ?? []} todayKey={todayKey} onSelect={onSelect} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === "week" && (
        <div className="grid gap-1.5 sm:grid-cols-7">
          {weekDays.map((day) => (
            <DayCell key={day.key} day={day} posts={grouped[day.key] ?? []} todayKey={todayKey} onSelect={onSelect} />
          ))}
        </div>
      )}

      {mode === "list" && (
        <div className="space-y-2">
          {sorted.length === 0 && <p className="panel rounded-xl p-8 text-center text-sm text-muted">No posts yet.</p>}
          {sorted.map((post) => (
            <button
              key={post.id}
              type="button"
              onClick={() => onSelect(post)}
              className="panel flex w-full flex-wrap items-center gap-3 rounded-xl p-4 text-left hover:border-border-hover"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{post.caption || `${post.kind} post`}</p>
                <p className="text-xs text-muted">
                  {post.platform === "YOUTUBE" ? post.youtubeChannel?.title : `@${post.instagramAccount?.username}`} · {post.kind === "REEL" ? "Reel" : post.kind === "IMAGE" ? "Image" : post.kind === "SHORT" ? "Short" : "Video"} · {formatPostTime(post.scheduledAt, post.timezone)}
                </p>
              </div>
              <StatusPill status={post.status} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
