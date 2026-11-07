"use client";

/**
 * Post detail panel: a slide-over opened from the calendar or history.
 * Reschedule (wall date + time + timezone), cancel, retry (FAILED only),
 * delete (DRAFT/CANCELED/FAILED only), publish attempts, and — for
 * published posts — a link to the account profile. Instagram returns no
 * permalink in the publishing contract, so there is no /p/<id> link here:
 * the media id is shown as text instead.
 */
import { useCallback, useEffect, useState } from "react";
import {
  deletePost,
  getMedia,
  getPost,
  retryPost,
  toPlainError,
  updatePost,
  type ScheduledPost,
  type ScheduledPostDetail,
} from "@/lib/publishing/api-client";
import { COMMON_TIMEZONES, utcToWallParts, wallTimeToUtc } from "@/lib/publishing/timezone";
import {
  buttonDangerClass,
  buttonPrimaryClass,
  buttonSecondaryClass,
  ErrorBox,
  fieldClass,
  formatPostTime,
  NoticeBox,
  StatusPill,
} from "./shared";

interface PostDetailProps {
  post: ScheduledPost;
  onClose: () => void;
  onChanged: () => void;
}

const CAN_DELETE = ["DRAFT", "CANCELED", "FAILED"];
const CAN_CANCEL = ["DRAFT", "SCHEDULED"];

/** Prefill for the reschedule form: the post's scheduled wall time in its
 * own timezone, or today at 10:00 for an unscheduled draft. */
function initialSchedule(post: ScheduledPost): { date: string; time: string; timezone: string } {
  if (post.scheduledAt) {
    try {
      const parts = utcToWallParts(new Date(post.scheduledAt), post.timezone);
      return { date: parts.date, time: parts.time, timezone: post.timezone };
    } catch {
      // Fall through to the default below.
    }
  }
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return {
    date: `${today.getFullYear()}-${month}-${day}`,
    time: "10:00",
    timezone: post.timezone || "America/Boise",
  };
}

