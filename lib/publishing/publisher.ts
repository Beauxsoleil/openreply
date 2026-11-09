/**
 * Scheduled-post publisher: claim a due post, run it through Meta's
 * container lifecycle, and land it PUBLISHED — or FAILED / RECONCILE_REQUIRED.
 *
 * Safety rules (see docs/instagram-publishing.md):
 * - Atomic DB lease: only the worker whose updateMany claims the row may
 *   publish it. 0 rows affected means another worker claimed it.
 * - Demo accounts never reach Meta (isDemoAccount or DEMO_MODE).
 * - The publish permission is probed before any container is created; a
 *   messaging-only token fails permanently with the permission named.
 * - A network error AFTER the publish call was submitted means the outcome
 *   is unknown — mark RECONCILE_REQUIRED, never blind-retry (a retry could
 *   post a duplicate). Only a definitive Meta rejection (MetaApiError) after
 *   submit may mark FAILED. A rate-limit rejection is definitive too, but
 *   it is retried by BullMQ instead: the post is reset to SCHEDULED and the
 *   RateLimitError is rethrown.
 * - PublishAttempt rows audit every step. They never contain access tokens
 *   or signed media URLs — only ids, status codes, and error messages.
 * - DM automation attachment happens AFTER success only, and only when the
 *   automation exists in the same workspace AND on the same Instagram
 *   account. A missing/mismatched automation is a warning, never a publish
 *   failure. Failed/canceled posts never activate an automation.
 */

import { prisma } from "@/lib/db/client";
import { isDemoAccount } from "@/lib/demo";
import { isDemoMode } from "@/lib/env";
import {
  MetaApiError,
  PermissionError,
  RateLimitError,
  TokenExpiredError,
  type MetaGraphHost,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  checkPublishPermission,
  createImageContainer,
  createReelContainer,
  getContainerStatus,
  getPublishedMedia,
  publishContainer,
} from "@/lib/meta/publishing";
import { getMediaDeliveryUrl } from "@/lib/publishing/r2";
import { publishYouTubePost } from "@/lib/publishing/youtube-publisher";

const LEASE_MS = 10 * 60 * 1000;

function pollIntervalMs(): number {
  return Number(process.env.PUBLISH_POLL_INTERVAL_MS ?? 10_000);
}

