import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockPrisma,
  mockGetCurrentWorkspaceId,
  mockGetCurrentWorkspaceContext,
  mockR2,
} = vi.hoisted(() => {
  const mockPrisma = {
    mediaAsset: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    scheduledPost: {
      findFirst: vi.fn(),
    },
  };
  const mockR2 = {
    isPublishingStorageConfigured: vi.fn(),
    putMediaUploadUrl: vi.fn(),
    getMediaObject: vi.fn(),
    deleteMediaObject: vi.fn(),
    getMediaDeliveryUrl: vi.fn(),
    mediaStorageKey: vi.fn(
      (workspaceId: string, assetId: string, extension: string) =>
        `publishing/${workspaceId}/${assetId}.${extension}`
    ),
  };
  return {
    mockPrisma,
    mockGetCurrentWorkspaceId: vi.fn(),
    mockGetCurrentWorkspaceContext: vi.fn(),
    mockR2,
  };
});

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: mockGetCurrentWorkspaceId,
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockGetCurrentWorkspaceContext,
  canManageWorkspace: (role: string) => role === "ADMIN" || role === "OWNER",
}));

vi.mock("@/lib/publishing/r2", () => mockR2);

import { POST as postUploadUrl } from "../app/api/publishing/media/upload-url/route";
import { POST as postConfirm } from "../app/api/publishing/media/confirm/route";
import { GET as listMedia } from "../app/api/publishing/media/route";
import {
  DELETE as deleteMedia,
  GET as getMedia,
} from "../app/api/publishing/media/[id]/route";

const WORKSPACE_ID = "ws_1";
const ADMIN_CONTEXT = {
  userId: "user_1",
  workspaceId: WORKSPACE_ID,
  workspace: { id: WORKSPACE_ID },
  role: "ADMIN" as const,
};
const MEMBER_CONTEXT = { ...ADMIN_CONTEXT, role: "MEMBER" as const };

const assetRow = {
  id: "asset_1",
  workspaceId: WORKSPACE_ID,
  storageKey: `publishing/${WORKSPACE_ID}/asset_1.jpg`,
  originalName: "photo.jpg",
  mimeType: "image/jpeg",
  byteSize: BigInt(12345),
  width: 1080,
  height: 1350,
  durationSec: null,
  createdAt: new Date("2026-11-07T10:00:00Z"),
};

function request(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function pngBuffer(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Buffer.alloc(4),
  ]);
}

