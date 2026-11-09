import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSchedule } from "@/lib/publishing/validation";
import { createOAuthState, getYouTubeAuthorizationUrl, verifyOAuthState } from "@/lib/youtube/oauth";
import { getCurrentYouTubeChannel } from "@/lib/youtube/client";

describe("YouTube OAuth and scheduling", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-long-enough";
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
  });

  afterEach(() => vi.restoreAllMocks());

  it("signs workspace state and requests offline upload and channel read access", () => {
    const state = createOAuthState("workspace-1");
    expect(verifyOAuthState(state)?.workspaceId).toBe("workspace-1");
    expect(verifyOAuthState(`${state}tampered`)).toBeNull();

    const url = new URL(getYouTubeAuthorizationUrl("https://app.test/api/youtube/callback", state));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(new Set(url.searchParams.get("scope")?.split(" "))).toEqual(new Set([
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ]));
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("requires complete YouTube metadata and public privacy for native publishAt", () => {
    const base = {
      platform: "YOUTUBE" as const,
      youtubeChannelId: "channel-db-id",
      mediaAssetId: "asset-id",
      kind: "VIDEO" as const,
      title: "Launch video",
      caption: "Description",
      youtubePrivacy: "PUBLIC" as const,
      youtubeMadeForKids: false,
      youtubeNotifySubscribers: true,
      timezone: "UTC",
      scheduledAt: "2030-01-01T10:00:00.000Z",
    };
    expect(validateSchedule(base, new Date("2029-01-01T00:00:00.000Z"))).toBeNull();
    expect(validateSchedule({ ...base, youtubePrivacy: "UNLISTED" }, new Date("2029-01-01T00:00:00.000Z")))
      .toContain("publishAt");
    expect(validateSchedule({ ...base, title: "" }, new Date("2029-01-01T00:00:00.000Z")))
      .toBe("YouTube title is required");
  });

  it("loads the authenticated channel without exposing tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [{ id: "UC123", snippet: { title: "OpenReply", thumbnails: { default: { url: "https://img.test/a.jpg" } } } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(getCurrentYouTubeChannel("secret-token")).resolves.toEqual({
      channelId: "UC123", title: "OpenReply", thumbnailUrl: "https://img.test/a.jpg",
    });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("mine=true"), {
      headers: { Authorization: "Bearer secret-token" },
    });
  });
});
