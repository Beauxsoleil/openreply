import { prisma } from "@/lib/db/client";
import { getYouTubeAccessToken, getYouTubeVideoStatus, uploadYouTubeVideo, YouTubeApiError } from "@/lib/youtube/client";

const LEASE_MS = 30 * 60 * 1000;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown YouTube publishing error").slice(0, 500);
}

async function attempt(postId: string, step: string, outcome: string, details?: Record<string, unknown>) {
  await prisma.publishAttempt.create({ data: {
    postId, outcome, details: { step, ...(details ?? {}) }, finishedAt: new Date(),
  } });
}

export async function publishYouTubePost(postId: string) {
  const now = new Date();
  const claimed = await prisma.scheduledPost.updateMany({
    where: {
      id: postId,
      platform: "YOUTUBE",
      youtubeVideoId: null,
      status: "SCHEDULED",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { status: "PREPARING", leaseUntil: new Date(now.getTime() + LEASE_MS), attemptCount: { increment: 1 } },
  });
  if (!claimed.count) return { claimed: false } as const;
  const post = await prisma.scheduledPost.findUnique({
    where: { id: postId }, include: { youtubeChannel: true, mediaAsset: true },
  });
  if (!post?.youtubeChannel || !post.mediaAsset || !post.title || !post.youtubePrivacy || post.youtubeMadeForKids === null) {
    await prisma.scheduledPost.update({ where: { id: postId }, data: {
      status: "FAILED", leaseUntil: null, lastError: "YouTube post is missing channel or required metadata",
    } });
    return { claimed: true, status: "FAILED" as const, postId };
  }
  try {
    const accessToken = await getYouTubeAccessToken(post.youtubeChannel);
    await prisma.scheduledPost.update({ where: { id: postId }, data: { status: "PUBLISHING" } });
    const uploaded = await uploadYouTubeVideo({
      accessToken,
      uploadUrl: post.youtubeUploadUrl,
      storageKey: post.mediaAsset.storageKey,
      byteSize: Number(post.mediaAsset.byteSize),
      mimeType: post.mediaAsset.mimeType,
      title: post.title,
      description: post.caption,
      privacy: post.youtubePrivacy,
      madeForKids: post.youtubeMadeForKids,
      notifySubscribers: post.youtubeNotifySubscribers,
      publishAt: post.scheduledAt,
      onSession: async (url) => {
        await prisma.scheduledPost.update({ where: { id: postId }, data: { youtubeUploadUrl: url } });
        await attempt(postId, "youtube-session", "SUCCESS");
      },
    });
    await attempt(postId, "youtube-upload", "SUCCESS", { youtubeVideoId: uploaded.id });
    await prisma.scheduledPost.update({ where: { id: postId }, data: {
      youtubeVideoId: uploaded.id,
      youtubeUploadUrl: null,
      status: "SCHEDULED",
      leaseUntil: null,
      lastError: null,
    } });
    return { claimed: true, status: "SCHEDULED" as const, postId, youtubeVideoId: uploaded.id };
  } catch (error) {
    const lastError = message(error);
    const recoverable = !(error instanceof YouTubeApiError) || error.status >= 500 || error.status === 429;
    await attempt(postId, "youtube-upload", recoverable ? "RECONCILE_REQUIRED" : "FAILED", { error: lastError });
    await prisma.scheduledPost.update({ where: { id: postId }, data: {
      status: recoverable ? "RECONCILE_REQUIRED" : "FAILED", leaseUntil: null, lastError,
    } });
    return { claimed: true, status: recoverable ? "RECONCILE_REQUIRED" as const : "FAILED" as const, postId };
  }
}

export async function reconcileYouTubePost(postId: string) {
  const post = await prisma.scheduledPost.findUnique({
    where: { id: postId }, include: { youtubeChannel: true },
  });
  if (!post?.youtubeChannel || !post.youtubeVideoId) return { action: "none", status: post?.status ?? "NOT_FOUND" };
  try {
    const accessToken = await getYouTubeAccessToken(post.youtubeChannel);
    const remote = await getYouTubeVideoStatus(accessToken, post.youtubeVideoId);
    if (!remote) {
      await prisma.scheduledPost.update({ where: { id: postId }, data: {
        status: "RECONCILE_REQUIRED", lastError: "YouTube no longer returns this uploaded video",
      } });
      return { action: "reconcile-required", status: "RECONCILE_REQUIRED" };
    }
    if (remote.uploadStatus === "rejected" || remote.uploadStatus === "failed") {
      const lastError = `YouTube rejected the upload${remote.rejectionReason ? `: ${remote.rejectionReason}` : ""}`;
      await attempt(postId, "youtube-reconcile", "FAILED", { uploadStatus: remote.uploadStatus, rejectionReason: remote.rejectionReason });
      await prisma.scheduledPost.update({ where: { id: postId }, data: { status: "FAILED", lastError, leaseUntil: null } });
      return { action: "failed", status: "FAILED" };
    }
    if (remote.privacyStatus === "public") {
      await attempt(postId, "youtube-reconcile", "SUCCESS", { uploadStatus: remote.uploadStatus, privacyStatus: remote.privacyStatus });
      await prisma.scheduledPost.update({ where: { id: postId }, data: {
        status: "PUBLISHED", publishedAt: post.publishedAt ?? new Date(), lastError: null, leaseUntil: null,
      } });
      return { action: "published", status: "PUBLISHED" };
    }
    return { action: "none", status: post.status };
  } catch (error) {
    await attempt(postId, "youtube-reconcile", "WARNING", { error: message(error) });
    return { action: "none", status: post.status };
  }
}
