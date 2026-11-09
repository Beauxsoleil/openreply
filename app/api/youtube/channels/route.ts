import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const channels = await prisma.youTubeChannel.findMany({
    where: { workspaceId: context.workspaceId },
    select: { id: true, channelId: true, title: true, thumbnailUrl: true, connectedAt: true },
    orderBy: { connectedAt: "asc" },
  });
  return NextResponse.json({ success: true, data: channels });
}

export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "Channel id is required" }, { status: 400 });
  const channel = await prisma.youTubeChannel.findFirst({ where: { id, workspaceId: context.workspaceId } });
  if (!channel) return NextResponse.json({ success: false, error: "Channel not found" }, { status: 404 });
  const activePosts = await prisma.scheduledPost.count({
    where: { youtubeChannelId: id, status: { in: ["SCHEDULED", "PREPARING", "PUBLISHING", "RECONCILE_REQUIRED"] } },
  });
  if (activePosts) return NextResponse.json({ success: false, error: "Cancel or resolve scheduled YouTube posts before disconnecting this channel" }, { status: 409 });
  await prisma.youTubeChannel.delete({ where: { id } });
  return NextResponse.json({ success: true, data: { id } });
}
