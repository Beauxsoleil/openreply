/**
 * Publishing reconciler — the startup / periodic safety net for the
 * publishing queue. The database schedule is the source of truth; Redis
 * jobs may be lost on restart, and a worker can die mid-publish.
 *
 * (a) SCHEDULED posts whose time has come (scheduledAt <= now + 60s) with
 *     no live job in the queue get enqueued.
 * (b) PREPARING/PUBLISHING posts with an expired lease get reconcilePost()
 *     treatment (safe reset, FAILED, or RECONCILE_REQUIRED).
 *
 * Logs (console + OperationalEvent rows, source WORKER) only when action
 * was taken — a quiet sweep is a healthy sweep.
 */

import { prisma } from "@/lib/db/client";
import { enqueuePublish, hasLivePublishJob } from "@/lib/queue/publishing";
import { reconcilePost } from "./publisher";

export interface ReconcilePublishingResult {
  enqueued: string[];
  reconciled: Array<{ postId: string; action: string; status: string }>;
}

async function logAction(
  workspaceId: string | undefined,
  message: string,
  payload: Record<string, string>
): Promise<void> {
  console.log(`[Publishing Reconciler] ${message}`, payload);
  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: workspaceId ?? null,
        source: "WORKER",
        level: "INFO",
        message,
        payload,
      },
    })
    .catch(() => {});
}

export async function reconcilePublishing(): Promise<ReconcilePublishingResult> {
  const now = new Date();
  const result: ReconcilePublishingResult = { enqueued: [], reconciled: [] };

  const due = await prisma.scheduledPost.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lte: new Date(now.getTime() + 60_000) },
    },
    select: { id: true, scheduledAt: true, workspaceId: true },
  });
  for (const post of due) {
    if (!post.scheduledAt) continue;
    if (await hasLivePublishJob(post.id)) continue;
    await enqueuePublish(post.id, post.scheduledAt);
    result.enqueued.push(post.id);
    await logAction(post.workspaceId, "Enqueued overdue scheduled post", {
      postId: post.id,
      scheduledAt: post.scheduledAt.toISOString(),
    });
  }

  const stale = await prisma.scheduledPost.findMany({
    where: {
      status: { in: ["PREPARING", "PUBLISHING"] },
      leaseUntil: { lt: now },
    },
    select: { id: true, workspaceId: true },
  });
  for (const post of stale) {
    const reconciled = await reconcilePost(post.id);
    if (reconciled.action === "none") continue;
    result.reconciled.push({
      postId: post.id,
      action: reconciled.action,
      status: reconciled.status,
    });
    await logAction(
      post.workspaceId,
      `Reconciled stale publishing post (${reconciled.action})`,
      { postId: post.id, action: reconciled.action, status: reconciled.status }
    );
  }

  return result;
}
