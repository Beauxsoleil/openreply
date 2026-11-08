import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockPrisma,
  mockGetCurrentWorkspaceContext,
  mockEnqueuePublish,
  mockCancelPublish,
} = vi.hoisted(() => ({
  mockPrisma: {
    scheduledPost: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    instagramAccount: { findFirst: vi.fn() },
    mediaAsset: { findFirst: vi.fn() },
    automation: { findFirst: vi.fn() },
  },
  mockGetCurrentWorkspaceContext: vi.fn(),
  mockEnqueuePublish: vi.fn(),
  mockCancelPublish: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: vi.fn() }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockGetCurrentWorkspaceContext,
  canManageWorkspace: (role: string) => role === "ADMIN" || role === "OWNER",
}));
vi.mock("@/lib/queue/publishing", () => ({
  enqueuePublish: mockEnqueuePublish,
  cancelPublish: mockCancelPublish,
}));

import { GET as getPost, PATCH as patchPost, DELETE as deletePost } from "../app/api/publishing/posts/[id]/route";
import { POST as retryPost } from "../app/api/publishing/posts/[id]/retry/route";
import { POST as createPost } from "../app/api/publishing/posts/route";

const ADMIN_CONTEXT = {
  userId: "user_1",
  workspaceId: "ws_1",
  workspace: { id: "ws_1", name: "Workspace" },
  role: "ADMIN",
};

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post_1",
    caption: "Hi",
    kind: "IMAGE",
    status: "DRAFT",
    scheduledAt: null,
    timezone: "UTC",
    publishedAt: null,
    instagramMediaId: null,
    containerId: null,
    lastError: null,
    attemptCount: 0,
    automationId: null,
    automationActivateOnPublish: false,
    createdAt: new Date("2026-11-07T10:00:00Z"),
    updatedAt: new Date("2026-11-07T10:00:00Z"),
    mediaAsset: {
      id: "asset_1",
      mimeType: "image/jpeg",
      originalName: "photo.jpg",
      width: 1080,
      height: 1350,
      durationSec: null,
      byteSize: BigInt(123456),
    },
    instagramAccount: { id: "acct_1", username: "brand" },
    ...overrides,
  };
}

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(url, init);
}

function params(id = "post_1") {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/publishing/posts/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceContext.mockResolvedValue(ADMIN_CONTEXT);
    mockPrisma.scheduledPost.findFirst.mockResolvedValue({
      ...postRow(),
      attempts: [
        {
          id: "att_1",
          startedAt: new Date("2026-11-07T10:00:00Z"),
          finishedAt: new Date("2026-11-07T10:01:00Z"),
          outcome: "FAILED",
          errorCode: "100",
        },
      ],
    });
  });

  it("returns the post with attempts and byteSize as a number", async () => {
    const res = await getPost(request("https://example.com/api/publishing/posts/post_1"), params());
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.id).toBe("post_1");
    expect(payload.data.mediaAsset.byteSize).toBe(123456);
    expect(typeof payload.data.mediaAsset.byteSize).toBe("number");
    expect(payload.data.instagramAccount.username).toBe("brand");
    expect(payload.data.attempts).toHaveLength(1);
    expect(payload.data.attempts[0].outcome).toBe("FAILED");
    expect(mockPrisma.scheduledPost.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "post_1", workspaceId: "ws_1" },
      })
    );
  });

  it("returns 401 without a workspace context", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(null);
    const res = await getPost(request("https://example.com/api/publishing/posts/post_1"), params());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a MEMBER role", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue({ ...ADMIN_CONTEXT, role: "MEMBER" });
    const res = await getPost(request("https://example.com/api/publishing/posts/post_1"), params());
    expect(res.status).toBe(403);
  });

  it("returns 404 when the post belongs to another workspace", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(null);
    const res = await getPost(request("https://example.com/api/publishing/posts/post_1"), params());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});