function pollTimeoutMs(): number {
  return Number(process.env.PUBLISH_POLL_TIMEOUT_MS ?? 10 * 60 * 1000);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof MetaApiError) {
    return `${error.name} ${error.code}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

function truncate(message: string, max = 500): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

export interface PublishOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type PublishResult =
  | { claimed: false }
  | {
      claimed: true;
      status: "PUBLISHED" | "FAILED" | "RECONCILE_REQUIRED";
      postId: string;
      instagramMediaId?: string;
    };

import type {
  InstagramAccount,
  MediaAsset,
  ScheduledPost,
} from "@/app/generated/prisma/client";

type PostWithRelations = ScheduledPost & {
  instagramAccount: InstagramAccount | null;
  mediaAsset: MediaAsset | null;
};

async function recordStep(
  postId: string,
  step: string,
  outcome: string,
  errorCode?: string,
  details?: Record<string, unknown>
): Promise<void> {
  await prisma.publishAttempt.create({
    data: {
      postId,
      outcome,
      errorCode,
      details: { step, ...(details ?? {}) },
      finishedAt: new Date(),
    },
  });
}

async function markPost(
  postId: string,
  data: Parameters<typeof prisma.scheduledPost.update>[0]["data"]
): Promise<void> {
  await prisma.scheduledPost.update({ where: { id: postId }, data });
}

async function failPost(
  postId: string,
  lastError: string,
  step: string,
  errorCode?: string
): Promise<PublishResult> {
  await recordStep(postId, step, "FAILED", errorCode, {
    error: truncate(lastError),
  });
  await markPost(postId, {
    status: "FAILED",
    lastError: truncate(lastError),
    leaseUntil: null,
  });
  return { claimed: true, status: "FAILED", postId };
}

async function reconcileRequiredPost(
  postId: string,
  lastError: string,
  step: string,
  extra?: Parameters<typeof prisma.scheduledPost.update>[0]["data"]
): Promise<PublishResult> {
  await recordStep(postId, step, "RECONCILE_REQUIRED", undefined, {
    error: truncate(lastError),
  });
  await markPost(postId, {
    status: "RECONCILE_REQUIRED",
    lastError: truncate(lastError),
    leaseUntil: null,
    ...(extra ?? {}),
  });
  return { claimed: true, status: "RECONCILE_REQUIRED", postId };
}

export async function publishPost(
  postId: string,
  opts?: PublishOptions
): Promise<PublishResult> {
  const intervalMs = opts?.pollIntervalMs ?? pollIntervalMs();
  const timeoutMs = opts?.pollTimeoutMs ?? pollTimeoutMs();
  const sleep = opts?.sleep ?? defaultSleep;

  // Atomic lease: only a SCHEDULED, due post with no live lease can be
  // claimed. 0 rows means another worker claimed it (or it is not due).
  const now = new Date();
  const claimed = await prisma.scheduledPost.updateMany({
    where: {
      id: postId,
      status: "SCHEDULED",
      scheduledAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      status: "PREPARING",
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      attemptCount: { increment: 1 },
    },
  });
  if (claimed.count === 0) return { claimed: false };

  const post: PostWithRelations | null =
    await prisma.scheduledPost.findUnique({
      where: { id: postId },
      include: { instagramAccount: true, mediaAsset: true },
    });
  if (!post || !post.instagramAccount || !post.mediaAsset) {
    return { claimed: false };
  }

  const account = post.instagramAccount;
  const asset = post.mediaAsset;
  const host: MetaGraphHost = account.isUnifiedLogin
    ? "facebook"
    : "instagram";

  try {
    // Demo guard: never call Meta for a demo account, in any mode.
    if (isDemoAccount(account) || isDemoMode()) {
      return await failPost(
        postId,
        "Demo accounts cannot publish",
        "demo-guard"
      );
    }

    let accessToken: string;
    try {
      accessToken = decryptToken(account.accessToken);
    } catch {
      return await failPost(
        postId,
        "Failed to decrypt Instagram access token",
        "decrypt-token"
      );
    }

    // Permission probe: a messaging-only token fails here, permanently,
    // with the missing permission named — before any container exists.
    try {
      const { permission } = await checkPublishPermission({
        accessToken,
        host,
      });
      await recordStep(postId, "permission", "SUCCESS", undefined, {
        permission,
      });
    } catch (error) {
      if (
        error instanceof TokenExpiredError ||
        error instanceof PermissionError
      ) {
        return await failPost(
          postId,
          formatError(error),
          "permission",
          String(error.code)
        );
      }
      throw error;
    }

    // Media delivery URL: created near publish time, never stored.
    let deliveryUrl: string;
    try {
      deliveryUrl = await getMediaDeliveryUrl(asset.storageKey);
    } catch (error) {
      return await failPost(
        postId,
        `Failed to create media delivery URL: ${formatError(error)}`,
        "delivery-url"
      );
    }

    // Create the container. A definitive Meta rejection fails permanently;
    // a transport failure fails too — no post can exist yet, so a manual
    // retry is safe.
    let containerId: string;
    try {
      const container =
        post.kind === "REEL"
          ? await createReelContainer({
              accessToken,
              instagramAccountId: account.instagramId,
              videoUrl: deliveryUrl,
              caption: post.caption,
              host,
            })
          : await createImageContainer({
              accessToken,
              instagramAccountId: account.instagramId,
              imageUrl: deliveryUrl,
              caption: post.caption,
              host,
            });
      containerId = container.id;
      await recordStep(postId, "container", "SUCCESS", undefined, {
        containerId,
      });
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      return await failPost(
        postId,
        `Failed to create Instagram media container: ${formatError(error)}`,
        "container",
        error instanceof MetaApiError ? String(error.code) : undefined
      );
    }
    await markPost(postId, { containerId });

    // Poll until Meta finishes processing the media.
    const pollStart = Date.now();
    for (;;) {
      let status: Awaited<ReturnType<typeof getContainerStatus>>;
      try {
        status = await getContainerStatus({
          accessToken,
          containerId,
          host,
        });
      } catch (error) {
        if (error instanceof RateLimitError) throw error;
        return await failPost(
          postId,
          `Failed to check Instagram container status: ${formatError(error)}`,
          "poll",
          error instanceof MetaApiError ? String(error.code) : undefined
        );
      }
      if (status.status === "FINISHED" || status.status === "PUBLISHED") break;
      if (status.status === "ERROR" || status.status === "EXPIRED") {
        return await failPost(
          postId,
          `Instagram media container ${status.status === "EXPIRED" ? "expired" : "failed to process"} (status ${status.status})`,
          "poll",
          status.status
        );
      }
      if (Date.now() - pollStart > timeoutMs) {
        await recordStep(postId, "poll", "TIMEOUT", undefined, {
          containerId,
        });
        return await reconcileRequiredPost(
          postId,
          "Timed out waiting for Instagram to finish processing the media container; the container may still finish. Check Instagram manually before retrying.",
          "poll"
        );
      }
      await sleep(intervalMs);
    }
    await recordStep(postId, "poll", "SUCCESS", undefined, { containerId });

    // Submit the publish. From here the outcome can be unknown: a
    // transport/timeout error means Meta may have published it, so never
    // blind-retry — RECONCILE_REQUIRED. Only a definitive Meta answer
    // (MetaApiError) may mark FAILED.
    await markPost(postId, { status: "PUBLISHING" });
    let instagramMediaId: string;
    try {
      const published = await publishContainer({
        accessToken,
        instagramAccountId: account.instagramId,
        containerId,
        host,
      });
      instagramMediaId = published.id;
      await recordStep(postId, "publish", "SUCCESS", undefined, {
        containerId,
        instagramMediaId,
      });
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      if (error instanceof MetaApiError) {
        return await failPost(
          postId,
          `Instagram publish rejected the container: ${formatError(error)}`,
          "publish",
          String(error.code)
        );
      }
      return await reconcileRequiredPost(
        postId,
        `Publish request to Instagram failed with an unknown outcome (${formatError(error)}). The post may already be live — check Instagram manually before retrying; do not re-publish blindly.`,
        "publish"
      );
    }

    // Read back the permalink. The post is live at this point; a failure
    // here leaves the media id stored and the post RECONCILE_REQUIRED so a
    // human can confirm it instead of risking a duplicate.
    let permalink: string | undefined;
    try {
      const media = await getPublishedMedia({
        accessToken,
        mediaId: instagramMediaId,
        host,
      });
      permalink = media.permalink;
      await recordStep(postId, "verify", "SUCCESS", undefined, {
        instagramMediaId,
        permalink: permalink ?? null,
      });
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      return await reconcileRequiredPost(
        postId,
        `Post was published to Instagram (media ${instagramMediaId}) but reading it back failed (${formatError(error)}). Check Instagram manually; do not re-publish.`,
        "verify",
        { instagramMediaId, containerId }
      );
    }

    await markPost(postId, {
      status: "PUBLISHED",
      publishedAt: new Date(),
      instagramMediaId,
      containerId,
      lastError: null,
      leaseUntil: null,
    });

    // DM attachment — after success ONLY. The automation must exist in the
    // same workspace AND on the same Instagram account; anything else is a
    // warning in the attempt log, never a publish failure.
    if (post.automationId) {
      try {
        const automation = await prisma.automation.findUnique({
          where: { id: post.automationId },
        });
        if (!automation) {
          await recordStep(postId, "automation", "WARNING", undefined, {
            warning: `Automation ${post.automationId} no longer exists; post published but no campaign was attached`,
          });
        } else if (automation.workspaceId !== post.workspaceId) {
          await recordStep(postId, "automation", "WARNING", undefined, {
            warning: `Automation ${post.automationId} belongs to a different workspace; post published but no campaign was attached`,
          });
        } else if (automation.instagramAccountId !== post.instagramAccountId) {
          await recordStep(postId, "automation", "WARNING", undefined, {
            warning: `Automation ${post.automationId} belongs to a different Instagram account; post published but no campaign was attached`,
          });
        } else if (post.automationActivateOnPublish) {
          await prisma.automation.update({
            where: { id: automation.id },
            data: { postId: instagramMediaId, isActive: true },
          });
          await recordStep(postId, "automation", "SUCCESS", undefined, {
            automationId: automation.id,
            instagramMediaId,
          });
        } else {
          await recordStep(postId, "automation", "SKIPPED", undefined, {
            automationId: automation.id,
            reason: "automationActivateOnPublish is false",
          });
        }
      } catch (error) {
        // Attachment is best-effort: the post is already live, so a
        // failure here must not un-publish it.
        await recordStep(postId, "automation", "WARNING", undefined, {
          warning: `Automation attachment failed: ${formatError(error)}`,
        });
      }
    }

    return {
      claimed: true,
      status: "PUBLISHED",
      postId,
      instagramMediaId,
    };
  } catch (error) {
    // Rate limits are transient: reset the post so BullMQ's retry can claim
    // it again, then rethrow so BullMQ actually retries. A rate-limit
    // rejection is a definitive Meta answer (the post was NOT published), so
    // resetting is safe — unlike the unknown-outcome case above, which never
    // reaches this handler.
    if (error instanceof RateLimitError) {
      await markPost(postId, {
        status: "SCHEDULED",
        leaseUntil: null,
      }).catch(() => {});
      throw error;
    }
    return await failPost(
      postId,
      `Unexpected publishing error: ${formatError(error)}`,
      "publish"
    );
  }
}

export async function publishScheduledPost(postId: string, opts?: PublishOptions) {
  const post = await prisma.scheduledPost.findUnique({
    where: { id: postId }, select: { platform: true },
  });
  if (post?.platform === "YOUTUBE") return publishYouTubePost(postId);
  return publishPost(postId, opts);
}

export type ReconcileAction =
  | "reset"
  | "failed"
  | "reconcile-required"
  | "extended"
  | "none";

export interface ReconcileResult {
  action: ReconcileAction;
  status: string;
  postId: string;
}

/**
 * Recover a post stuck in PREPARING/PUBLISHING with an expired lease
 * (worker crashed or was killed mid-publish).
 *
 * - No container yet: nothing was submitted — safe reset to SCHEDULED.
 * - PREPARING + container FINISHED: nothing published yet — safe reset.
 * - PREPARING/PUBLISHING + container ERROR/EXPIRED: terminal — FAILED.
 * - PUBLISHING + container FINISHED, or container PUBLISHED: the publish
 *   call may have gone through — outcome unknown — RECONCILE_REQUIRED with
 *   a note to check Instagram manually. Never reset these to SCHEDULED: a
 *   retry could post a duplicate.
 * - Container still IN_PROGRESS: the media is still processing — extend the
 *   lease and leave it alone.
 * - Container status unreadable (token/decrypt failure): outcome unknown —
 *   RECONCILE_REQUIRED.
 */
export async function reconcilePost(postId: string): Promise<ReconcileResult> {
  const post = await prisma.scheduledPost.findUnique({
    where: { id: postId },
    include: { instagramAccount: true, mediaAsset: true },
  });
  if (!post) return { action: "none", status: "NOT_FOUND", postId };
  if (post.status !== "PREPARING" && post.status !== "PUBLISHING") {
    return { action: "none", status: post.status, postId };
  }
  if (post.leaseUntil && post.leaseUntil.getTime() > Date.now()) {
    return { action: "none", status: post.status, postId };
  }

  const resetToScheduled = async (): Promise<ReconcileResult> => {
    await recordStep(postId, "reconcile", "RESET", undefined, {
      fromStatus: post.status,
    });
    await markPost(postId, {
      status: "SCHEDULED",
      leaseUntil: null,
    });
    return { action: "reset", status: "SCHEDULED", postId };
  };

  if (!post.containerId) return resetToScheduled();

  const account = post.instagramAccount;
  if (!account || isDemoAccount(account) || isDemoMode()) {
    await recordStep(postId, "reconcile", "FAILED", undefined, {
      error: "Demo accounts cannot publish",
    });
    await markPost(postId, {
      status: "FAILED",
      lastError: "Demo accounts cannot publish",
      leaseUntil: null,
    });
    return { action: "failed", status: "FAILED", postId };
  }

  const host: MetaGraphHost = account.isUnifiedLogin
    ? "facebook"
    : "instagram";

  let accessToken: string;
  try {
    accessToken = decryptToken(account.accessToken);
  } catch {
    await reconcileRequiredPost(
      postId,
      "Could not decrypt the Instagram access token while reconciling; check Instagram manually to see whether the post went live.",
      "reconcile"
    );
    return { action: "reconcile-required", status: "RECONCILE_REQUIRED", postId };
  }

  let status: Awaited<ReturnType<typeof getContainerStatus>>;
  try {
    status = await getContainerStatus({
      accessToken,
      containerId: post.containerId,
      host,
    });
  } catch (error) {
    await reconcileRequiredPost(
      postId,
      `Could not read the Instagram container status while reconciling (${formatError(error)}); the post may already be live — check Instagram manually before retrying.`,
      "reconcile"
    );
    return { action: "reconcile-required", status: "RECONCILE_REQUIRED", postId };
  }

  if (status.status === "ERROR" || status.status === "EXPIRED") {
    await recordStep(postId, "reconcile", "FAILED", status.status, {
      containerId: post.containerId,
    });
    await markPost(postId, {
      status: "FAILED",
      lastError: `Instagram media container ${status.status === "EXPIRED" ? "expired" : "failed to process"} (status ${status.status})`,
      leaseUntil: null,
    });
    return { action: "failed", status: "FAILED", postId };
  }

  if (status.status === "IN_PROGRESS") {
    await markPost(postId, {
      leaseUntil: new Date(Date.now() + LEASE_MS),
    });
    return { action: "extended", status: post.status, postId };
  }

  // FINISHED: safe to retry only if the publish was never submitted
  // (PREPARING). In PUBLISHING the submit may already have happened.
  if (status.status === "FINISHED" && post.status === "PREPARING") {
    return resetToScheduled();
  }

  // PUBLISHED container, or FINISHED after the submit: outcome unknown.
  await reconcileRequiredPost(
    postId,
    `Instagram container ${post.containerId} reports status ${status.status} after the publish step; the post may already be live — check Instagram manually before retrying; do not re-publish blindly.`,
    "reconcile"
  );
  return { action: "reconcile-required", status: "RECONCILE_REQUIRED", postId };
}
