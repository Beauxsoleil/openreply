import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { validateSchedule } from "@/lib/publishing/validation";
import { cancelPublish, enqueuePublish } from "@/lib/queue/publishing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const postSelect = {
  id: true,
  caption: true,
  kind: true,
  status: true,
  scheduledAt: true,
  timezone: true,
  publishedAt: true,
  instagramMediaId: true,
  containerId: true,
  lastError: true,
  attemptCount: true,
  automationId: true,
  automationActivateOnPublish: true,
  createdAt: true,
  updatedAt: true,
  mediaAsset: {
    select: {
      id: true,
      mimeType: true,
      originalName: true,
      width: true,
      height: true,
      durationSec: true,
      byteSize: true,
    },
  },
  instagramAccount: { select: { id: true, username: true } },
} as const;

/** byteSize is a BigInt in Prisma — JSON cannot carry it, so serialize as Number. */
function serializePost(post: Record<string, unknown>) {
  const { mediaAsset, ...rest } = post;
  const asset = mediaAsset as Record<string, unknown> | null;
  return {
    ...rest,
    mediaAsset: asset
      ? { ...asset, byteSize: Number(asset.byteSize as bigint) }
      : asset,
  };
}

async function loadPost(id: string, workspaceId: string) {
  return prisma.scheduledPost.findFirst({
    where: { id, workspaceId },
    select: postSelect,
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const post = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId: context.workspaceId },
    select: {
      ...postSelect,
      attempts: {
        select: { id: true, startedAt: true, finishedAt: true, outcome: true, errorCode: true },
        orderBy: { startedAt: "asc" },
      },
    },
  });
  if (!post) return NextResponse.json({ success: false, error: "Post not found" }, { status: 404 });
  return NextResponse.json({ success: true, data: serializePost(post as unknown as Record<string, unknown>) });
}

const patchBody = z.object({
  caption: z.string().max(2200).optional(),
  automationId: z.string().min(1).nullable().optional(),
  automationActivateOnPublish: z.boolean().optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  timezone: z.string().min(1).max(100).optional(),
  status: z.enum(["CANCELED"]).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid post update", issues: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;
  const post = await loadPost(id, context.workspaceId);
  if (!post) return NextResponse.json({ success: false, error: "Post not found" }, { status: 404 });

  // Cancel: SCHEDULED -> CANCELED, dropping the queued job.
  if (input.status === "CANCELED") {
    if (post.status !== "SCHEDULED") {
      return NextResponse.json({ success: false, error: `Cannot cancel a post in status ${post.status}` }, { status: 409 });
    }
    await cancelPublish(post.id);
    const updated = await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { status: "CANCELED", leaseUntil: null },
      select: postSelect,
    });
    return NextResponse.json({ success: true, data: serializePost(updated as unknown as Record<string, unknown>) });
  }

  // Reschedule: DRAFT/SCHEDULED/FAILED -> SCHEDULED at the new time.
  if (input.scheduledAt !== undefined || input.timezone !== undefined) {
    if (post.status !== "DRAFT" && post.status !== "SCHEDULED" && post.status !== "FAILED") {
      return NextResponse.json({ success: false, error: `Cannot reschedule a post in status ${post.status}` }, { status: 409 });
    }
    if (!input.scheduledAt) {
      return NextResponse.json({ success: false, error: "scheduledAt is required to reschedule" }, { status: 400 });
    }
    const timezone = input.timezone ?? post.timezone;
    const scheduleError = validateSchedule({
      instagramAccountId: post.instagramAccount.id,
      mediaAssetId: post.mediaAsset.id,
      kind: post.kind,
      caption: post.caption,
      scheduledAt: input.scheduledAt,
      timezone,
    });
    if (scheduleError) return NextResponse.json({ success: false, error: scheduleError }, { status: 400 });
    // Same publishable-format guard as POST: Meta takes JPEG only for feed
    // images and MP4/MOV only for Reels, and v1 has no server-side
    // conversion — a post whose asset cannot publish must not be scheduled.
    if (post.kind === "IMAGE" && post.mediaAsset.mimeType !== "image/jpeg") {
      return NextResponse.json({ success: false, error: `Only JPEG images can be published as Instagram feed posts (this asset is ${post.mediaAsset.mimeType}). Re-upload it as JPEG.` }, { status: 400 });
    }
    if (post.kind === "REEL" && post.mediaAsset.mimeType !== "video/mp4" && post.mediaAsset.mimeType !== "video/quicktime") {
      return NextResponse.json({ success: false, error: `Only MP4 or MOV videos can be published as Instagram Reels (this asset is ${post.mediaAsset.mimeType}). Re-upload it as MP4 or MOV.` }, { status: 400 });
    }
    const scheduledAt = new Date(input.scheduledAt);
    const updated = await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { scheduledAt, timezone, status: "SCHEDULED", lastError: null, leaseUntil: null },
      select: postSelect,
    });
    await enqueuePublish(post.id, scheduledAt);
    return NextResponse.json({ success: true, data: serializePost(updated as unknown as Record<string, unknown>) });
  }

  // Edit caption / automation link: DRAFT only.
  if (
    input.caption === undefined &&
    input.automationId === undefined &&
    input.automationActivateOnPublish === undefined
  ) {
    return NextResponse.json({ success: false, error: "No updatable fields" }, { status: 400 });
  }
  if (post.status !== "DRAFT") {
    return NextResponse.json({ success: false, error: `Cannot edit a post in status ${post.status}` }, { status: 409 });
  }
  if (input.automationActivateOnPublish && input.automationId === null) {
    return NextResponse.json({ success: false, error: "automationActivateOnPublish requires automationId" }, { status: 400 });
  }
  if (input.automationId) {
    const automation = await prisma.automation.findFirst({
      where: { id: input.automationId, workspaceId: context.workspaceId, instagramAccountId: post.instagramAccount.id },
      select: { id: true },
    });
    if (!automation) return NextResponse.json({ success: false, error: "Automation not found for this workspace and account" }, { status: 400 });
  }
  const updated = await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      ...(input.caption !== undefined ? { caption: input.caption } : {}),
      ...(input.automationId !== undefined ? { automationId: input.automationId } : {}),
      ...(input.automationActivateOnPublish !== undefined
        ? { automationActivateOnPublish: input.automationActivateOnPublish }
        : input.automationId === null
          ? { automationActivateOnPublish: false }
          : {}),
    },
    select: postSelect,
  });
  return NextResponse.json({ success: true, data: serializePost(updated as unknown as Record<string, unknown>) });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const post = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId: context.workspaceId },
    select: { id: true, status: true },
  });
  if (!post) return NextResponse.json({ success: false, error: "Post not found" }, { status: 404 });
  if (post.status !== "DRAFT" && post.status !== "CANCELED" && post.status !== "FAILED") {
    return NextResponse.json({ success: false, error: `Cannot delete a post in status ${post.status}` }, { status: 409 });
  }
  await cancelPublish(post.id);
  await prisma.scheduledPost.delete({ where: { id: post.id } });
  return NextResponse.json({ success: true, data: { id: post.id } });
}
