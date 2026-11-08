"use client";

/**
 * History: published posts (account link + published time), posts that need
 * attention (FAILED / RECONCILE_REQUIRED with the error in plain words and
 * a retry button for FAILED only — retrying a reconcile-required post could
 * double-publish, so it stays manual), and canceled posts.
 */
import { useState } from "react";
import {
  retryPost,
  toPlainError,
  type ScheduledPost,
} from "@/lib/publishing/api-client";
import { buttonPrimaryClass, ErrorBox, formatPostTime, StatusPill } from "./shared";

interface HistoryViewProps {
  posts: ScheduledPost[];
  onSelect: (post: ScheduledPost) => void;
  onChanged: () => void;
}

function HistoryRow({
  post,
  onSelect,
  children,
}: {
  post: ScheduledPost;
  onSelect: (post: ScheduledPost) => void;
  children?: React.ReactNode;
}) {
  return (
    <article className="panel space-y-2 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => onSelect(post)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium hover:underline">
            {post.caption || `${post.kind} post`}
          </p>
          <p className="text-xs text-muted">
            @{post.instagramAccount.username} · {post.kind === "REEL" ? "Reel" : "Image"}
          </p>
        </button>
        <StatusPill status={post.status} />
      </div>
      {children}
    </article>
  );
}

export default function HistoryView({ posts, onSelect, onChanged }: HistoryViewProps) {
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const published = posts
    .filter((p) => p.status === "PUBLISHED")
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  const needsAttention = posts.filter((p) => p.status === "FAILED" || p.status === "RECONCILE_REQUIRED");
  const canceled = posts.filter((p) => p.status === "CANCELED");

  async function handleRetry(post: ScheduledPost) {
    setError("");
    setRetryingId(post.id);
    try {
      await retryPost(post.id);
      onChanged();
    } catch (e) {
      setError(toPlainError(e));
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="space-y-8">
      {error && <ErrorBox message={error} />}

      <section aria-label="Published">
        <h2 className="mb-3 font-semibold">Published ({published.length})</h2>
        {published.length === 0 ? (
          <p className="panel rounded-xl p-6 text-center text-sm text-muted">Nothing published yet.</p>
        ) : (
          <div className="space-y-2">
            {published.map((post) => (
              <HistoryRow key={post.id} post={post} onSelect={onSelect}>
                <p className="text-sm text-muted">
                  Published {formatPostTime(post.publishedAt, post.timezone)}
                </p>
                <p className="text-sm">
                  <a
                    href={`https://www.instagram.com/${post.instagramAccount.username}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-accent hover:underline"
                  >
                    View @{post.instagramAccount.username} on Instagram
                  </a>
                  {post.instagramMediaId && (
                    <span className="ml-2 font-mono text-xs text-muted">Media ID: {post.instagramMediaId}</span>
                  )}
                </p>
              </HistoryRow>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Needs attention">
        <h2 className="mb-3 font-semibold">Needs attention ({needsAttention.length})</h2>
        {needsAttention.length === 0 ? (
          <p className="panel rounded-xl p-6 text-center text-sm text-muted">No failed posts. Good news.</p>
        ) : (
          <div className="space-y-2">
            {needsAttention.map((post) => (
              <HistoryRow key={post.id} post={post} onSelect={onSelect}>
                {post.lastError ? (
                  <p className="text-sm text-error">{post.lastError}</p>
                ) : (
                  <p className="text-sm text-muted">
                    {post.status === "RECONCILE_REQUIRED"
                      ? "Instagram's reply didn't confirm whether this published. Check the account before retrying."
                      : "This post failed to publish. No error detail was returned."}
                  </p>
                )}
                {post.status === "FAILED" && (
                  <button
                    type="button"
                    onClick={() => void handleRetry(post)}
                    disabled={retryingId === post.id}
                    className={buttonPrimaryClass}
                  >
                    {retryingId === post.id ? "Retrying…" : "Retry"}
                  </button>
                )}
                {post.status === "RECONCILE_REQUIRED" && (
                  <p className="text-xs text-muted">
                    Check @{post.instagramAccount.username} on Instagram first — the post may already be live.
                  </p>
                )}
              </HistoryRow>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Canceled">
        <h2 className="mb-3 font-semibold">Canceled ({canceled.length})</h2>
        {canceled.length === 0 ? (
          <p className="panel rounded-xl p-6 text-center text-sm text-muted">No canceled posts.</p>
        ) : (
          <div className="space-y-2">
            {canceled.map((post) => (
              <HistoryRow key={post.id} post={post} onSelect={onSelect}>
                <p className="text-sm text-muted">
                  {post.scheduledAt ? `Was scheduled for ${formatPostTime(post.scheduledAt, post.timezone)}` : "Unscheduled draft"}
                </p>
              </HistoryRow>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
