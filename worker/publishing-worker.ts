// Load .env for local dev / Codespaces. dotenv silently does nothing when
// no .env file exists (production platforms inject env vars), and it never
// overrides variables already set in the environment. Without this, the
// worker runs with no DATABASE_URL/REDIS_URL locally because tsx does not
// load .env the way `next dev` does.
import "dotenv/config";

import { createPublishingWorker, getPublishingQueue } from "@/lib/queue/publishing";
import { reconcilePublishing } from "@/lib/publishing/reconciler";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { isDemoMode } from "@/lib/env";
import os from "node:os";

// Demo mode never publishes, so the real worker has nothing safe to do
// here: refuse to start instead of running a queue that can only fail its
// publishes.
if (isDemoMode()) {
  console.log(
    "[Publishing Worker] DEMO_MODE=1 — worker will not start. Demo mode never publishes to Instagram."
  );
  process.exit(0);
}

const worker = createPublishingWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Reconciler safety net: rebuilds Redis jobs the database says should exist
// (due posts with no live job) and recovers posts stuck mid-publish after a
// crash. Runs in the worker because it must fire every minute and Vercel's
// free crons only run once a day.
const RECONCILE_INTERVAL_MS = 60_000;

console.log("[Publishing Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat(
      {
        pid: process.pid,
        hostname: os.hostname(),
        startedAt,
      },
      "publishing"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Publishing Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function reconcile() {
  try {
    const result = await reconcilePublishing();
    if (result.enqueued.length > 0 || result.reconciled.length > 0) {
      console.log("[Publishing Worker] Reconciliation:", result);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Publishing Worker] Reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void reconcile(), 10_000);
const reconcileTimer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[Publishing Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(reconcileTimer);
  await worker.close();
  await getPublishingQueue().close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
