import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmMedia,
  createPost,
  deleteMedia,
  deletePost,
  getPost,
  listCampaigns,
  listInstagramAccounts,
  listMedia,
  listPosts,
  PublishingApiError,
  requestUploadUrl,
  retryPost,
  toPlainError,
  updatePost,
} from "../lib/publishing/api-client";

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe("publishing api-client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists posts from GET /api/publishing/posts", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: [{ id: "p1" }] }));
    const posts = await listPosts();
    expect(posts).toEqual([{ id: "p1" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/publishing/posts", { cache: "no-store" });
  });

  it("creates a draft with POST and no scheduledAt", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { id: "p1", status: "DRAFT" } }, 201)
    );
    const result = await createPost({
      instagramAccountId: "acc1",
      mediaAssetId: "med1",
      kind: "IMAGE",
      caption: "Hello",
      timezone: "America/Boise",
    });
    expect(result).toEqual({ id: "p1", status: "DRAFT" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/publishing/posts");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      instagramAccountId: "acc1",
      mediaAssetId: "med1",
      kind: "IMAGE",
      caption: "Hello",
      timezone: "America/Boise",
    });
    expect(body.scheduledAt).toBeUndefined();
  });

  it("schedules a post by sending the UTC scheduledAt in the body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { id: "p2", status: "SCHEDULED" } }, 201)
    );
    await createPost({
      instagramAccountId: "acc1",
      mediaAssetId: "med1",
      kind: "REEL",
      caption: "Reel",
      scheduledAt: "2026-11-08T17:00:00.000Z",
      timezone: "America/Boise",
      automationId: "camp1",
      automationActivateOnPublish: true,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.scheduledAt).toBe("2026-11-08T17:00:00.000Z");
    expect(body.automationId).toBe("camp1");
    expect(body.automationActivateOnPublish).toBe(true);
  });

  it("fetches one post with its attempts", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { id: "p1", attempts: [] } })
    );
    const post = await getPost("p1");
    expect(post.attempts).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/publishing/posts/p1", { cache: "no-store" });
  });

  it("patches caption/schedule with PATCH", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { id: "p1", caption: "New" } })
    );
    await updatePost("p1", {
      caption: "New",
      scheduledAt: "2026-11-09T17:00:00.000Z",
      timezone: "America/Boise",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/publishing/posts/p1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      caption: "New",
      scheduledAt: "2026-11-09T17:00:00.000Z",
      timezone: "America/Boise",
    });
  });

  it("retries a failed post with POST .../retry", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { id: "p1", status: "SCHEDULED" } })
    );
    const post = await retryPost("p1");
    expect(post.status).toBe("SCHEDULED");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/publishing/posts/p1/retry");
    expect(init.method).toBe("POST");
  });

  it("deletes a post with DELETE", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await deletePost("p1");
    expect(fetchMock).toHaveBeenCalledWith("/api/publishing/posts/p1", {
      cache: "no-store",
      method: "DELETE",
    });
  });

  it("lists media with kind and search query params", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: [] }));
    await listMedia("REEL", "launch");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/publishing/media?kind=REEL&q=launch",
      { cache: "no-store" }
    );
  });

  it("requests an upload URL with file metadata", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { uploadUrl: "https://upload.test/x", storageKey: "k1", expiresIn: 900 },
      })
    );
    const result = await requestUploadUrl({
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      byteSize: 1234,
      kind: "IMAGE",
    });
    expect(result.storageKey).toBe("k1");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      byteSize: 1234,
      kind: "IMAGE",
    });
  });

  it("confirms an upload with the storage key", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { id: "med1" } }, 201)
    );
    const asset = await confirmMedia({
      storageKey: "k1",
      originalName: "photo.jpg",
      mimeType: "image/jpeg",
      byteSize: 1234,
      kind: "IMAGE",
    });
    expect(asset.id).toBe("med1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/publishing/media/confirm");
    expect(JSON.parse(init.body as string)).toMatchObject({ storageKey: "k1" });
  });

  it("deletes media with DELETE", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await deleteMedia("med1");
    expect(fetchMock).toHaveBeenCalledWith("/api/publishing/media/med1", {
      cache: "no-store",
      method: "DELETE",
    });
  });

  it("lists Instagram accounts from the lightweight accounts endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { instagramAccounts: [{ id: "a1", username: "brand" }], selectedInstagramAccountId: "a1" },
      })
    );
    const result = await listInstagramAccounts();
    expect(result.selectedInstagramAccountId).toBe("a1");
    expect(fetchMock).toHaveBeenCalledWith("/api/instagram/accounts", { cache: "no-store" });
  });

  it("lists campaigns from the automations endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: [{ id: "c1" }] }));
    await listCampaigns();
    expect(fetchMock).toHaveBeenCalledWith("/api/automations", { cache: "no-store" });
  });

  it("throws a PublishingApiError with the server message on failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: "Account or media asset not found" }, 404)
    );
    await expect(listPosts()).rejects.toMatchObject({
      status: 404,
      message: "Account or media asset not found",
    });
    await expect(listPosts()).rejects.toBeInstanceOf(PublishingApiError);
  });

  it("turns a 409 media delete into plain words", () => {
    expect(toPlainError(new PublishingApiError("Conflict", 409))).toContain(
      "already used by a scheduled post"
    );
    expect(toPlainError(new PublishingApiError("boom", 0))).toContain("reach the server");
    expect(toPlainError(new Error("raw"))).toBe("raw");
  });
});
