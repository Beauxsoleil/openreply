import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { publishingInput, validateSchedule } from "@/lib/publishing/validation";

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
  const parsed = publishingInput.safeParse(body);
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid post input", issues: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;
  const scheduleError = validateSchedule(input);
  if (scheduleError) return NextResponse.json({ success: false, error: scheduleError }, { status: 400 });
  const [account, asset] = await Promise.all([
    prisma.instagramAccount.findFirst({ where: { id: input.instagramAccountId, workspaceId: context.workspaceId }, select: { id: true, isDemo: true } }),
    prisma.mediaAsset.findFirst({ where: { id: input.mediaAssetId, workspaceId: context.workspaceId }, select: { id: true, mimeType: true } }),
  ]);
  if (!account || !asset) return NextResponse.json({ success: false, error: "Account or media asset not found" }, { status: 404 });
  if (account.isDemo) return NextResponse.json({ success: false, error: "Demo accounts cannot publish" }, { status: 400 });
  if ((input.kind === "IMAGE" && !asset.mimeType.startsWith("image/")) || (input.kind === "REEL" && !asset.mimeType.startsWith("video/"))) {
    return NextResponse.json({ success: false, error: "Media type does not match post type" }, { status: 400 });
  }
  // Deliberately draft-only until the worker, permission checks and storage are deployed.
  const post = await prisma.scheduledPost.create({
    data: { workspaceId: context.workspaceId, instagramAccountId: account.id,
      mediaAssetId: asset.id, kind: input.kind, caption: input.caption,
      timezone: input.timezone, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      status: "DRAFT" },
    select: { id: true, status: true },
  });
  return NextResponse.json({ success: true, data: post }, { status: 201 });
}
