import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { encryptToken } from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";
import { getCurrentYouTubeChannel } from "@/lib/youtube/client";
import { exchangeYouTubeCode, verifyOAuthState, YOUTUBE_SCOPES } from "@/lib/youtube/oauth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl();
  if (request.nextUrl.searchParams.get("error")) {
    return NextResponse.redirect(`${baseUrl}/publishing?youtube=denied`);
  }
  const code = request.nextUrl.searchParams.get("code");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  if (!code || !state) return NextResponse.redirect(`${baseUrl}/publishing?youtube=invalid`);
  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(`${baseUrl}/login`);
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/publishing?youtube=forbidden`);
  }
  try {
    const tokens = await exchangeYouTubeCode(code, `${baseUrl}/api/youtube/callback`);
    if (!tokens.refresh_token) {
      throw new Error("Google did not return an offline refresh token; revoke access and connect again");
    }
    const channel = await getCurrentYouTubeChannel(tokens.access_token);
    const existing = await prisma.youTubeChannel.findUnique({ where: { channelId: channel.channelId } });
    if (existing && existing.workspaceId !== state.workspaceId) {
      return NextResponse.redirect(`${baseUrl}/publishing?youtube=already_connected`);
    }
    await prisma.youTubeChannel.upsert({
      where: { channelId: channel.channelId },
      create: {
        ...channel,
        workspaceId: state.workspaceId,
        accessToken: encryptToken(tokens.access_token),
        refreshToken: encryptToken(tokens.refresh_token),
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scope: tokens.scope ?? YOUTUBE_SCOPES.join(" "),
      },
      update: {
        ...channel,
        accessToken: encryptToken(tokens.access_token),
        refreshToken: encryptToken(tokens.refresh_token),
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scope: tokens.scope ?? YOUTUBE_SCOPES.join(" "),
      },
    });
    return NextResponse.redirect(`${baseUrl}/publishing?youtube=connected`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error";
    await prisma.operationalEvent.create({ data: {
      workspaceId: state.workspaceId, source: "SYSTEM", level: "ERROR",
      message: "YouTube connection failed", payload: { reason: reason.slice(0, 500) },
    } }).catch(() => {});
    return NextResponse.redirect(`${baseUrl}/publishing?youtube=failed&reason=${encodeURIComponent(reason.slice(0, 200))}`);
  }
}
