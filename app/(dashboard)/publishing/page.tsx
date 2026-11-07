"use client";

import { useCallback, useEffect, useState } from "react";

type Post = {
  id: string; caption: string; kind: string; status: string;
  scheduledAt: string | null; timezone: string; publishedAt: string | null;
  instagramAccount: { username: string };
};
export default function PublishingPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/publishing/posts", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Unable to load posts");
      setPosts(result.data);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load posts"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <main className="space-y-6">
    <header className="space-y-2">
      <p className="text-sm text-accent font-semibold">CONTENT STUDIO</p>
      <h1 className="text-3xl font-bold">Publishing calendar</h1>
      <p className="text-muted">Plan Instagram images and Reels. Automatic publishing is coming soon.</p>
    </header>
    <div className="panel rounded-xl p-5 space-y-2">
      <h2 className="font-semibold">Publishing setup in progress</h2>
      <p className="text-sm text-muted">This page is a read-only preview. Scheduling and media uploads will be enabled after Meta publishing permissions, storage and worker checks are complete.</p>
    </div>
    {error && <div role="alert" className="panel rounded-lg p-4 text-error">{error} <button className="underline ml-2" onClick={() => void refresh()}>Retry</button></div>}
    {loading ? <p className="text-muted">Loading posts…</p> : posts.length === 0 ? <div className="panel rounded-xl p-8 text-center text-muted">No posts yet. Your content calendar will appear here.</div> :
      <div className="grid gap-3">{posts.map(post => <article className="panel rounded-xl p-4 space-y-2" key={post.id}>
        <div className="flex justify-between gap-3"><strong>{post.kind} · @{post.instagramAccount.username}</strong><span className="text-sm text-accent">{post.status}</span></div>
        <p className="text-sm whitespace-pre-wrap">{post.caption || "No caption"}</p>
        <p className="text-xs text-muted">{post.scheduledAt ? new Date(post.scheduledAt).toLocaleString(undefined, { timeZone: post.timezone }) + " · " + post.timezone : "Unscheduled draft"}</p>
      </article>)}</div>}
  </main>;
}
