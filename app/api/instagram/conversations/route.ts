import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getMessagingWindowStatus } from "@/lib/instagram/messaging-window";
import { isConfirmedSendRejection } from "@/lib/instagram/delivery-errors";
import {
  getConversations,
  sendDirectMessage,
  MetaApiError,
} from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";
import {
  assertNotDemoSend,
  DEMO_REFUSAL_MESSAGE,
} from "@/lib/demo";
import { reserveDMSlot, releaseDMSlot, type RateLimitResult } from "@/lib/utils/rate-limiter";

export interface ConversationListItem {
  id: string;
  detailsUnavailable?: boolean;
  contact: { id: string; username: string | null };
  updatedTime: string | null;
  lastMessage: {
    text: string;
    fromMe: boolean;
    createdTime: string | null;
  } | null;
}

export interface ConversationsResponse {
  conversations: ConversationListItem[];
  account: { id: string; username: string; instagramId: string };
}

// List the account's DM conversations for the inbox.
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  try {
    const accessToken = await createInstagramContext(account);
    const raw = await getConversations({
      context: accessToken,
      igUserId: account.instagramId,
    });

    const conversations: ConversationListItem[] = raw.map((c) => {
      const participants = c.participants?.data ?? [];
      const contact =
        participants.find((p) => p.id !== account.instagramId) ?? null;
      const last = c.messages?.data?.[0] ?? null;

      return {
        id: c.id,
        detailsUnavailable: c.detailsUnavailable,
        contact: {
          id: contact?.id ?? "",
          username: contact?.username ?? null,
        },
        updatedTime: c.updated_time ?? null,
        lastMessage: last
          ? {
              text: last.message ?? "",
              fromMe: last.from?.id === account.instagramId,
              createdTime: last.created_time ?? null,
            }
          : null,
      };
    });

    const data: ConversationsResponse = {
      conversations,
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
      },
    };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[Conversations] Error:", err);
    const message =
      err instanceof MetaApiError
        ? err.message
        : "Failed to load conversations";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

// Send a direct message reply.
export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: {
    instagramAccountId?: string;
    recipientId?: string;
    text?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  const text = body.text?.trim();
  if (!body.recipientId || !text) {
    return NextResponse.json(
      { success: false, error: "A recipient and message are required." },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    body.instagramAccountId ?? null
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  // Demo-mode guard: a demo account (or DEMO_MODE=1) never sends a real DM,
  // including a hand-typed reply from the inbox.
  try {
    assertNotDemoSend(account);
  } catch {
    return NextResponse.json(
      { success: false, error: DEMO_REFUSAL_MESSAGE },
      { status: 403 }
    );
  }

  // Pre-send 24-hour messaging-window check: the worker skips sends outside
  // the window instead of failing them, and a manual reply should get the
  // same answer up front. No interaction ever recorded is unknown, not
  // closed — the reply goes ahead and Meta decides.
  const windowStatus = await getMessagingWindowStatus(
    account.id,
    body.recipientId
  );
  if (windowStatus.state === "closed") {
    return NextResponse.json(
      {
        success: false,
        error: `The 24-hour messaging window for this conversation closed (last interaction ${windowStatus.lastInteractionAt?.toISOString() ?? "unknown"}). Instagram only allows a reply within 24 hours of the person's last message — wait for them to message again.`,
      },
      { status: 409 }
    );
  }

  // Manual replies draw from the same hourly per-account budget the worker
  // respects (750 DMs/hour), so a busy inbox cannot push the account over
  // Meta's cap. No requeue here — this is a synchronous user action, so a
  // full budget is a 429 the UI can surface.
  let rateLimit: RateLimitResult;
  try {
    rateLimit = await reserveDMSlot(account.instagramId);
  } catch (error) {
    console.error("[Conversations] Rate limiter unavailable:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Could not check the Instagram DM rate limit. Try again in a moment.",
      },
      { status: 503 }
    );
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: "Instagram's hourly DM limit for this account is reached. Try again once the hour rolls over.",
      },
      { status: 429 }
    );
  }

  try {
    const accessToken = await createInstagramContext(account);
    const result = await sendDirectMessage({
      context: accessToken,
      instagramAccountId: account.instagramId,
      userId: body.recipientId,
      message: text,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    // A confirmed rejection proves nothing was delivered, so the reserved
    // slot is handed back. An unconfirmed send may have delivered, so its
    // slot stays counted.
    if (isConfirmedSendRejection(err) && rateLimit.reserved)
      await releaseDMSlot(account.instagramId).catch(() => {});
    console.error("[Conversations] Send error:", err);
    // Surface Meta's own message — the common case is the 24-hour messaging
    // window having closed, which the user needs to see explicitly.
    const message =
      err instanceof MetaApiError ? err.message : "Failed to send message";
    return NextResponse.json(
      { success: false, error: message },
      { status: 502 }
    );
  }
}
