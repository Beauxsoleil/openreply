import { NextResponse } from "next/server";
import { getBaseUrl, getMissingYouTubeOAuthEnv } from "@/lib/env";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { createOAuthState, getYouTubeAuthorizationUrl } from "@/lib/youtube/oauth";

export const runtime = "nodejs";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.redirect(`${getBaseUrl()}/login`);
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/publishing?youtube=forbidden`);
  }
  const missing = getMissingYouTubeOAuthEnv();
  if (missing.length) {
    return NextResponse.redirect(`${getBaseUrl()}/publishing?youtube=misconfigured&missing=${encodeURIComponent(missing.join(","))}`);
  }
  const redirectUri = `${getBaseUrl()}/api/youtube/callback`;
  return NextResponse.redirect(getYouTubeAuthorizationUrl(redirectUri, createOAuthState(context.workspaceId)));
}
