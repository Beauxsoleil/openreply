"use client";

/**
 * Shared bits for the publishing studio: status pill, form/button classes,
 * and inline feedback boxes. Keeps the four views visually consistent with
 * the Obsidian & Ember tokens in app/globals.css.
 */
import { statusMeta } from "@/lib/publishing/calendar";
import { formatInTimezone } from "@/lib/publishing/timezone";

export const fieldClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";

export const buttonPrimaryClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50";

export const buttonSecondaryClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50";

export const buttonDangerClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-error/40 px-4 py-2 text-sm font-medium text-error hover:bg-error/10 disabled:opacity-50";

export function StatusPill({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-error/20 bg-error/10 p-3 text-sm text-error">
      {message}
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-2 underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function NoticeBox({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="rounded-lg border border-success/20 bg-success/10 p-3 text-sm text-success">
      {message}
    </p>
  );
}

/** "Nov 8, 2026 · 10:00 AM" in the post's own timezone. */
export function formatPostTime(scheduledAt: string | null, timezone: string): string {
  if (!scheduledAt) return "Unscheduled draft";
  try {
    return formatInTimezone(new Date(scheduledAt), timezone);
  } catch {
    return new Date(scheduledAt).toLocaleString();
  }
}
