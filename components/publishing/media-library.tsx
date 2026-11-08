"use client";

/**
 * Media library: grid of thumbnails with kind filter + text search.
 * Delete asks for confirmation; a 409 (asset in use by a scheduled post)
 * is surfaced in plain words via toPlainError.
 */
import { useCallback, useEffect, useState } from "react";
import {
  deleteMedia,
  listMedia,
  toPlainError,
  type MediaAsset,
  type PostKind,
} from "@/lib/publishing/api-client";
import { buttonSecondaryClass, ErrorBox } from "./shared";

type KindFilter = "ALL" | PostKind;

export default function MediaLibrary() {
  const [kind, setKind] = useState<KindFilter>("ALL");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchAssets = useCallback(async (kindFilter: KindFilter, q: string) => {
    setLoading(true);
    setError("");
    try {
      setAssets(await listMedia(kindFilter, q));
    } catch (e) {
      setError(toPlainError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounce the text search so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAssets(kind, debouncedQuery);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [kind, debouncedQuery, fetchAssets]);

  async function handleDelete(asset: MediaAsset) {
    if (!confirm(`Delete "${asset.originalName}"? This cannot be undone.`)) return;
    setActionError("");
    setDeletingId(asset.id);
    try {
      await deleteMedia(asset.id);
      setAssets((prev) => prev.filter((a) => a.id !== asset.id));
    } catch (e) {
      setActionError(toPlainError(e));
    } finally {
      setDeletingId(null);
    }
  }

  function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by file name…"
          aria-label="Search media by file name"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
        />
        <div className="inline-flex shrink-0 rounded-lg bg-surface p-1" role="group" aria-label="Filter by type">
          {(["ALL", "IMAGE", "REEL"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={`min-h-11 rounded-md px-3 py-1.5 text-sm capitalize ${
                kind === k ? "bg-background font-medium text-foreground ring-1 ring-accent/40" : "text-muted hover:text-foreground"
              }`}
            >
              {k === "ALL" ? "All" : k === "IMAGE" ? "Images" : "Reels"}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void fetchAssets(kind, debouncedQuery)} className={buttonSecondaryClass}>
          Refresh
        </button>
      </div>

      {error && <ErrorBox message={error} onRetry={() => void fetchAssets(kind, debouncedQuery)} />}
      {actionError && <ErrorBox message={actionError} />}

      {loading ? (
        <p className="text-muted">Loading media…</p>
      ) : assets.length === 0 ? (
        <div className="panel rounded-xl p-8 text-center text-muted">
          No media found. Upload some from the Composer tab.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((asset) => {
            const isVideo = asset.mimeType.startsWith("video/");
            return (
              <article key={asset.id} className="panel overflow-hidden rounded-xl">
                <div className="relative aspect-square bg-surface-hover">
                  {asset.previewUrl ? (
                    isVideo ? (
                      <video src={asset.previewUrl ?? undefined} muted playsInline className="h-full w-full object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={asset.previewUrl ?? undefined} alt={asset.originalName ?? "Media"} className="h-full w-full object-cover" />
                    )
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-sm text-muted">
                      {isVideo ? "Video" : "Image"}
                    </span>
                  )}
                  <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    {isVideo ? "REEL" : "IMAGE"}
                  </span>
                </div>
                <div className="space-y-1 p-3">
                  <p className="truncate text-sm font-medium" title={asset.originalName ?? undefined}>{asset.originalName}</p>
                  <p className="text-xs text-muted">
                    {formatSize(asset.byteSize)}
                    {asset.width ? ` · ${asset.width}×${asset.height}` : ""}
                    {asset.durationSec ? ` · ${asset.durationSec}s` : ""}
                  </p>
                  <p className="text-xs text-muted">{new Date(asset.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
                  <button
                    type="button"
                    onClick={() => void handleDelete(asset)}
                    disabled={deletingId === asset.id}
                    className="min-h-11 text-sm font-medium text-error hover:underline disabled:opacity-50"
                  >
                    {deletingId === asset.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
