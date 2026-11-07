import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "../lib/meta/client";

const {
  mockPrisma,
  mockMeta,
  mockGetMediaDeliveryUrl,
  mockDecryptToken,
} = vi.hoisted(() => ({
  mockPrisma: {
    scheduledPost: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    publishAttempt: { create: vi.fn(), update: vi.fn() },
    automation: { findUnique: vi.fn(), update: vi.fn() },
  },
  mockMeta: {
    checkPublishPermission: vi.fn(),
    createImageContainer: vi.fn(),
    createReelContainer: vi.fn(),
    getContainerStatus: vi.fn(),
    publishContainer: vi.fn(),
    getPublishedMedia: vi.fn(),
  },
  mockGetMediaDeliveryUrl: vi.fn(),
  mockDecryptToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/publishing", () => mockMeta);
vi.mock("@/lib/publishing/r2", () => ({
  getMediaDeliveryUrl: mockGetMediaDeliveryUrl,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

import { publishPost, reconcilePost } from "../lib/publishing/publisher";

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post_1",
    workspaceId: "ws_1",
    instagramAccountId: "acct_1",
    mediaAssetId: "asset_1",
    caption: "Hi",
    kind: "IMAGE",
    status: "SCHEDULED",
    scheduledAt: new Date("2026-11-07T10:00:00Z"),
    timezone: "UTC",
    publishedAt: null,
    instagramMediaId: null,
    containerId: null,
    lastError: null,
    attemptCount: 1,
    leaseUntil: null,
    automationId: null,
    automationActivateOnPublish: false,
    instagramAccount: {
      id: "acct_1",
      workspaceId: "ws_1",
      instagramId: "ig_123",
      username: "brand",
      isDemo: false,
      isUnifiedLogin: true,
      accessToken: "enc-token",
    },
    mediaAsset: {
      id: "asset_1",
      workspaceId: "ws_1",
      storageKey: "publishing/ws_1/asset_1.jpg",
      mimeType: "image/jpeg",
    },
    ...overrides,
  };
}

describe("publishPost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(postRow());
    mockPrisma.scheduledPost.update.mockResolvedValue({});
    mockPrisma.publishAttempt.create.mockResolvedValue({ id: "att_1" });
    mockDecryptToken.mockReturnValue("tok-plain");
    mockGetMediaDeliveryUrl.mockResolvedValue("https://cdn.example.test/photo.jpg");
    mockMeta.checkPublishPermission.mockResolvedValue({
      permission: "instagram_content_publish",
      scopes: ["instagram_content_publish"],
    });
    mockMeta.createImageContainer.mockResolvedValue({ id: "container_1" });
    mockMeta.createReelContainer.mockResolvedValue({ id: "container_1" });
    mockMeta.getContainerStatus.mockResolvedValue({
      id: "container_1",
      status: "FINISHED",
    });
    mockMeta.publishContainer.mockResolvedValue({ id: "media_1" });
    mockMeta.getPublishedMedia.mockResolvedValue({
      id: "media_1",
      permalink: "https://www.instagram.com/p/abc/",
      media_type: "IMAGE",
    });
    mockPrisma.automation.findUnique.mockResolvedValue(null);
    mockPrisma.automation.update.mockResolvedValue({});
  });

  it("publishes a due post end to end on the facebook host", async () => {
    const result = await publishPost("post_1", { pollIntervalMs: 1 });

    expect(result).toEqual({
      claimed: true,
      status: "PUBLISHED",
      postId: "post_1",
      instagramMediaId: "media_1",
    });
    // Atomic lease: SCHEDULED + due + no live lease -> PREPARING.
    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "post_1", status: "SCHEDULED" }),
        data: expect.objectContaining({ status: "PREPARING" }),
      })
    );
    expect(mockMeta.createImageContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        instagramAccountId: "ig_123",
        imageUrl: "https://cdn.example.test/photo.jpg",
        host: "facebook",
      })
    );
    expect(mockMeta.publishContainer).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: "container_1", host: "facebook" })
    );
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PUBLISHED",
          instagramMediaId: "media_1",
          publishedAt: expect.any(Date),
        }),
      })
    );
    // No tokens or signed URLs ever land in attempt details.
    for (const call of mockPrisma.publishAttempt.create.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("tok-plain");
      expect(JSON.stringify(call[0])).not.toContain("cdn.example.test");
    }
  });

  it("returns claimed:false when another worker holds the lease", async () => {
    mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 0 });
    const result = await publishPost("post_1");
    expect(result).toEqual({ claimed: false });
    expect(mockMeta.createImageContainer).not.toHaveBeenCalled();
    expect(mockPrisma.scheduledPost.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a demo account without calling Meta", async () => {
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      postRow({
        instagramAccount: {
          id: "acct_1",
          instagramId: "ig_123",
          isDemo: true,
          isUnifiedLogin: true,
          accessToken: "DEMO_NO_REAL_TOKEN",
        },
      })
    );
    const result = await publishPost("post_1");
    expect(result).toMatchObject({ status: "FAILED" });
    expect(mockDecryptToken).not.toHaveBeenCalled();
    expect(mockMeta.checkPublishPermission).not.toHaveBeenCalled();
    expect(mockMeta.createImageContainer).not.toHaveBeenCalled();
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError: "Demo accounts cannot publish",
        }),
      })
    );
  });

  it("marks FAILED (permanent) when the publish permission is missing", async () => {
    const { PermissionError } = await import("../lib/meta/client");
    mockMeta.checkPublishPermission.mockRejectedValue(
      new PermissionError("Token is missing the instagram_content_publish permission")
    );
    const result = await publishPost("post_1");
    expect(result).toMatchObject({ status: "FAILED" });
    expect(mockMeta.createImageContainer).not.toHaveBeenCalled();
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      })
    );
    const lastError = mockPrisma.scheduledPost.update.mock.calls
      .map((c) => (c[0] as { data: { lastError?: string } }).data.lastError)
      .find(Boolean);
    expect(lastError).toContain("instagram_content_publish");
  });

  it("marks FAILED when the container errors while processing", async () => {
    mockMeta.getContainerStatus.mockResolvedValue({
      id: "container_1",
      status: "ERROR",
    });
    const result = await publishPost("post_1", { pollIntervalMs: 1 });
    expect(result).toMatchObject({ status: "FAILED" });
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
  });

  it("marks RECONCILE_REQUIRED when container polling times out", async () => {
    mockMeta.getContainerStatus.mockResolvedValue({
      id: "container_1",
      status: "IN_PROGRESS",
    });
    const result = await publishPost("post_1", {
      pollIntervalMs: 1,
      pollTimeoutMs: 10,
    });
    expect(result).toMatchObject({ status: "RECONCILE_REQUIRED" });
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
  });

  it("marks RECONCILE_REQUIRED on a timeout after submitting publish, never blind-retrying", async () => {
    mockMeta.publishContainer.mockRejectedValue(
      new TypeError("fetch failed")
    );
    const result = await publishPost("post_1", { pollIntervalMs: 1 });
    expect(result).toMatchObject({ status: "RECONCILE_REQUIRED" });
    expect(mockMeta.publishContainer).toHaveBeenCalledTimes(1);
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RECONCILE_REQUIRED" }),
      })
    );
  });

  it("rethrows RateLimitError for BullMQ retry and resets the post to SCHEDULED", async () => {
    mockMeta.getContainerStatus.mockRejectedValue(
      new RateLimitError("Temporarily blocked")
    );
    await expect(publishPost("post_1", { pollIntervalMs: 1 })).rejects.toBeInstanceOf(
      RateLimitError
    );
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SCHEDULED", leaseUntil: null }),
      })
    );
  });

  it("creates a REEL container for REEL posts", async () => {
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      postRow({
        kind: "REEL",
        mediaAsset: {
          id: "asset_1",
          storageKey: "publishing/ws_1/asset_1.mp4",
          mimeType: "video/mp4",
        },
      })
    );
    const result = await publishPost("post_1", { pollIntervalMs: 1 });
    expect(result).toMatchObject({ status: "PUBLISHED" });
    expect(mockMeta.createReelContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        videoUrl: "https://cdn.example.test/photo.jpg",
        host: "facebook",
      })
    );
    expect(mockMeta.createImageContainer).not.toHaveBeenCalled();
  });

  describe("DM automation attachment", () => {
    it("activates the automation with the published media id on success", async () => {
      mockPrisma.scheduledPost.findUnique.mockResolvedValue(
        postRow({ automationId: "auto_1", automationActivateOnPublish: true })
      );
      mockPrisma.automation.findUnique.mockResolvedValue({
        id: "auto_1",
        workspaceId: "ws_1",
        instagramAccountId: "acct_1",
      });
      const result = await publishPost("post_1", { pollIntervalMs: 1 });
      expect(result).toMatchObject({ status: "PUBLISHED" });
      expect(mockPrisma.automation.update).toHaveBeenCalledWith({
        where: { id: "auto_1" },
        data: { postId: "media_1", isActive: true },
      });
    });

    it("does not activate when automationActivateOnPublish is false", async () => {
      mockPrisma.scheduledPost.findUnique.mockResolvedValue(
        postRow({ automationId: "auto_1", automationActivateOnPublish: false })
      );
      mockPrisma.automation.findUnique.mockResolvedValue({
        id: "auto_1",
        workspaceId: "ws_1",
        instagramAccountId: "acct_1",
      });
      await publishPost("post_1", { pollIntervalMs: 1 });
      expect(mockPrisma.automation.update).not.toHaveBeenCalled();
    });

    it("never attaches on a failed publish", async () => {
      mockPrisma.scheduledPost.findUnique.mockResolvedValue(
        postRow({ automationId: "auto_1", automationActivateOnPublish: true })
      );
      const { PermissionError } = await import("../lib/meta/client");
      mockMeta.checkPublishPermission.mockRejectedValue(
        new PermissionError("Token is missing the instagram_content_publish permission")
      );
      const result = await publishPost("post_1", { pollIntervalMs: 1 });
      expect(result).toMatchObject({ status: "FAILED" });
      expect(mockPrisma.automation.update).not.toHaveBeenCalled();
      expect(mockPrisma.automation.findUnique).not.toHaveBeenCalled();
    });

    it("warns but still publishes when the automation belongs to another account", async () => {
      mockPrisma.scheduledPost.findUnique.mockResolvedValue(
        postRow({ automationId: "auto_1", automationActivateOnPublish: true })
      );
      mockPrisma.automation.findUnique.mockResolvedValue({
        id: "auto_1",
        workspaceId: "ws_1",
        instagramAccountId: "acct_other",
      });
      const result = await publishPost("post_1", { pollIntervalMs: 1 });
      expect(result).toMatchObject({ status: "PUBLISHED" });
      expect(mockPrisma.automation.update).not.toHaveBeenCalled();
      const warnings = mockPrisma.publishAttempt.create.mock.calls.filter(
        (c) =>
          (c[0] as { data: { outcome?: string } }).data.outcome === "WARNING"
      );
      expect(warnings.length).toBeGreaterThan(0);
      expect(JSON.stringify(warnings)).toContain("different Instagram account");
    });
  });
});

