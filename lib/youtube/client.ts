import { prisma } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { getMediaObjectRange } from "@/lib/publishing/r2";
import { refreshYouTubeAccessToken } from "./oauth";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3/videos";
const CHUNK_SIZE = 8 * 1024 * 1024; // Google requires multiples of 256 KiB.

export class YouTubeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message || `YouTube API request failed (${response.status})`;
}

export async function getYouTubeAccessToken(channel: {
  id: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
}): Promise<string> {
  if (channel.tokenExpiresAt.getTime() > Date.now() + 60_000) {
    return decryptToken(channel.accessToken);
  }
  const refreshed = await refreshYouTubeAccessToken(decryptToken(channel.refreshToken));
  await prisma.youTubeChannel.update({
    where: { id: channel.id },
    data: {
      accessToken: encryptToken(refreshed.access_token),
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
    },
  });
  return refreshed.access_token;
}

export async function getCurrentYouTubeChannel(accessToken: string) {
  const response = await fetch(`${API}/channels?part=id,snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new YouTubeApiError(await readError(response), response.status);
  const data = await response.json() as {
    items?: Array<{ id: string; snippet: { title: string; thumbnails?: { default?: { url?: string } } } }>;
  };
  const channel = data.items?.[0];
  if (!channel) throw new YouTubeApiError("This Google account has no YouTube channel", 404);
  return {
    channelId: channel.id,
    title: channel.snippet.title,
    thumbnailUrl: channel.snippet.thumbnails?.default?.url ?? null,
  };
}

export interface YouTubeUploadInput {
  accessToken: string;
  uploadUrl?: string | null;
  storageKey: string;
  byteSize: number;
  mimeType: string;
  title: string;
  description: string;
  privacy: "PRIVATE" | "UNLISTED" | "PUBLIC";
  madeForKids: boolean;
  notifySubscribers: boolean;
  publishAt?: Date | null;
  onSession: (url: string) => Promise<void>;
}

export async function uploadYouTubeVideo(input: YouTubeUploadInput): Promise<{ id: string }> {
  let uploadUrl = input.uploadUrl;
  if (!uploadUrl) {
    const params = new URLSearchParams({
      uploadType: "resumable",
      part: "snippet,status",
      notifySubscribers: String(input.notifySubscribers),
    });
    const scheduled = Boolean(input.publishAt && input.publishAt.getTime() > Date.now());
    const response = await fetch(`${UPLOAD_API}?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(input.byteSize),
        "X-Upload-Content-Type": input.mimeType,
      },
      body: JSON.stringify({
        snippet: { title: input.title, description: input.description },
        status: {
          privacyStatus: scheduled ? "private" : input.privacy.toLowerCase(),
          ...(scheduled ? { publishAt: input.publishAt!.toISOString() } : {}),
          selfDeclaredMadeForKids: input.madeForKids,
        },
      }),
    });
    if (!response.ok) throw new YouTubeApiError(await readError(response), response.status);
    uploadUrl = response.headers.get("location");
    if (!uploadUrl) throw new YouTubeApiError("YouTube did not return a resumable upload URL", 502);
    await input.onSession(uploadUrl);
  }

  let offset = 0;
  while (offset < input.byteSize) {
    const end = Math.min(offset + CHUNK_SIZE, input.byteSize) - 1;
    const chunk = await getMediaObjectRange(input.storageKey, offset, end);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": input.mimeType,
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${offset}-${end}/${input.byteSize}`,
      },
      body: new Uint8Array(chunk),
    });
    if (response.status === 200 || response.status === 201) {
      const video = await response.json() as { id?: string };
      if (!video.id) throw new YouTubeApiError("YouTube upload completed without a video id", 502);
      return { id: video.id };
    }
    if (response.status !== 308) {
      throw new YouTubeApiError(await readError(response), response.status);
    }
    const range = response.headers.get("range");
    const uploadedThrough = range?.match(/bytes=0-(\d+)/)?.[1];
    offset = uploadedThrough ? Number(uploadedThrough) + 1 : end + 1;
  }
  throw new YouTubeApiError("YouTube resumable upload ended without confirmation", 502);
}

export async function getYouTubeVideoStatus(accessToken: string, videoId: string) {
  const response = await fetch(`${API}/videos?part=status&id=${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new YouTubeApiError(await readError(response), response.status);
  const data = await response.json() as { items?: Array<{ status: {
    privacyStatus: string; uploadStatus: string; rejectionReason?: string; publishAt?: string;
  } }> };
  return data.items?.[0]?.status ?? null;
}
