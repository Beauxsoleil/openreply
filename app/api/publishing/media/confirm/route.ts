import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import {
  maxBytesForKind,
  validateMediaUpload,
  type MediaKind,
} from "@/lib/publishing/media-validation";
import {
  deleteMediaObject,
  getMediaObject,
  isPublishingStorageConfigured,
} from "@/lib/publishing/r2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const confirmInput = z.object({
  storageKey: z.string().min(1).max(500),
  originalName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  byteSize: z.number().int().positive(),
  kind: z.enum(["IMAGE", "REEL"]),
});

function isNoSuchKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "NoSuchKey"
  );
}

/**
 * Confirm a direct-to-R2 upload: fetch the object back from R2 and run the
 * real byte validation on it. A file that fails validation is deleted from
 * R2 and no MediaAsset row is created. Only a validated object becomes a
 * library asset.
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const parsed = confirmInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid confirm request", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const input = parsed.data;
  // A workspace may only confirm keys under its own prefix.
  if (!input.storageKey.startsWith(`publishing/${context.workspaceId}/`)) {
    return NextResponse.json({ success: false, error: "Media asset not found" }, { status: 404 });
  }
  if (!isPublishingStorageConfigured()) {
    return NextResponse.json(
      { success: false, error: "Publishing storage is not configured" },
      { status: 503 }
    );
  }

  let bytes: Buffer;
  try {
    bytes = await getMediaObject(input.storageKey, maxBytesForKind(input.kind as MediaKind));
  } catch (error) {
    if (isNoSuchKey(error)) {
      return NextResponse.json(
        { success: false, error: "Uploaded file not found in storage; upload again" },
        { status: 404 }
      );
    }
    throw error;
  }

  const fail = async (error: string, status = 400) => {
    // Never leave an invalid object lying around in the bucket.
    await deleteMediaObject(input.storageKey).catch(() => undefined);
    return NextResponse.json({ success: false, error }, { status });
  };

  if (bytes.length !== input.byteSize) {
    return fail(
      `Uploaded file is ${bytes.length} bytes, expected ${input.byteSize}; upload again`
    );
  }
  const validation = validateMediaUpload({
    buffer: bytes,
    mimeType: input.mimeType,
    kind: input.kind as MediaKind,
  });
  if (!validation.ok) return fail(validation.error);

  const asset = await prisma.mediaAsset.create({
    data: {
      workspaceId: context.workspaceId,
      storageKey: input.storageKey,
      originalName: input.originalName,
      mimeType: validation.mimeType,
      byteSize: BigInt(bytes.length),
      width: validation.width,
      height: validation.height,
      durationSec: validation.durationSec ?? null,
    },
  });
  return NextResponse.json(
    {
      success: true,
      data: {
        id: asset.id,
        workspaceId: asset.workspaceId,
        storageKey: asset.storageKey,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        byteSize: Number(asset.byteSize),
        width: asset.width,
        height: asset.height,
        durationSec: asset.durationSec,
        createdAt: asset.createdAt,
      },
    },
    { status: 201 }
  );
}
