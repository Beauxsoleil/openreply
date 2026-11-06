import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { isDemoMode } from "@/lib/env";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { renderMessageWithoutLink } from "@/lib/tracking/message";

// Simulated comments only exist in demo mode. Outside demo mode this route
// behaves as if it does not exist (404), so it can never be mistaken for a
// production endpoint.
export const dynamic = "force-dynamic";

const simulateSchema = z.object({
  campaignId: z.string().min(1),
  commentText: z.string().min(1).max(500),
  username: z
    .string()
    .min(1)
    .max(50)
    .transform((value) => value.trim().replace(/^@/, "")),
});

export async function POST(request: NextRequest) {
  if (!isDemoMode()) {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 }
    );
  }

  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const parsed = simulateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { campaignId, commentText, username } = parsed.data;

  const campaign = await prisma.automation.findUnique({
    where: { id: campaignId },
    include: {
      instagramAccount: { select: { id: true, username: true, isDemo: true } },
    },
  });
  if (!campaign || campaign.workspaceId !== workspaceId) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  // The REAL keyword matcher, run against the campaign's real keywords —
  // the only thing simulated here is the comment and the delivery.
  const matchResult = campaign.matchAnyWord
    ? { matched: true, matchedKeyword: null as string | null }
    : matchKeywords(commentText, campaign.keywords, campaign.wholeWordMatch);

  // The DM text that WOULD be sent. Rendered, never delivered: this route
  // does not enqueue anything to BullMQ and never calls any Meta client.
  const dmText = matchResult.matched
    ? renderMessageWithoutLink({
        message: campaign.dmMessage,
        commenterName: username,
      })
    : null;

  const log = await prisma.dmLog.create({
    data: {
      workspaceId,
      automationId: campaign.id,
      instagramAccountId: campaign.instagramAccountId,
      commenterId: `demo-${username}`,
      commenterName: username,
      commentText,
      // Unique per simulation so repeated simulations never collide.
      commentId: `demo-${randomUUID()}`,
      matchedKeyword: matchResult.matchedKeyword,
      status: matchResult.matched ? "SENT" : "SKIPPED_NO_MATCH",
      dmSentAt: matchResult.matched ? new Date() : null,
      isDemo: true,
    },
  });

  return NextResponse.json({
    success: true,
    data: {
      simulated: true,
      isDemo: true,
      matched: matchResult.matched,
      matchedKeyword: matchResult.matchedKeyword,
      dmText,
      campaignName: campaign.name,
      instagramUsername: campaign.instagramAccount.username,
      logId: log.id,
    },
  });
}