describe("POST /api/publishing/media/upload-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceContext.mockResolvedValue(ADMIN_CONTEXT);
    mockR2.isPublishingStorageConfigured.mockReturnValue(true);
    mockR2.putMediaUploadUrl.mockResolvedValue("https://r2.test/presigned-put");
  });

  const validBody = {
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    byteSize: 12345,
    kind: "IMAGE",
  };

  it("returns a presigned PUT URL and a workspace-scoped storage key", async () => {
    const res = await postUploadUrl(request("https://example.com/api/publishing/media/upload-url", validBody));
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);
    expect(payload.data.uploadUrl).toBe("https://r2.test/presigned-put");
    expect(payload.data.storageKey).toMatch(/^publishing\/ws_1\/.+\.jpg$/);
    expect(payload.data.expiresIn).toBe(900);
    expect(mockR2.putMediaUploadUrl).toHaveBeenCalledWith(
      expect.stringContaining(`publishing/${WORKSPACE_ID}/`),
      "image/jpeg",
      900
    );
    // No MediaAsset row is created at this step.
    expect(mockPrisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("returns 401 without a workspace", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(null);
    const res = await postUploadUrl(request("https://example.com/api/publishing/media/upload-url", validBody));
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
  });

  it("returns 403 for a MEMBER role", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(MEMBER_CONTEXT);
    const res = await postUploadUrl(request("https://example.com/api/publishing/media/upload-url", validBody));
    expect(res.status).toBe(403);
  });

  it("returns 400 for an unsupported MIME type", async () => {
    const res = await postUploadUrl(
      request("https://example.com/api/publishing/media/upload-url", {
        ...validBody,
        mimeType: "image/gif",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unsupported media type/);
  });

  it("returns 400 for a byte size over Meta's cap", async () => {
    const res = await postUploadUrl(
      request("https://example.com/api/publishing/media/upload-url", {
        ...validBody,
        byteSize: 8_000_001,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exceeds the 8 MB limit/);
  });

  it("returns 503 when R2 is unconfigured", async () => {
    mockR2.isPublishingStorageConfigured.mockReturnValue(false);
    const res = await postUploadUrl(request("https://example.com/api/publishing/media/upload-url", validBody));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured/);
    expect(mockR2.putMediaUploadUrl).not.toHaveBeenCalled();
  });
});

describe("POST /api/publishing/media/confirm", () => {
  const png = pngBuffer(1080, 1350);
  const validBody = {
    storageKey: `publishing/${WORKSPACE_ID}/asset_1.png`,
    originalName: "photo.png",
    mimeType: "image/png",
    byteSize: png.length,
    kind: "IMAGE",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceContext.mockResolvedValue(ADMIN_CONTEXT);
    mockR2.isPublishingStorageConfigured.mockReturnValue(true);
    mockR2.getMediaObject.mockResolvedValue(png);
    mockR2.deleteMediaObject.mockResolvedValue(undefined);
    mockPrisma.mediaAsset.create.mockResolvedValue({
      ...assetRow,
      storageKey: validBody.storageKey,
      mimeType: "image/png",
      byteSize: BigInt(png.length),
    });
  });

  it("validates the real bytes and creates the asset with byteSize as a Number", async () => {
    const res = await postConfirm(request("https://example.com/api/publishing/media/confirm", validBody));
    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload.success).toBe(true);
    expect(payload.data.byteSize).toBe(png.length);
    expect(typeof payload.data.byteSize).toBe("number");
    expect(payload.data.width).toBe(1080);
    expect(payload.data.height).toBe(1350);
    expect(mockPrisma.mediaAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          storageKey: validBody.storageKey,
          byteSize: BigInt(png.length),
        }),
      })
    );
  });

  it("returns 401 without a workspace and 403 for a MEMBER role", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(null);
    expect(
      (await postConfirm(request("https://example.com/api/publishing/media/confirm", validBody))).status
    ).toBe(401);
    mockGetCurrentWorkspaceContext.mockResolvedValue(MEMBER_CONTEXT);
    expect(
      (await postConfirm(request("https://example.com/api/publishing/media/confirm", validBody))).status
    ).toBe(403);
  });

  it("returns 404 for a storage key outside this workspace", async () => {
    const res = await postConfirm(
      request("https://example.com/api/publishing/media/confirm", {
        ...validBody,
        storageKey: "publishing/ws_other/asset_1.png",
      })
    );
    expect(res.status).toBe(404);
    expect(mockR2.getMediaObject).not.toHaveBeenCalled();
  });

  it("returns 503 when R2 is unconfigured", async () => {
    mockR2.isPublishingStorageConfigured.mockReturnValue(false);
    const res = await postConfirm(request("https://example.com/api/publishing/media/confirm", validBody));
    expect(res.status).toBe(503);
    expect(mockR2.getMediaObject).not.toHaveBeenCalled();
  });

  it("returns 404 when the uploaded object is not in R2", async () => {
    const notFound = new Error("No such key");
    notFound.name = "NoSuchKey";
    mockR2.getMediaObject.mockRejectedValue(notFound);
    const res = await postConfirm(request("https://example.com/api/publishing/media/confirm", validBody));
    expect(res.status).toBe(404);
    expect(mockPrisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("deletes the object and returns 400 when the real bytes fail validation", async () => {
    const garbage = Buffer.from("not an image at all");
    mockR2.getMediaObject.mockResolvedValue(garbage);
    const res = await postConfirm(
      request("https://example.com/api/publishing/media/confirm", {
        ...validBody,
        byteSize: garbage.length,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unrecognized file format/);
    expect(mockR2.deleteMediaObject).toHaveBeenCalledWith(validBody.storageKey);
    expect(mockPrisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("deletes the object and returns 400 when the fetched size disagrees", async () => {
    const res = await postConfirm(
      request("https://example.com/api/publishing/media/confirm", {
        ...validBody,
        byteSize: png.length + 10,
      })
    );
    expect(res.status).toBe(400);
    expect(mockR2.deleteMediaObject).toHaveBeenCalledWith(validBody.storageKey);
    expect(mockPrisma.mediaAsset.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/publishing/media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID);
    mockR2.isPublishingStorageConfigured.mockReturnValue(true);
    mockR2.getMediaDeliveryUrl.mockResolvedValue("https://r2.test/presigned-get");
    mockPrisma.mediaAsset.findMany.mockResolvedValue([assetRow]);
  });

  it("lists workspace assets newest first with a fresh previewUrl and numeric byteSize", async () => {
    const res = await listMedia(request("https://example.com/api/publishing/media"));
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({
      id: "asset_1",
      byteSize: 12345,
      previewUrl: "https://r2.test/presigned-get",
    });
    expect(typeof payload.data[0].byteSize).toBe("number");
    expect(mockPrisma.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: WORKSPACE_ID }),
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("passes kind and q filters through to the query", async () => {
    await listMedia(request("https://example.com/api/publishing/media?kind=REEL&q=beach&take=10"));
    const where = mockPrisma.mediaAsset.findMany.mock.calls[0][0].where;
    expect(where.mimeType).toEqual({ startsWith: "video/" });
    expect(where.originalName).toEqual({ contains: "beach", mode: "insensitive" });
    expect(mockPrisma.mediaAsset.findMany.mock.calls[0][0].take).toBe(10);
  });

  it("returns 401 without a workspace", async () => {
    mockGetCurrentWorkspaceId.mockResolvedValue(null);
    const res = await listMedia(request("https://example.com/api/publishing/media"));
    expect(res.status).toBe(401);
  });

  it("returns a null previewUrl when storage is unconfigured", async () => {
    mockR2.isPublishingStorageConfigured.mockReturnValue(false);
    const res = await listMedia(request("https://example.com/api/publishing/media"));
    expect((await res.json()).data[0].previewUrl).toBeNull();
  });
});

describe("GET /api/publishing/media/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID);
    mockR2.isPublishingStorageConfigured.mockReturnValue(true);
    mockR2.getMediaDeliveryUrl.mockResolvedValue("https://r2.test/presigned-get");
    mockPrisma.mediaAsset.findFirst.mockResolvedValue(assetRow);
  });

  function detailRequest(id: string) {
    return new NextRequest(`https://example.com/api/publishing/media/${id}`);
  }

  it("returns the asset with a fresh previewUrl", async () => {
    const res = await getMedia(detailRequest("asset_1"), {
      params: Promise.resolve({ id: "asset_1" }),
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data).toMatchObject({
      id: "asset_1",
      byteSize: 12345,
      previewUrl: "https://r2.test/presigned-get",
    });
    expect(mockPrisma.mediaAsset.findFirst).toHaveBeenCalledWith({
      where: { id: "asset_1", workspaceId: WORKSPACE_ID },
    });
  });

  it("returns 404 for a cross-workspace asset", async () => {
    mockPrisma.mediaAsset.findFirst.mockResolvedValue(null);
    const res = await getMedia(detailRequest("asset_1"), {
      params: Promise.resolve({ id: "asset_1" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).success).toBe(false);
  });

  it("returns 401 without a workspace", async () => {
    mockGetCurrentWorkspaceId.mockResolvedValue(null);
    const res = await getMedia(detailRequest("asset_1"), {
      params: Promise.resolve({ id: "asset_1" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/publishing/media/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceContext.mockResolvedValue(ADMIN_CONTEXT);
    mockR2.deleteMediaObject.mockResolvedValue(undefined);
    mockPrisma.mediaAsset.findFirst.mockResolvedValue(assetRow);
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(null);
    mockPrisma.mediaAsset.delete.mockResolvedValue(assetRow);
  });

  function deleteRequest(id: string) {
    return new NextRequest(`https://example.com/api/publishing/media/${id}`, {
      method: "DELETE",
    });
  }

  it("deletes the R2 object then the row", async () => {
    const res = await deleteMedia(deleteRequest("asset_1"), {
      params: Promise.resolve({ id: "asset_1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: "asset_1" });
    expect(mockR2.deleteMediaObject).toHaveBeenCalledWith(assetRow.storageKey);
    expect(mockPrisma.mediaAsset.delete).toHaveBeenCalledWith({ where: { id: "asset_1" } });
  });

  it("only blocks deletion for non-CANCELED posts", async () => {
    await deleteMedia(deleteRequest("asset_1"), {
      params: Promise.resolve({ id: "asset_1" }),
    });
    expect(mockPrisma.scheduledPost.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mediaAssetId: "asset_1", status: { not: "CANCELED" } },
      })
    );
  });

  it("returns 409 when a live scheduled post references the asset", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue({ id: "post_1" });
    const res = await deleteMedia(deleteRequest("asset_1"), {
      params: Promise.resolve({ id: "asset_1" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/scheduled post/);
    expect(mockR2.deleteMediaObject).not.toHaveBeenCalled();
    expect(mockPrisma.mediaAsset.delete).not.toHaveBeenCalled();
  });

  it("tolerates a missing R2 object and still deletes the row", async () => {
    const notFound = new Error("No such key");
    notFound.name = "NoSuchKey";
    mockR2.deleteMediaObject.mockRejectedValue(notFound);
    const res = await deleteMedia(deleteRequest("asset_1"), {
      params: Promise.resolve({ id: "asset_1" }),
    });
    expect(res.status).toBe(200);
    expect(mockPrisma.mediaAsset.delete).toHaveBeenCalled();
  });

  it("returns 401 without a workspace, 403 for a MEMBER, 404 cross-workspace", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(null);
    expect(
      (await deleteMedia(deleteRequest("asset_1"), { params: Promise.resolve({ id: "asset_1" }) })).status
    ).toBe(401);
    mockGetCurrentWorkspaceContext.mockResolvedValue(MEMBER_CONTEXT);
    expect(
      (await deleteMedia(deleteRequest("asset_1"), { params: Promise.resolve({ id: "asset_1" }) })).status
    ).toBe(403);
    mockGetCurrentWorkspaceContext.mockResolvedValue(ADMIN_CONTEXT);
    mockPrisma.mediaAsset.findFirst.mockResolvedValue(null);
    expect(
      (await deleteMedia(deleteRequest("asset_1"), { params: Promise.resolve({ id: "asset_1" }) })).status
    ).toBe(404);
  });
});