describe("PATCH /api/publishing/posts/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceContext.mockResolvedValue(ADMIN_CONTEXT);
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(postRow());
    mockPrisma.scheduledPost.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      postRow(data)
    );
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "auto_1" });
  });

  function patch(body: unknown) {
    return request("https://example.com/api/publishing/posts/post_1", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  it("edits the caption of a DRAFT", async () => {
    const res = await patchPost(patch({ caption: "New caption" }), params());
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.data.caption).toBe("New caption");
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ caption: "New caption" }) })
    );
  });

  it("returns 409 when editing a SCHEDULED post's caption", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(
      postRow({ status: "SCHEDULED", scheduledAt: new Date("2026-11-08T10:00:00Z") })
    );
    const res = await patchPost(patch({ caption: "Nope" }), params());
    expect(res.status).toBe(409);
  });

  it("reschedules a DRAFT and enqueues the publish job", async () => {
    const res = await patchPost(
      patch({ scheduledAt: "2030-01-01T10:00:00Z", timezone: "America/Boise" }),
      params()
    );
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.data.status).toBe("SCHEDULED");
    expect(mockEnqueuePublish).toHaveBeenCalledWith(
      "post_1",
      new Date("2030-01-01T10:00:00Z")
    );
  });

  it("rejects a reschedule in the past with 400", async () => {
    const res = await patchPost(
      patch({ scheduledAt: "2020-01-01T10:00:00Z", timezone: "UTC" }),
      params()
    );
    expect(res.status).toBe(400);
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
  });

  it("rejects a reschedule with an invalid timezone with 400", async () => {
    const res = await patchPost(
      patch({ scheduledAt: "2030-01-01T10:00:00Z", timezone: "Mars/Olympus" }),
      params()
    );
    expect(res.status).toBe(400);
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
  });

  it("rejects rescheduling a post whose image asset is PNG with 400", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(
      postRow({
        mediaAsset: {
          id: "asset_1",
          mimeType: "image/png",
          originalName: "photo.png",
          width: 1080,
          height: 1350,
          durationSec: null,
          byteSize: BigInt(123456),
        },
      })
    );
    const res = await patchPost(
      patch({ scheduledAt: "2030-01-01T10:00:00Z", timezone: "UTC" }),
      params()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/JPEG/);
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
  });

  it("returns 409 when rescheduling a PUBLISHED post", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(postRow({ status: "PUBLISHED" }));
    const res = await patchPost(
      patch({ scheduledAt: "2030-01-01T10:00:00Z", timezone: "UTC" }),
      params()
    );
    expect(res.status).toBe(409);
  });

  it("cancels a SCHEDULED post and removes its queued job", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(
      postRow({ status: "SCHEDULED", scheduledAt: new Date("2030-01-01T10:00:00Z") })
    );
    const res = await patchPost(patch({ status: "CANCELED" }), params());
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.data.status).toBe("CANCELED");
    expect(mockCancelPublish).toHaveBeenCalledWith("post_1");
  });

  it("returns 409 when canceling a DRAFT", async () => {
    const res = await patchPost(patch({ status: "CANCELED" }), params());
    expect(res.status).toBe(409);
    expect(mockCancelPublish).not.toHaveBeenCalled();
  });

  it("rejects an automation from another workspace or account with 400", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    const res = await patchPost(patch({ automationId: "auto_other" }), params());
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/publishing/posts/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceContext.mockResolvedValue(ADMIN_CONTEXT);
  });

  it("deletes a DRAFT and removes its queued job", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(postRow({ status: "DRAFT" }));
    mockPrisma.scheduledPost.delete.mockResolvedValue(postRow());
    const res = await deletePost(
      request("https://example.com/api/publishing/posts/post_1", { method: "DELETE" }),
      params()
    );
    expect(res.status).toBe(200);
    expect(mockCancelPublish).toHaveBeenCalledWith("post_1");
    expect(mockPrisma.scheduledPost.delete).toHaveBeenCalledWith({ where: { id: "post_1" } });
  });

  it("returns 409 for a SCHEDULED post", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(postRow({ status: "SCHEDULED" }));
    const res = await deletePost(
      request("https://example.com/api/publishing/posts/post_1", { method: "DELETE" }),
      params()
    );
    expect(res.status).toBe(409);
    expect(mockPrisma.scheduledPost.delete).not.toHaveBeenCalled();
  });

  it("returns 404 cross-workspace", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(null);
    const res = await deletePost(
      request("https://example.com/api/publishing/posts/post_1", { method: "DELETE" }),
      params()
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/publishing/posts/[id]/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceContext.mockResolvedValue(ADMIN_CONTEXT);
    mockPrisma.scheduledPost.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "post_1",
      status: "SCHEDULED",
      scheduledAt: data.scheduledAt ?? new Date("2030-01-01T10:00:00Z"),
    }));
  });

  it("retries a FAILED post: SCHEDULED, lastError cleared, job enqueued", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(
      postRow({
        status: "FAILED",
        lastError: "boom",
        scheduledAt: new Date("2030-01-01T10:00:00Z"),
      })
    );
    const res = await retryPost(
      request("https://example.com/api/publishing/posts/post_1/retry", { method: "POST" }),
      params()
    );
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.data.status).toBe("SCHEDULED");
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SCHEDULED", lastError: null }),
      })
    );
    expect(mockEnqueuePublish).toHaveBeenCalledWith(
      "post_1",
      new Date("2030-01-01T10:00:00Z")
    );
  });

  it("returns 409 for a PUBLISHED post", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(postRow({ status: "PUBLISHED" }));
    const res = await retryPost(
      request("https://example.com/api/publishing/posts/post_1/retry", { method: "POST" }),
      params()
    );
    expect(res.status).toBe(409);
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
  });

  it("returns 409 for a SCHEDULED post", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(postRow({ status: "SCHEDULED" }));
    const res = await retryPost(
      request("https://example.com/api/publishing/posts/post_1/retry", { method: "POST" }),
      params()
    );
    expect(res.status).toBe(409);
  });
});

