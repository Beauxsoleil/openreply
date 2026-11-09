"use client";

/**
 * Publishing studio (Later-style): calendar, composer, media library, and
 * history tabs. Loads posts, connected accounts, and DM campaigns up front;
 * the detail panel opens from the calendar or history.
 *
 * Accounts come from GET /api/instagram/accounts (the lightweight list
 * endpoint) and campaigns from GET /api/automations (the Campaigns page
 * endpoint). Media and posts go through lib/publishing/api-client.
 */
import { useCallback, useEffect, useState } from "react";
import {
  listCampaigns,
  listInstagramAccounts,
  listYouTubeChannels,
  listPosts,
  toPlainError,
  type CampaignOption,
  type InstagramAccountOption,
  type YouTubeChannelOption,
  type ScheduledPost,
} from "@/lib/publishing/api-client";
import CalendarView from "@/components/publishing/calendar-view";
import Composer from "@/components/publishing/composer";
import HistoryView from "@/components/publishing/history-view";
import MediaLibrary from "@/components/publishing/media-library";
import PostDetail from "@/components/publishing/post-detail";
import { ErrorBox, NoticeBox } from "@/components/publishing/shared";

type Tab = "calendar" | "composer" | "media" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "calendar", label: "Calendar" },
  { id: "composer", label: "Composer" },
  { id: "media", label: "Media library" },
  { id: "history", label: "History" },
];

export default function PublishingPage() {
  const [tab, setTab] = useState<Tab>("calendar");
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [accounts, setAccounts] = useState<InstagramAccountOption[]>([]);
  const [youtubeChannels, setYouTubeChannels] = useState<YouTubeChannelOption[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedPost, setSelectedPost] = useState<ScheduledPost | null>(null);

  const refreshPosts = useCallback(async () => {
    try {
      setPosts(await listPosts());
      setError("");
    } catch (e) {
      setError(toPlainError(e));
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [fetchedPosts, fetchedAccounts, fetchedYouTubeChannels, fetchedCampaigns] = await Promise.all([
        listPosts(),
        listInstagramAccounts().catch(() => ({ instagramAccounts: [], selectedInstagramAccountId: null })),
        listYouTubeChannels().catch(() => [] as YouTubeChannelOption[]),
        listCampaigns().catch(() => [] as CampaignOption[]),
      ]);
      setPosts(fetchedPosts);
      setAccounts(fetchedAccounts.instagramAccounts);
      setYouTubeChannels(fetchedYouTubeChannels);
      setCampaigns(fetchedCampaigns);
      setError("");
    } catch (e) {
      setError(toPlainError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAll();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAll]);

  function handleCreated(result: { id: string; status: string }) {
    void refreshPosts();
    setNotice(`Post saved (${result.status.toLowerCase()}).`);
  }

  return (
    <main className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm text-accent font-semibold">CONTENT STUDIO</p>
        <h1 className="text-3xl font-bold">Publishing calendar</h1>
        <p className="text-muted">Plan Instagram posts, YouTube videos, and Shorts in one calendar.</p>
        <a href="/api/youtube/connect" className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 py-2 text-sm font-medium hover:border-border-hover">Connect YouTube channel</a>
      </header>

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Publishing views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`min-h-11 rounded-lg px-4 py-2 text-sm font-medium ${
              tab === t.id
                ? "bg-accent text-white"
                : "border border-border bg-surface text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void refreshPosts()}
          className="ml-auto min-h-11 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground"
        >
          Refresh
        </button>
      </div>

      {notice && <NoticeBox message={notice} />}
      {error && <ErrorBox message={error} onRetry={() => void loadAll()} />}

      {loading ? (
        <p className="text-muted">Loading posts…</p>
      ) : (
        <>
          {tab === "calendar" && (
            <CalendarView posts={posts} onSelect={setSelectedPost} />
          )}
          {tab === "composer" && (
            <Composer
              accounts={accounts}
              youtubeChannels={youtubeChannels}
              campaigns={campaigns}
              onCreated={handleCreated}
              onViewCalendar={() => setTab("calendar")}
            />
          )}
          {tab === "media" && <MediaLibrary />}
          {tab === "history" && (
            <HistoryView posts={posts} onSelect={setSelectedPost} onChanged={() => void refreshPosts()} />
          )}
        </>
      )}

      {selectedPost && (
        <PostDetail
          key={selectedPost.id}
          post={selectedPost}
          onClose={() => setSelectedPost(null)}
          onChanged={() => void refreshPosts()}
        />
      )}
    </main>
  );
}
