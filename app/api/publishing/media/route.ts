import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getMediaDeliveryUrl, isPublishingStorageConfigured } from "@/lib/publishing/r2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Preview URLs are short-lived; the UI re-lists (or re-fetches) for fresh ones. */
const PREVIEW_URL_EXPIRES_IN_SECONDS = 3600;
const DEFAULT_TAKE = 50;
const MAX_TAKE = 100;

type MediaAssetRow = {
  id: string;
  storageKey: string;
  originalName: string | null;
  mimeType: string;
  byteSize: bigint;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  createdAt: Date;
};

async function serializeAsset(asset: MediaAssetRow, storageConfigured: boolean) {
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
    previewUrl: storageConfigured
      ? await getMediaDeliveryUrl(asset.storageKey, PREVIEW_URL_EXPIRES_IN_SECONDS)
      : null,
  };
}

/**
 * Workspace-scoped media library, newest first. `kind` filters by media
 * family (IMAGE = image/*, REEL = video/*), `q` searches the original
 * filename, `take` caps the page (1-100, default 50).
 */
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const kind = params.get("kind");
  if (kind !== null && kind !== "IMAGE" && kind !== "REEL") {
    return NextResponse.json({ success: false, error: "Invalid kind" }, { status: 400 });
  }
  const q = params.get("q")?.trim() || undefined;
  const takeParam = Number(params.get("take"));
  const take = Number.isInteger(takeParam)
    ? Math.min(Math.max(takeParam, 1), MAX_TAKE)
    : DEFAULT_TAKE;
  const assets = await prisma.mediaAsset.findMany({
    where: {
      workspaceId,
      ...(kind === "IMAGE" ? { mimeType: { startsWith: "image/" } } : {}),
      ...(kind === "REEL" ? { mimeType: { startsWith: "video/" } } : {}),
      ...(q ? { originalName: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  const storageConfigured = isPublishingStorageConfigured();
  const data = await Promise.all(
    assets.map((asset: MediaAssetRow) => serializeAsset(asset, storageConfigured))
  );
  return NextResponse.json({ success: true, data });
}
