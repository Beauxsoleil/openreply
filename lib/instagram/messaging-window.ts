import { prisma } from "@/lib/db/client";

// Meta's 24-hour messaging window: a business may only send a DM within 24
// hours of the recipient's last interaction with it (an inbound message, a
// button tap, a story reply). Outside the window Meta rejects the send, so
// the worker checks this before spending an API call and logs a
// SKIPPED_WINDOW_CLOSED row instead of a failure.
//
// The window is tracked per (Instagram account, recipient) in
// RecipientInteraction, updated from webhook events in
// lib/queue/process-webhook.ts. A read receipt is deliberately NOT an
// interaction: Meta does not treat reading a message as opening the window
// (see the read-fallback handling in lib/queue/dm-worker.ts).
//
// No row means "never seen interacting" — that is unknown, not closed, and
// callers fail open (let Meta decide) rather than skipping a send they
// cannot judge. Only a row older than 24h proves the window is closed.

export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MessagingWindowState = "open" | "closed" | "unknown";

export interface MessagingWindowStatus {
  state: MessagingWindowState;
  lastInteractionAt: Date | null;
}

/**
 * Record that a recipient interacted with an Instagram account at `at`
 * (default now). `instagramAccountId` is the InstagramAccount row id.
 */
export async function recordRecipientInteraction(
  instagramAccountId: string,
  recipientId: string,
  at: Date = new Date()
): Promise<void> {
  await prisma.recipientInteraction.upsert({
    where: {
      instagramAccountId_recipientId: { instagramAccountId, recipientId },
    },
    create: { instagramAccountId, recipientId, lastInteractionAt: at },
    update: { lastInteractionAt: at },
  });
}

export async function getMessagingWindowStatus(
  instagramAccountId: string,
  recipientId: string,
  now: Date = new Date()
): Promise<MessagingWindowStatus> {
  const row = await prisma.recipientInteraction.findUnique({
    where: {
      instagramAccountId_recipientId: { instagramAccountId, recipientId },
    },
    select: { lastInteractionAt: true },
  });

  if (!row) {
    return { state: "unknown", lastInteractionAt: null };
  }

  const lastInteractionAt = row.lastInteractionAt;
  const state =
    now.getTime() - lastInteractionAt.getTime() <= MESSAGING_WINDOW_MS
      ? "open"
      : "closed";
  return { state, lastInteractionAt };
}
