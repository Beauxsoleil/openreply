/**
 * BullMQ publishing queue.
 *
 * Separate from the DM queue ("dm-processing"): publishing jobs are slow
 * (container polling can take minutes) and must never starve comment->DM
 * delivery, and the publishing worker runs with concurrency 1 so two
 * workers can never publish the same post at once (the DB lease in
 * lib/publishing/publisher.ts is the second line of defence).
 *
 * Job ids are deterministic (`publish_<postId>`), so a reschedule or retry
 * replaces the one queued job for a post instead of stacking duplicates.
 * The database schedule is the source of truth; Redis jobs are rebuilt by
 * the reconciler after a restart.
 */

import { Queue, Worker } from "bullmq";
import { RateLimitError } from "@/lib/meta/client";
import { publishScheduledPost } from "@/lib/publishing/publisher";
import { getRedisConnection } from "./client";

export interface PublishJob {
  postId: string;
}

export const PUBLISH_JOB_NAME = "publish-post";

export function publishJobId(postId: string): string {
  return `publish_${postId}`;
}

let publishingQueue: Queue<PublishJob> | null = null;

export function getPublishingQueue(): Queue<PublishJob> {
  if (!publishingQueue) {
    publishingQueue = new Queue<PublishJob>("publishing", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    });
  }
  return publishingQueue;
}

const LIVE_JOB_STATES = new Set([
  "waiting",
  "delayed",
  "active",
  "prioritized",
  "waiting-children",
]);

/**
 * True when a job for this post is still queued or running. A completed or
 * failed job that BullMQ retained does NOT count: a post that is still
 * SCHEDULED after its job finished (e.g. the worker found the lease held)
 * must be re-enqueued by the reconciler, not skipped forever.
 */
export async function hasLivePublishJob(postId: string): Promise<boolean> {
  const job = await getPublishingQueue().getJob(publishJobId(postId));
  if (!job) return false;
  const state = await job.getState();
  return LIVE_JOB_STATES.has(state);
}

/** Enqueue (or re-enqueue) the publish job for a post, firing at `scheduledAt`. */
export async function enqueuePublish(
  postId: string,
  scheduledAt: Date | string
): Promise<void> {
  const queue = getPublishingQueue();
  const jobId = publishJobId(postId);
  // A retained job with the same deterministic id would make BullMQ reject
  // the add, so drop any stale one first.
  const existing = await queue.getJob(jobId);
  if (existing) await existing.remove();
  const delay = Math.max(
    0,
    new Date(scheduledAt).getTime() - Date.now()
  );
  await queue.add(
    PUBLISH_JOB_NAME,
    { postId },
    { jobId, delay }
  );
}

/** Remove the queued publish job for a post, if one exists. */
export async function cancelPublish(postId: string): Promise<void> {
  const job = await getPublishingQueue().getJob(publishJobId(postId));
  if (job) await job.remove();
}

/**
 * Create the publishing worker: one job at a time, in queue order.
 * A rate-limit error is rethrown by publishPost so BullMQ retries it under
 * the queue's attempts/backoff; permanent failures are recorded on the post
 * and the job completes.
 */
export function createPublishingWorker(): Worker<PublishJob> {
  const worker = new Worker<PublishJob>(
    "publishing",
    async (job) => {
      try {
        const result = await publishScheduledPost(job.data.postId);
        if (!result.claimed) {
          console.log(
            `[Publishing Worker] Post ${job.data.postId} not claimed (already handled or not due)`
          );
        } else {
          console.log(
            `[Publishing Worker] Post ${job.data.postId} -> ${result.status}`
          );
        }
      } catch (error) {
        // publishPost only rethrows rate limits; anything else reaching
        // here is unexpected, so log it and let BullMQ retry.
        if (!(error instanceof RateLimitError)) {
          console.error(
            `[Publishing Worker] Unexpected error publishing post ${job.data.postId}:`,
            error instanceof Error ? error.message : error
          );
        }
        throw error;
      }
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );

  worker.on("completed", (job) => {
    console.log(`[Publishing Worker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[Publishing Worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message
    );
  });

  worker.on("error", (err) => {
    console.error("[Publishing Worker] Worker error:", err.message);
  });

  return worker;
}
