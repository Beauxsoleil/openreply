import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PermissionError,
  RateLimitError,
  TokenExpiredError,
} from "../lib/meta/client";
import {
  checkPublishPermission,
  createImageContainer,
  createReelContainer,
  getContainerStatus,
  getPublishedMedia,
  publishContainer,
} from "../lib/meta/publishing";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function metaError(code: number, message: string): Record<string, unknown> {
  return {
    error: {
      message,
      type: "OAuthException",
      code,
      fbtrace_id: "trace_1",
    },
  };
}

describe("Meta publishing client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    // checkPublishPermission inspects the token via debug_token, which must
    // be called with the app access token as the caller (a system-user
    // token cannot inspect itself).
    vi.stubEnv("INSTAGRAM_APP_ID", "app_123");
    vi.stubEnv("INSTAGRAM_APP_SECRET", "secret_123");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("debug_token")) {
        return jsonResponse({
          data: {
            is_valid: true,
            scopes: ["instagram_basic", "instagram_business_content_publish"],
          },
        });
      }
      if (url.includes("/media_publish")) {
        return jsonResponse({ id: "media_1" });
      }
      if (url.includes("media_1")) {
        return jsonResponse({
          id: "media_1",
          permalink: "https://www.instagram.com/p/abc/",
          media_type: "IMAGE",
        });
      }
      if (url.includes("/media") && url.includes("graph.")) {
        return jsonResponse({ id: "container_1" });
      }
      if (url.includes("container_1")) {
        return jsonResponse({ id: "container_1", status_code: "FINISHED" });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function lastCall() {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, Record<string, unknown>];
    return { url, init, body: init?.body ? JSON.parse(init.body as string) : undefined };
  }

  it("creates an image container on graph.instagram.com", async () => {
    const result = await createImageContainer({
      accessToken: "tok",
      instagramAccountId: "ig_123",
      imageUrl: "https://cdn.example.test/photo.jpg",
      caption: "Hello",
      host: "instagram",
    });
    expect(result).toEqual({ id: "container_1" });
    const { url, init, body } = lastCall();
    expect(url).toBe("https://graph.instagram.com/v25.0/ig_123/media");
    expect(init.method).toBe("POST");
    expect(body).toEqual({ image_url: "https://cdn.example.test/photo.jpg", caption: "Hello" });
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("creates a Reel container with media_type REELS on graph.facebook.com", async () => {
    const result = await createReelContainer({
      accessToken: "tok",
      instagramAccountId: "ig_123",
      videoUrl: "https://cdn.example.test/reel.mp4",
      caption: "Reel",
      coverUrl: "https://cdn.example.test/cover.jpg",
      host: "facebook",
    });
    expect(result).toEqual({ id: "container_1" });
    const { url, body } = lastCall();
    expect(url).toBe("https://graph.facebook.com/v25.0/ig_123/media");
    expect(body).toEqual({
      media_type: "REELS",
      video_url: "https://cdn.example.test/reel.mp4",
      caption: "Reel",
      cover_url: "https://cdn.example.test/cover.jpg",
    });
  });

  it("polls container status via status_code", async () => {
    const result = await getContainerStatus({
      accessToken: "tok",
      containerId: "container_1",
      host: "instagram",
    });
    expect(result).toEqual({ id: "container_1", status: "FINISHED" });
    const { url } = lastCall();
    expect(url).toContain("https://graph.instagram.com/v25.0/container_1");
    expect(url).toContain("fields=status_code");
  });

  it("publishes a container with creation_id", async () => {
    const result = await publishContainer({
      accessToken: "tok",
      instagramAccountId: "ig_123",
      containerId: "container_1",
      host: "instagram",
    });
    expect(result).toEqual({ id: "media_1" });
    const { url, body } = lastCall();
    expect(url).toBe("https://graph.instagram.com/v25.0/ig_123/media_publish");
    expect(body).toEqual({ creation_id: "container_1" });
  });

  it("reads back the published media permalink", async () => {
    const result = await getPublishedMedia({
      accessToken: "tok",
      mediaId: "media_1",
      host: "instagram",
    });
    expect(result.permalink).toBe("https://www.instagram.com/p/abc/");
    expect(result.media_type).toBe("IMAGE");
    const { url } = lastCall();
    expect(url).toContain("fields=id%2Cpermalink%2Cmedia_type%2Cmedia_product_type");
  });

  it("rejects a non-HTTPS media URL before calling Meta", async () => {
    await expect(
      createImageContainer({
        accessToken: "tok",
        instagramAccountId: "ig_123",
        imageUrl: "http://cdn.example.test/photo.jpg",
        host: "instagram",
      })
    ).rejects.toThrow(/HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Meta error 190 to TokenExpiredError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(metaError(190, "Error validating access token"), 400)
    );
    await expect(
      createImageContainer({
        accessToken: "tok",
        instagramAccountId: "ig_123",
        imageUrl: "https://cdn.example.test/photo.jpg",
        host: "instagram",
      })
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("maps Meta errors 100 and 200 to PermissionError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(metaError(100, "No permission"), 400)
    );
    await expect(
      createImageContainer({
        accessToken: "tok",
        instagramAccountId: "ig_123",
        imageUrl: "https://cdn.example.test/photo.jpg",
        host: "instagram",
      })
    ).rejects.toBeInstanceOf(PermissionError);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(metaError(200, "Permissions error"), 403)
    );
    await expect(
      createImageContainer({
        accessToken: "tok",
        instagramAccountId: "ig_123",
        imageUrl: "https://cdn.example.test/photo.jpg",
        host: "instagram",
      })
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("maps Meta error 368 to RateLimitError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(metaError(368, "Temporarily blocked"), 400)
    );
    await expect(
      createImageContainer({
        accessToken: "tok",
        instagramAccountId: "ig_123",
        imageUrl: "https://cdn.example.test/photo.jpg",
        host: "instagram",
      })
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  describe("checkPublishPermission", () => {
    it("passes on the instagram host when instagram_business_content_publish is granted", async () => {
      const result = await checkPublishPermission({
        accessToken: "tok",
        host: "instagram",
      });
      expect(result.permission).toBe("instagram_business_content_publish");
      expect(fetchMock.mock.calls[0][0]).toContain("/debug_token");
    });

    it("inspects the token as input_token and calls debug_token with the app access token", async () => {
      await checkPublishPermission({
        accessToken: "tok",
        host: "instagram",
      });
      const debugUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(debugUrl.searchParams.get("input_token")).toBe("tok");
      expect(debugUrl.searchParams.get("access_token")).toBe(
        "app_123|secret_123"
      );
    });

    it("throws PermissionError naming instagram_business_content_publish when it is missing", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: { is_valid: true, scopes: ["instagram_basic"] },
        })
      );
      await expect(
        checkPublishPermission({ accessToken: "tok", host: "instagram" })
      ).rejects.toMatchObject({
        name: "PermissionError",
        message: expect.stringContaining("instagram_business_content_publish"),
      });
    });

    it("throws PermissionError naming instagram_content_publish on the facebook host", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            is_valid: true,
            scopes: ["instagram_basic", "instagram_manage_messages"],
          },
        })
      );
      await expect(
        checkPublishPermission({ accessToken: "tok", host: "facebook" })
      ).rejects.toMatchObject({
        name: "PermissionError",
        message: expect.stringContaining("instagram_content_publish"),
      });
    });

    it("passes on the facebook host when instagram_content_publish is granted", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            is_valid: true,
            scopes: ["instagram_basic", "instagram_content_publish"],
          },
        })
      );
      const result = await checkPublishPermission({
        accessToken: "tok",
        host: "facebook",
      });
      expect(result.permission).toBe("instagram_content_publish");
    });

    it("throws TokenExpiredError when the token is not valid", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { is_valid: false, scopes: [] } })
      );
      await expect(
        checkPublishPermission({ accessToken: "tok", host: "instagram" })
      ).rejects.toBeInstanceOf(TokenExpiredError);
    });
  });
});
