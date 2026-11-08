import { afterEach, describe, expect, it } from "vitest";
import {
  getMediaDeliveryUrl,
  getR2Config,
  isPublishingStorageConfigured,
  mediaStorageKey,
  putMediaObject,
} from "../lib/publishing/r2";

const R2_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

afterEach(() => {
  for (const name of R2_VARS) delete process.env[name];
});

describe("publishing R2 storage", () => {
  it("reports unconfigured when any variable is missing", () => {
    expect(getR2Config()).toBeNull();
    expect(isPublishingStorageConfigured()).toBe(false);
    process.env.R2_ACCOUNT_ID = "acct";
    process.env.R2_ACCESS_KEY_ID = "key";
    process.env.R2_SECRET_ACCESS_KEY = "secret";
    expect(getR2Config()).toBeNull(); // bucket still missing
  });

  it("reads config when all four variables are set", () => {
    process.env.R2_ACCOUNT_ID = "acct";
    process.env.R2_ACCESS_KEY_ID = "key";
    process.env.R2_SECRET_ACCESS_KEY = "secret";
    process.env.R2_BUCKET = "openreply-media";
    expect(getR2Config()).toEqual({
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "openreply-media",
    });
    expect(isPublishingStorageConfigured()).toBe(true);
  });

  it("builds workspace-scoped storage keys", () => {
    expect(mediaStorageKey("ws_1", "asset_1", "JPG")).toBe("publishing/ws_1/asset_1.jpg");
    expect(mediaStorageKey("ws_1", "asset_1", ".mp4")).toBe("publishing/ws_1/asset_1.mp4");
  });

  it("refuses uploads while unconfigured instead of failing obscurely", async () => {
    await expect(putMediaObject("k", new Uint8Array([1]), "image/jpeg")).rejects.toThrow(
      /not configured/
    );
  });

  it("presigns a delivery URL offline with test credentials", async () => {
    process.env.R2_ACCOUNT_ID = "testaccount";
    process.env.R2_ACCESS_KEY_ID = "testkey";
    process.env.R2_SECRET_ACCESS_KEY = "testsecret";
    process.env.R2_BUCKET = "openreply-media";
    const url = await getMediaDeliveryUrl("publishing/ws_1/asset_1.jpg", 3600);
    expect(url).toContain("testaccount.r2.cloudflarestorage.com");
    expect(url).toContain("openreply-media");
    // Virtual-host style: the key stays a literal path, slashes unencoded.
    expect(url).toContain("publishing/ws_1/asset_1.jpg");
    expect(url).toContain("X-Amz-Signature=");
  });
});