export default function PostDetail({ post, onClose, onChanged }: PostDetailProps) {
  const [detail, setDetail] = useState<ScheduledPostDetail | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // The panel remounts per post (key={post.id} in the parent), so the
  // reschedule form can take its initial values from the post directly.
  const [date, setDate] = useState(() => initialSchedule(post).date);
  const [time, setTime] = useState(() => initialSchedule(post).time);
  const [timezone, setTimezone] = useState(() => initialSchedule(post).timezone);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadDetail = useCallback(async () => {
    try {
      const full = await getPost(post.id);
      setDetail(full);
    } catch {
      // Attempts are nice-to-have; the panel works from the list row alone.
      setDetail(null);
    }
    try {
      const asset = await getMedia(post.mediaAsset.id);
      setPreviewUrl(asset.previewUrl);
    } catch {
      setPreviewUrl(null);
    }
  }, [post.id, post.mediaAsset.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDetail();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail]);

  // Prefill the reschedule form from the post's scheduled time in its own
  // timezone; unscheduled drafts default to today at 10:00.
  // (Initial values come from the useState initializers above.)

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleReschedule() {
    setError("");
    setNotice("");
    if (!date || !time) {
      setError("Pick a date and a time first.");
      return;
    }
    let scheduledAt: string;
    try {
      scheduledAt = wallTimeToUtc(date, time, timezone).toISOString();
    } catch {
      setError("That date, time, or timezone isn't valid.");
      return;
    }
    if (new Date(scheduledAt).getTime() <= Date.now() + 60_000) {
      setError("Pick a time at least one minute in the future.");
      return;
    }
    setSaving(true);
    try {
      await updatePost(post.id, { scheduledAt, timezone });
      setNotice("New time saved.");
      onChanged();
    } catch (e) {
      setError(toPlainError(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel() {
    if (!confirm("Cancel this post? It won't publish.")) return;
    setError("");
    setNotice("");
    setBusyAction("cancel");
    try {
      // NOTE: `status` is not in the published PATCH contract; see
      // lib/publishing/api-client.ts. If the API rejects it, the error
      // below says so and the post is left untouched.
      await updatePost(post.id, { status: "CANCELED" });
      setNotice("Post canceled.");
      onChanged();
    } catch (e) {
      setError(toPlainError(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRetry() {
    setError("");
    setNotice("");
    setBusyAction("retry");
    try {
      await retryPost(post.id);
      setNotice("Retry queued — the post will be attempted again.");
      onChanged();
    } catch (e) {
      setError(toPlainError(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this post? This cannot be undone.")) return;
    setError("");
    setBusyAction("delete");
    try {
      await deletePost(post.id);
      onChanged();
      onClose();
    } catch (e) {
      setError(toPlainError(e));
      setBusyAction(null);
    }
  }

  const isVideo = post.kind === "REEL" || post.mediaAsset.mimeType.startsWith("video/");

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Post details"
    >
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-border bg-background p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              {post.kind === "REEL" ? "Reel" : "Image"} · @{post.instagramAccount.username}
            </p>
            <h2 className="mt-1 text-lg font-semibold">Post details</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="min-h-11 min-w-11 rounded-lg border border-border px-3 text-lg text-muted hover:text-foreground"
          >
            ×
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={post.status} />
            <span className="text-sm text-muted">{formatPostTime(post.scheduledAt, post.timezone)}</span>
            <span className="text-xs text-muted">· {post.timezone}</span>
          </div>

          {previewUrl &&
            (isVideo ? (
              <video src={previewUrl} controls playsInline className="max-h-72 w-full rounded-lg object-cover" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="" className="max-h-72 w-full rounded-lg object-cover" />
            ))}

          <p className="whitespace-pre-wrap text-sm">{post.caption || "No caption"}</p>

          {post.lastError && (
            <div className="rounded-lg border border-error/20 bg-error/10 p-3 text-sm text-error">
              <p className="font-medium">Last error</p>
              <p>{post.lastError}</p>
            </div>
          )}

          {post.status === "PUBLISHED" && (
            <div className="rounded-lg border border-border bg-surface p-3 text-sm">
              <p>
                <a
                  href={`https://www.instagram.com/${post.instagramAccount.username}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  View @{post.instagramAccount.username} on Instagram
                </a>
              </p>
              {post.instagramMediaId && (
                <p className="mt-1 font-mono text-xs text-muted">Media ID: {post.instagramMediaId}</p>
              )}
              {post.publishedAt && (
                <p className="mt-1 text-xs text-muted">
                  Published {formatPostTime(post.publishedAt, post.timezone)}
                </p>
              )}
            </div>
          )}

          {notice && <NoticeBox message={notice} />}
          {error && <ErrorBox message={error} />}

          {CAN_CANCEL.includes(post.status) && (
            <section className="panel space-y-3 rounded-xl p-4" aria-label="Reschedule">
              <h3 className="font-semibold">Reschedule</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="detail-date" className="mb-1 block text-xs font-medium text-muted">Date</label>
                  <input
                    id="detail-date"
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label htmlFor="detail-time" className="mb-1 block text-xs font-medium text-muted">Time</label>
                  <input
                    id="detail-time"
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className={fieldClass}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="detail-timezone" className="mb-1 block text-xs font-medium text-muted">Timezone</label>
                <select
                  id="detail-timezone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className={fieldClass}
                >
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
              </div>
              <button type="button" onClick={() => void handleReschedule()} disabled={saving} className={buttonPrimaryClass}>
                {saving ? "Saving…" : "Save new time"}
              </button>
            </section>
          )}

          {detail?.attempts && detail.attempts.length > 0 && (
            <section className="panel rounded-xl p-4" aria-label="Publish attempts">
              <h3 className="mb-2 font-semibold">Publish attempts ({detail.attempts.length})</h3>
              <ul className="space-y-2 text-sm">
                {detail.attempts.map((attempt) => (
                  <li key={attempt.id} className="flex flex-wrap justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0">
                    <span>{new Date(attempt.startedAt).toLocaleString()}</span>
                    <span className="text-muted">{attempt.outcome}{attempt.errorCode ? ` · ${attempt.errorCode}` : ""}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap gap-2 pb-2">
            {post.status === "FAILED" && (
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={busyAction !== null}
                className={buttonPrimaryClass}
              >
                {busyAction === "retry" ? "Retrying…" : "Retry"}
              </button>
            )}
            {CAN_CANCEL.includes(post.status) && (
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={busyAction !== null}
                className={buttonSecondaryClass}
              >
                {busyAction === "cancel" ? "Canceling…" : "Cancel post"}
              </button>
            )}
            {CAN_DELETE.includes(post.status) && (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busyAction !== null}
                className={buttonDangerClass}
              >
                {busyAction === "delete" ? "Deleting…" : "Delete"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
