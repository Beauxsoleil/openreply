import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { publishingInput, validateSchedule } from "@/lib/publishing/validation";
import { enqueuePublish } from "@/lib/queue/publishing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const posts = await prisma.scheduledPost.findMany({
    where: { workspaceId },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true, caption: true, kind: true, status: true, scheduledAt: true,
      timezone: true, publishedAt: true, instagramMediaId: true, lastError: true,
      mediaAsset: { select: { id: true, mimeType: true } },
      instagramAccount: { select: { id: true, username: true } },
    },
  });
  return NextResponse.json({ success: true, data: posts });
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null);
  // Automation link fields ride on top of the base publishing input (which
  // lives in lib/publishing/validation.ts); they are optional at create.
  const parsed = publishingInput
    .extend({
      automationId: z.string().min(1).nullable().optional(),
      automationActivateOnPublish: z.boolean().optional(),
    })
    .safeParse(body);
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid post input", issues: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;
  const scheduleError = validateSchedule(input);
  if (scheduleError) return NextResponse.json({ success: false, error: scheduleError }, { status: 400 });
  if (input.automationActivateOnPublish && !input.automationId) {
    return NextResponse.json({ success: false, error: "automationActivateOnPublish requires automationId" }, { status: 400 });
  }
  const [account, asset] = await Promise.all([
    prisma.instagramAccount.findFirst({ where: { id: input.instagramAccountId, workspaceId: context.workspaceId }, select: { id: true, isDemo: true } }),
    prisma.mediaAsset.findFirst({ where: { id: input.mediaAssetId, workspaceId: context.workspaceId }, select: { id: true, mimeType: true } }),
  ]);
  if (!account || !asset) return NextResponse.json({ success: false, error: "Account or media asset not found" }, { status: 404 });
  if (account.isDemo) return NextResponse.json({ success: false, error: "Demo accounts cannot publish" }, { status: 400 });
  // Meta's Graph API takes JPEG ONLY for feed image posts and MP4/MOV
  // only for Reels. The media library accepts PNG/WebP uploads, but those
  // can never publish — there is no server-side conversion in v1 — so
  // reject here with a clear message instead of failing at publish time.
  if (input.kind === "IMAGE" && asset.mimeType !== "image/jpeg") {
    return NextResponse.json({ success: false, error: `Only JPEG images can be published as Instagram feed posts (this asset is ${asset.mimeType}). Re-upload it as JPEG.` }, { status: 400 });
  }
  if (input.kind === "REEL" && asset.mimeType !== "video/mp4" && asset.mimeType !== "video/quicktime") {
    return NextResponse.json({ success: false, error: `Only MP4 or MOV videos can be published as Instagram Reels (this asset is ${asset.mimeType}). Re-upload it as MP4 or MOV.` }, { status: 400 });
  }
  if (input.automationId) {
    const automation = await prisma.automation.findFirst({
      where: { id: input.automationId, workspaceId: context.workspaceId, instagramAccountId: account.id },
      select: { id: true },
    });
    if (!automation) return NextResponse.json({ success: false, error: "Automation not found for this workspace and account" }, { status: 400 });
  }
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  const post = await prisma.scheduledPost.create({
    data: { workspaceId: context.workspaceId, instagramAccountId: account.id,
      mediaAssetId: asset.id, kind: input.kind, caption: input.caption,
      timezone: input.timezone, scheduledAt,
      status: scheduledAt ? "SCHEDULED" : "DRAFT",
      automationId: input.automationId ?? null,
      automationActivateOnPublish: input.automationActivateOnPublish ?? false },
    select: { id: true, status: true, scheduledAt: true },
  });
  if (post.status === "SCHEDULED" && post.scheduledAt) {
    await enqueuePublish(post.id, post.scheduledAt);
  }
  return NextResponse.json({ success: true, data: post }, { status: 201 });
}
