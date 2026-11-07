import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/client";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import {
  getUserInfo,
  isProfessionalInstagramAccount,
  listAssignedInstagramAccounts,
  MetaApiError,
  PermissionError,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import { encryptToken } from "@/lib/meta/oauth";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * POST /api/instagram/unified-token
 *
 * Connect an Instagram account through Meta's Unified Login (Facebook
 * Login for Business). Newer Meta apps have no Instagram App ID, so the
 * Instagram Login authorize flow cannot run for them; instead the Meta
 * dashboard's Unified Login configuration issues a never-expiring
 * Business Integration system-user token, which the user pastes here.
 *
 * Body: { token: string, instagramId?: string }
 *
 * The token is verified before anything is stored: it is used to list the
 * Instagram accounts it covers on graph.facebook.com, the account is
 * resolved (username, follower count) and the professional-account rule
 * from the Instagram Login callback is applied — with account_type
 * absent on this host (it is not a field on graph.facebook.com's
 * Instagram node; see getUserInfo), the check fails open, which is safe
 * because Unified Login only issues tokens for professional accounts.
 * Then the account is subscribed to webhooks and the token is stored
 * encrypted with the workspace's existing ENCRYPTION_KEY.
 *
 * The token is write-only: it is never logged, never returned in a
 * response, and the Settings form clears the input after submit. A
 * system-user token never expires, so the stored row has
 * tokenExpiresAt: null and isUnifiedLogin: true; the refresh paths skip
 * such rows (see lib/meta/token-refresh.ts).
 */
export async function POST(request: NextRequest) {
  const workspaceContext = await getCurrentWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json(
      { success: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(workspaceContext.role)) {
    return NextResponse.json(
      { success: false, error: "forbidden" },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "invalid_request" },
      { status: 400 }
    );
  }

  const token =
    typeof body === "object" && body !== null && "token" in body
      ? (body as { token?: unknown }).token
      : undefined;
  const requestedInstagramId =
    typeof body === "object" && body !== null && "instagramId" in body
      ? (body as { instagramId?: unknown }).instagramId
      : undefined;

  if (typeof token !== "string" || token.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: "missing_token" },
      { status: 400 }
    );
  }

  if (
    requestedInstagramId !== undefined &&
    typeof requestedInstagramId !== "string"
  ) {
    return NextResponse.json(
      { success: false, error: "invalid_request" },
      { status: 400 }
    );
  }

  const trimmedToken = token.trim();

  try {
    // A system-user token's /me is the system user, not the Instagram
    // account, so the accounts it covers are listed through this edge.
    // Meta rejecting the token (bad token, revoked, wrong app) surfaces
    // here, before any database write.
    const assigned = await listAssignedInstagramAccounts(trimmedToken);

    if (assigned.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "no_instagram_accounts",
          message:
            "This token is not linked to any Instagram account. Generate the token from the Unified Login configuration for the Instagram account you want to connect.",
        },
        { status: 400 }
      );
    }

    let chosen = requestedInstagramId
      ? assigned.find((account) => account.id === requestedInstagramId)
      : undefined;

    if (requestedInstagramId && !chosen) {
      return NextResponse.json(
        {
          success: false,
          error: "account_not_found",
          message:
            "The selected account is not linked to this token. Pick one of the accounts this token covers.",
          accounts: assigned.map((account) => ({
            id: account.id,
            username: account.username,
          })),
        },
        { status: 400 }
      );
    }

    if (!chosen) {
      if (assigned.length > 1) {
        return NextResponse.json(
          {
            success: false,
            error: "multiple_accounts",
            message:
              "This token covers more than one Instagram account. Pick the account to connect.",
            accounts: assigned.map((account) => ({
              id: account.id,
              username: account.username,
            })),
          },
          { status: 400 }
        );
      }
      chosen = assigned[0];
    }

    // Resolve the account on graph.facebook.com: username and follower
    // count. account_type is deliberately NOT requested: it is not a
    // field on this host's Instagram node, and asking for it fails the
    // whole read with (#100) — see getUserInfo. The ID stored here is
    // the Instagram professional account ID (the same value webhooks
    // carry as entry.id); the Instagram internal user_igid is a
    // different number and is never used by the Graph API.
    const userInfo = await getUserInfo(trimmedToken, chosen.id, "facebook");

    if (!isProfessionalInstagramAccount(userInfo)) {
      return NextResponse.json(
        {
          success: false,
          error: "personal_account",
          message:
            "This Instagram account is a personal account. Switch it to a Business or Creator account first, then reconnect.",
        },
        { status: 400 }
      );
    }

    const instagramId = userInfo.user_id ?? chosen.id;

    const connectCheck = await canConnectInstagramAccount({
      workspaceId: workspaceContext.workspaceId,
      instagramId,
    });

    if (!connectCheck.allowed) {
      return NextResponse.json(
        { success: false, error: "already_connected" },
        { status: 400 }
      );
    }

    let webhookSubscribed = false;
    try {
      const subscribeResult = await subscribeInstagramAccountToWebhooks(
        instagramId,
        trimmedToken,
        "facebook"
      );
      webhookSubscribed = Boolean(subscribeResult.success);
    } catch (subscriptionError) {
      console.warn(
        "[Instagram Unified Token] Webhook subscription failed:",
        subscriptionError
      );
    }

    const account = await prisma.instagramAccount.upsert({
      where: { instagramId },
      update: {
        username: userInfo.username,
        name: userInfo.name ?? null,
        accessToken: encryptToken(trimmedToken),
        tokenExpiresAt: null,
        webhookSubscribed,
        provider: "META",
        workspaceId: workspaceContext.workspaceId,
        isUnifiedLogin: true,
      },
      create: {
        instagramId,
        username: userInfo.username,
        name: userInfo.name ?? null,
        accessToken: encryptToken(trimmedToken),
        tokenExpiresAt: null,
        webhookSubscribed,
        provider: "META",
        workspaceId: workspaceContext.workspaceId,
        isUnifiedLogin: true,
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
        webhookSubscribed: account.webhookSubscribed,
        isUnifiedLogin: true,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Instagram Unified Token] Error:", error);
    // Mirror the Instagram Login callback: persist the failure reason as
    // an operational event. Never include the token — the Meta error
    // message does not contain it, and nothing here logs it.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: workspaceContext.workspaceId,
          message: "Instagram Unified Login connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});

    if (error instanceof PermissionError || error instanceof MetaApiError) {
      return NextResponse.json(
        {
          success: false,
          error: "meta_error",
          message:
            "Meta rejected the token. Check that it was generated from the Unified Login configuration for this app and has not been revoked, then try again.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: false, error: "internal_error" },
      { status: 500 }
    );
  }
}