describe("POST /api/publishing/posts (create with scheduling)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentWorkspaceContext.mockResolvedValue(ADMIN_CONTEXT);
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acct_1", isDemo: false });
    mockPrisma.mediaAsset.findFirst.mockResolvedValue({ id: "asset_1", mimeType: "image/jpeg" });
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "auto_1" });
    mockPrisma.scheduledPost.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "post_1",
      status: data.status,
      scheduledAt: data.scheduledAt ?? null,
    }));
  });

  function create(body: unknown) {
    return request("https://example.com/api/publishing/posts", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  const base = {
    instagramAccountId: "acct_1",
    mediaAssetId: "asset_1",
    kind: "IMAGE",
    caption: "Hi",
    timezone: "UTC",
  };

  it("creates a SCHEDULED post and enqueues when scheduledAt is given", async () => {
    const res = await createPost(create({ ...base, scheduledAt: "2030-01-01T10:00:00Z" }));
    const payload = await res.json();
    expect(res.status).toBe(201);
    expect(payload.data.status).toBe("SCHEDULED");
    expect(mockEnqueuePublish).toHaveBeenCalledWith(
      "post_1",
      new Date("2030-01-01T10:00:00Z")
    );
  });

  it("creates a DRAFT without enqueue when no scheduledAt is given", async () => {
    const res = await createPost(create(base));
    const payload = await res.json();
    expect(res.status).toBe(201);
    expect(payload.data.status).toBe("DRAFT");
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
  });

  it("rejects an automation from another workspace or account with 400", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    const res = await createPost(
      create({ ...base, automationId: "auto_other", automationActivateOnPublish: true })
    );
    expect(res.status).toBe(400);
    expect(mockPrisma.scheduledPost.create).not.toHaveBeenCalled();
  });

  it("accepts a valid automation link at create", async () => {
    const res = await createPost(
      create({ ...base, automationId: "auto_1", automationActivateOnPublish: true })
    );
    expect(res.status).toBe(201);
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "auto_1", workspaceId: "ws_1", instagramAccountId: "acct_1" },
      })
    );
  });

  it("rejects an IMAGE post whose asset is PNG with 400", async () => {
    mockPrisma.mediaAsset.findFirst.mockResolvedValue({ id: "asset_1", mimeType: "image/png" });
    const res = await createPost(create({ ...base, scheduledAt: "2030-01-01T10:00:00Z" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/JPEG/);
    expect(mockPrisma.scheduledPost.create).not.toHaveBeenCalled();
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
  });

  it("rejects a REEL post whose asset is WebM with 400", async () => {
    mockPrisma.mediaAsset.findFirst.mockResolvedValue({ id: "asset_1", mimeType: "video/webm" });
    const res = await createPost(
      create({ ...base, kind: "REEL", scheduledAt: "2030-01-01T10:00:00Z" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/MP4 or MOV/);
    expect(mockPrisma.scheduledPost.create).not.toHaveBeenCalled();
  });

  it("accepts a REEL post whose asset is MOV", async () => {
    mockPrisma.mediaAsset.findFirst.mockResolvedValue({ id: "asset_1", mimeType: "video/quicktime" });
    const res = await createPost(
      create({ ...base, kind: "REEL", scheduledAt: "2030-01-01T10:00:00Z" })
    );
    const payload = await res.json();
    expect(res.status).toBe(201);
    expect(payload.data.status).toBe("SCHEDULED");
  });
});
