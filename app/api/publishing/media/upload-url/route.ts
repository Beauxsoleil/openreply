import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import {
  extensionForMimeType,
  validateUploadRequest,
} from "@/lib/publishing/media-validation";
import {
  isPublishingStorageConfigured,
  mediaStorageKey,
  putMediaUploadUrl,
} from "@/lib/publishing/r2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Presigned PUT URLs are valid 15 minutes: enough to start an upload. */
export const UPLOAD_URL_EXPIRES_IN_SECONDS = 900;

const uploadUrlInput = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  byteSize: z.number().int().positive(),
  kind: z.enum(["IMAGE", "REEL"]),
});

/**
 * Mint a presigned PUT URL so the browser uploads bytes straight to R2.
 * Vercel serverless request bodies cap at ~4.5 MB, so media bytes must
 * never flow through a Next.js route. No MediaAsset row is created here;
 * the client calls /confirm after the PUT succeeds.
 *
 * The R2 bucket needs a CORS rule allowing PUT from the app origin, or the
 * browser PUT is rejected by the browser before it reaches R2.
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const parsed = uploadUrlInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid upload request", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const input = parsed.data;
  const requestError = validateUploadRequest(input);
  if (requestError) {
    return NextResponse.json({ success: false, error: requestError }, { status: 400 });
  }
  if (!isPublishingStorageConfigured()) {
    return NextResponse.json(
      { success: false, error: "Publishing storage is not configured" },
      { status: 503 }
    );
  }
  const extension = extensionForMimeType(input.mimeType);
  if (!extension) {
    return NextResponse.json({ success: false, error: "Unsupported media type" }, { status: 400 });
  }
  const storageKey = mediaStorageKey(context.workspaceId, randomUUID(), extension);
  const uploadUrl = await putMediaUploadUrl(storageKey, input.mimeType, UPLOAD_URL_EXPIRES_IN_SECONDS);
  // Keep the row creation for /confirm: an abandoned PUT leaves an orphan
  // object, never an orphan row.
  return NextResponse.json({
    success: true,
    data: { uploadUrl, storageKey, expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS },
  });
}
