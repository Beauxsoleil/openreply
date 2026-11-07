import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import {
  deleteMediaObject,
  getMediaDeliveryUrl,
  isPublishingStorageConfigured,
} from "@/lib/publishing/r2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PREVIEW_URL_EXPIRES_IN_SECONDS = 3600;

function serializeAsset(
  asset: {
    id: string;
    storageKey: string;
    originalName: string | null;
    mimeType: string;
    byteSize: bigint;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    createdAt: Date;
  },
  previewUrl: string | null
) {
  return {
    id: asset.id,
    storageKey: asset.storageKey,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    byteSize: Number(asset.byteSize),
    width: asset.width,
    height: asset.height,
    durationSec: asset.durationSec,
    createdAt: asset.createdAt,
    previewUrl,
  };
}

function isNoSuchKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "NoSuchKey"
  );
}

function isNotConfigured(error: unknown): boolean {
  return error instanceof Error && /not configured/i.test(error.message);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const asset = await prisma.mediaAsset.findFirst({ where: { id, workspaceId } });
  if (!asset) return NextResponse.json({ success: false, error: "Media asset not found" }, { status: 404 });
  const previewUrl = isPublishingStorageConfigured()
    ? await getMediaDeliveryUrl(asset.storageKey, PREVIEW_URL_EXPIRES_IN_SECONDS)
    : null;
  return NextResponse.json({ success: true, data: serializeAsset(asset, previewUrl) });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const asset = await prisma.mediaAsset.findFirst({
    where: { id, workspaceId: context.workspaceId },
  });
  if (!asset) return NextResponse.json({ success: false, error: "Media asset not found" }, { status: 404 });
  const inUse = await prisma.scheduledPost.findFirst({
    where: { mediaAssetId: asset.id, status: { not: "CANCELED" } },
    select: { id: true },
  });
  if (inUse) {
    return NextResponse.json(
      { success: false, error: "Media asset is used by a scheduled post" },
      { status: 409 }
    );
  }
  // Tolerate a missing R2 object (already deleted, or storage never set up):
  // the row still goes away.
  await deleteMediaObject(asset.storageKey).catch((error: unknown) => {
    if (isNoSuchKey(error) || isNotConfigured(error)) return;
    throw error;
  });
  await prisma.mediaAsset.delete({ where: { id: asset.id } });
  return NextResponse.json({ success: true, data: { id: asset.id } });
}
