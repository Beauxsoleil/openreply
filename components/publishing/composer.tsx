"use client";

/**
 * Composer: pick media from the library (or upload new), write a caption,
 * choose account + wall date/time + timezone, optionally attach a DM
 * automation to activate after publishing, then save as draft or schedule.
 * All date/time entry is local wall time; wallTimeToUtc converts to UTC
 * before the POST.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPost,
  listMedia,
  toPlainError,
  uploadMediaFile,
  type CampaignOption,
  type InstagramAccountOption,
  type MediaAsset,
  type PostKind,
} from "@/lib/publishing/api-client";
import { COMMON_TIMEZONES, wallTimeToUtc } from "@/lib/publishing/timezone";
import {
  buttonPrimaryClass,
  buttonSecondaryClass,
  ErrorBox,
  fieldClass,
  NoticeBox,
} from "./shared";

interface ComposerProps {
  accounts: InstagramAccountOption[];
  campaigns: CampaignOption[];
  onCreated: (post: { id: string; status: string }) => void;
  onViewCalendar: () => void;
}

const CAPTION_MAX = 2200;

function todayKey(): string {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

export default function Composer({ accounts, campaigns, onCreated, onViewCalendar }: ComposerProps) {
  const [kind, setKind] = useState<PostKind>("IMAGE");
  const [library, setLibrary] = useState<MediaAsset[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<MediaAsset | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [caption, setCaption] = useState("");
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState(todayKey());
  const [time, setTime] = useState("10:00");
  const [timezone, setTimezone] = useState("America/Boise");
  const [automationId, setAutomationId] = useState("");
  const [activateOnPublish, setActivateOnPublish] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fetchLibrary = useCallback(async () => {
    setLibraryLoading(true);
    setLibraryError("");
    try {
      setLibrary(await listMedia(kind));
    } catch (e) {
      setLibraryError(toPlainError(e));
    } finally {
      setLibraryLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchLibrary();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchLibrary]);

  // Default to the first connected account until the user picks one.
  // Derived during render, not synced in an effect.
  const effectiveAccountId = accountId || accounts[0]?.id || "";
  const selectedAccount = accounts.find((a) => a.id === effectiveAccountId);
  const selectedCampaign = campaigns.find((c) => c.id === automationId);
  const isVideoAsset =
    selectedAsset?.mimeType.startsWith("video/") ?? kind === "REEL";

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setUploadError("");
    const wantVideo = kind === "REEL";
    if (wantVideo && !file.type.startsWith("video/")) {
      setUploadError("Pick a video file for a Reel.");
      return;
    }
    if (!wantVideo && !file.type.startsWith("image/")) {
      setUploadError("Pick an image file for an image post.");
      return;
    }
    setUploadProgress(0);
    try {
      const asset = await uploadMediaFile(file, kind, (f) => setUploadProgress(f));
      setSelectedAsset(asset);
      setLibrary((prev) => [asset, ...prev]);
      setUploadProgress(null);
    } catch (e) {
      setUploadError(toPlainError(e));
      setUploadProgress(null);
    }
  }

  function validate(schedule: boolean): string | null {
    if (!effectiveAccountId) return "Pick an Instagram account first.";
    if (!selectedAsset) return "Pick media from the library or upload new media first.";
    if (caption.length > CAPTION_MAX) return `Caption is over the ${CAPTION_MAX}-character limit.`;
    if (schedule) {
      if (!date || !time) return "Pick a date and a time to schedule.";
      try {
        const utc = wallTimeToUtc(date, time, timezone);
        if (utc.getTime() <= Date.now() + 60_000) return "Pick a time at least one minute in the future.";
      } catch {
        return "That date, time, or timezone isn't valid.";
      }
    }
    return null;
  }

  async function handleSubmit(schedule: boolean) {
    setError("");
    setNotice("");
    const problem = validate(schedule);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const scheduledAt = schedule
        ? wallTimeToUtc(date, time, timezone).toISOString()
        : null;
      const result = await createPost({
        instagramAccountId: effectiveAccountId,
        mediaAssetId: selectedAsset!.id,
        kind,
        caption,
        scheduledAt,
        timezone,
        automationId: automationId || null,
        automationActivateOnPublish: automationId ? activateOnPublish : false,
      });
      const scheduledNote =
        schedule && result.status === "DRAFT"
          ? " Saved as a draft for now — automatic scheduling activates once publishing is enabled."
          : "";
      setNotice(
        schedule
          ? `Post scheduled for ${date} at ${time} (${timezone}).${scheduledNote}`
          : "Draft saved."
      );
      onCreated(result);
      setCaption("");
      setSelectedAsset(null);
      setAutomationId("");
      setActivateOnPublish(false);
    } catch (e) {
      setError(toPlainError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-5">
        <section className="panel space-y-3 rounded-xl p-4" aria-label="Post type and media">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Media</h2>
            <div className="inline-flex rounded-lg bg-background p-1" role="group" aria-label="Post type">
              {(["IMAGE", "REEL"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => {
                    setKind(k);
                    setSelectedAsset(null);
                  }}
                  className={`min-h-11 rounded-md px-3 py-1.5 text-sm ${
                    kind === k ? "bg-surface font-medium ring-1 ring-accent/40" : "text-muted hover:text-foreground"
                  }`}
                >
                  {k === "IMAGE" ? "Image" : "Reel"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept={kind === "REEL" ? "video/*" : "image/*"}
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadProgress !== null}
              className={buttonSecondaryClass}
            >
              {uploadProgress !== null ? `Uploading… ${Math.round(uploadProgress * 100)}%` : "Upload new media"}
            </button>
            {uploadProgress !== null && (
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-hover" role="progressbar" aria-valuenow={Math.round(uploadProgress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-accent" style={{ width: `${uploadProgress * 100}%` }} />
              </div>
            )}
            {uploadError && <p role="alert" className="mt-2 text-sm text-error">{uploadError}</p>}
          </div>

          {libraryError && <ErrorBox message={libraryError} onRetry={() => void fetchLibrary()} />}
          {libraryLoading ? (
            <p className="text-sm text-muted">Loading media…</p>
          ) : library.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted">
              No {kind === "REEL" ? "videos" : "images"} in the library yet. Upload one above.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {library.map((asset) => {
                const isVideo = asset.mimeType.startsWith("video/");
                const selected = selectedAsset?.id === asset.id;
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => setSelectedAsset(asset)}
                    aria-pressed={selected}
                    aria-label={`Select ${asset.originalName}`}
                    className={`relative aspect-square overflow-hidden rounded-lg border ${
                      selected ? "border-accent ring-2 ring-accent/60" : "border-border hover:border-border-hover"
                    }`}
                  >
                    {asset.previewUrl ? (
                      isVideo ? (
                        <video src={asset.previewUrl ?? undefined} muted playsInline className="h-full w-full object-cover" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={asset.previewUrl ?? undefined} alt={asset.originalName ?? "Media"} className="h-full w-full object-cover" />
                      )
                    ) : (
                      <span className="flex h-full w-full items-center justify-center bg-surface-hover text-xs text-muted">
                        {isVideo ? "Video" : "Image"}
                      </span>
                    )}
                    {isVideo && (
                      <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">▶</span>
                    )}
                    {selected && (
                      <span className="absolute left-1 top-1 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">Selected</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {selectedAsset && (
            <p className="text-sm text-muted">
              Selected: <span className="text-foreground">{selectedAsset.originalName}</span>
              {selectedAsset.width ? ` · ${selectedAsset.width}×${selectedAsset.height}` : ""}
              {selectedAsset.durationSec ? ` · ${selectedAsset.durationSec}s` : ""}
            </p>
          )}
        </section>

        <section className="panel space-y-3 rounded-xl p-4" aria-label="Caption">
          <div className="flex items-center justify-between">
            <label htmlFor="composer-caption" className="font-semibold">Caption</label>
            <span className={`text-xs ${caption.length > CAPTION_MAX ? "text-error" : "text-muted"}`}>
              {caption.length}/{CAPTION_MAX}
            </span>
          </div>
          <textarea
            id="composer-caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={6}
            maxLength={CAPTION_MAX + 500}
            placeholder="Write your caption…"
            className={fieldClass}
          />
          {caption.length > CAPTION_MAX && (
            <p role="alert" className="text-sm text-error">Instagram captions are limited to {CAPTION_MAX} characters.</p>
          )}
        </section>

        <section className="panel space-y-4 rounded-xl p-4" aria-label="Schedule">
          <h2 className="font-semibold">Account &amp; schedule</h2>
          <div>
            <label htmlFor="composer-account" className="mb-1 block text-xs font-medium text-muted">Instagram account</label>
            <select
              id="composer-account"
              value={effectiveAccountId}
              onChange={(e) => setAccountId(e.target.value)}
              className={fieldClass}
            >
              {accounts.length === 0 && <option value="">No accounts connected</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>@{a.username}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="composer-date" className="mb-1 block text-xs font-medium text-muted">Date</label>
              <input id="composer-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
            </div>
            <div>
              <label htmlFor="composer-time" className="mb-1 block text-xs font-medium text-muted">Time</label>
              <input id="composer-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className={fieldClass} />
            </div>
          </div>
          <div>
            <label htmlFor="composer-timezone" className="mb-1 block text-xs font-medium text-muted">Timezone</label>
            <select id="composer-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} className={fieldClass}>
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </div>
        </section>

        <section className="panel space-y-3 rounded-xl p-4" aria-label="DM automation">
          <h2 className="font-semibold">DM automation <span className="text-sm font-normal text-muted">(optional)</span></h2>
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted">No campaigns yet. Create one on the Campaigns page to attach it here.</p>
          ) : (
            <>
              <div>
                <label htmlFor="composer-automation" className="mb-1 block text-xs font-medium text-muted">Campaign to link</label>
                <select
                  id="composer-automation"
                  value={automationId}
                  onChange={(e) => {
                    setAutomationId(e.target.value);
                    if (!e.target.value) setActivateOnPublish(false);
                  }}
                  className={fieldClass}
                >
                  <option value="">No automation</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} (@{c.instagramAccount.username}){c.isActive ? "" : " — paused"}</option>
                  ))}
                </select>
              </div>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={activateOnPublish}
                  disabled={!automationId}
                  onChange={(e) => setActivateOnPublish(e.target.checked)}
                  className="h-5 w-5 accent-[#C04A38]"
                />
                <span className={!automationId ? "text-muted" : ""}>Activate this campaign after publishing</span>
              </label>
            </>
          )}
        </section>

        {error && <ErrorBox message={error} />}
        {notice && <NoticeBox message={notice} />}

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void handleSubmit(false)} disabled={saving} className={buttonSecondaryClass}>
            {saving ? "Saving…" : "Save draft"}
          </button>
          <button type="button" onClick={() => void handleSubmit(true)} disabled={saving} className={buttonPrimaryClass}>
            {saving ? "Scheduling…" : "Schedule post"}
          </button>
          {notice && (
            <button type="button" onClick={onViewCalendar} className={buttonSecondaryClass}>
              View in calendar
            </button>
          )}
        </div>
      </div>

      {/* Live preview — phone-frame mock. */}
      <aside className="panel h-fit rounded-xl p-4 lg:sticky lg:top-4" aria-label="Preview">
        <h2 className="mb-3 font-semibold">Preview</h2>
        <div className="mx-auto w-full max-w-72 overflow-hidden rounded-2xl border border-border bg-background">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-bold text-white">
              {(selectedAccount?.username ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="truncate text-sm font-medium">@{selectedAccount?.username ?? "account"}</span>
          </div>
          <div className="flex aspect-square items-center justify-center bg-surface">
            {selectedAsset?.previewUrl ? (
              isVideoAsset ? (
                <video src={selectedAsset.previewUrl ?? undefined} muted playsInline controls className="h-full w-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={selectedAsset.previewUrl ?? undefined} alt={selectedAsset.originalName ?? "Media"} className="h-full w-full object-cover" />
              )
            ) : (
              <p className="px-4 text-center text-sm text-muted">Pick media to see it here</p>
            )}
          </div>
          <div className="px-3 py-3">
            <p className="whitespace-pre-wrap break-words text-sm">
              <span className="font-semibold">@{selectedAccount?.username ?? "account"}</span>{" "}
              {caption || <span className="text-muted">Your caption will appear here.</span>}
            </p>
            {selectedCampaign && (
              <p className="mt-2 text-xs text-muted">
                Linked campaign: {selectedCampaign.name}
                {activateOnPublish ? " (activates after publishing)" : ""}
              </p>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