describe("reconcilePost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.scheduledPost.update.mockResolvedValue({});
    mockPrisma.publishAttempt.create.mockResolvedValue({ id: "att_1" });
    mockDecryptToken.mockReturnValue("tok-plain");
    mockMeta.getContainerStatus.mockResolvedValue({
      id: "container_1",
      status: "FINISHED",
    });
  });

  function staleRow(overrides: Record<string, unknown> = {}) {
    return postRow({
      status: "PREPARING",
      leaseUntil: new Date("2026-11-07T09:00:00Z"),
      containerId: "container_1",
      ...overrides,
    });
  }

  it("resets a PREPARING post with a FINISHED container to SCHEDULED", async () => {
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(staleRow());
    const result = await reconcilePost("post_1");
    expect(result).toEqual({ action: "reset", status: "SCHEDULED", postId: "post_1" });
  });

  it("resets a post with no container (nothing was submitted)", async () => {
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      staleRow({ containerId: null })
    );
    const result = await reconcilePost("post_1");
    expect(result.action).toBe("reset");
    expect(mockMeta.getContainerStatus).not.toHaveBeenCalled();
  });

  it("marks FAILED when the container errored", async () => {
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(staleRow());
    mockMeta.getContainerStatus.mockResolvedValue({
      id: "container_1",
      status: "ERROR",
    });
    const result = await reconcilePost("post_1");
    expect(result).toEqual({ action: "failed", status: "FAILED", postId: "post_1" });
  });

  it("marks RECONCILE_REQUIRED for a PUBLISHING post whose container is FINISHED (submit may have happened)", async () => {
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      staleRow({ status: "PUBLISHING" })
    );
    const result = await reconcilePost("post_1");
    expect(result.action).toBe("reconcile-required");
    expect(result).toMatchObject({ status: "RECONCILE_REQUIRED" });
  });

  it("leaves a post with a live lease alone", async () => {
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      staleRow({ leaseUntil: new Date(Date.now() + 60_000) })
    );
    const result = await reconcilePost("post_1");
    expect(result.action).toBe("none");
    expect(mockMeta.getContainerStatus).not.toHaveBeenCalled();
  });
});
