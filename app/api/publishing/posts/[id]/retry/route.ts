import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { enqueuePublish } from "@/lib/queue/publishing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const post = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId: context.workspaceId },
    select: { id: true, status: true, scheduledAt: true },
  });
  if (!post) return NextResponse.json({ success: false, error: "Post not found" }, { status: 404 });
  if (post.status !== "FAILED") {
    return NextResponse.json({ success: false, error: `Cannot retry a post in status ${post.status}` }, { status: 409 });
  }
  const updated = await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "SCHEDULED", lastError: null, leaseUntil: null },
    select: { id: true, status: true, scheduledAt: true },
  });
  // Attempt history stays in PublishAttempt; only the post's lastError is cleared.
  await enqueuePublish(post.id, updated.scheduledAt ?? new Date());
  return NextResponse.json({ success: true, data: updated });
}
