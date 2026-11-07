import { describe, expect, it } from "vitest";
import {
  IMAGE_MAX_BYTES,
  REEL_MAX_BYTES,
  sniffMediaType,
  validateMediaUpload,
  validateUploadRequest,
} from "../lib/publishing/media-validation";

// ---- Minimal in-test fixtures (headers only, no real pixels) ----

function pngBuffer(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 2; // color type (truecolor)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Buffer.alloc(4), // CRC (image-size does not verify it)
  ]);
}

function jpegBuffer(width: number, height: number): Buffer {
  const sof0 = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  return Buffer.concat([
    Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
      0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ]),
    sof0,
  ]);
}

function webpBuffer(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(10, 0);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + 8 + 10, 0);
  return Buffer.concat([
    Buffer.from("RIFF"),
    riffSize,
    Buffer.from("WEBP"),
    Buffer.from("VP8X"),
    chunkSize,
    payload,
  ]);
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4);
  return Buffer.concat([header, payload]);
}

function mvhdBox(timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return box("mvhd", payload);
}

function tkhdBox(width: number, height: number): Buffer {
  const payload = Buffer.alloc(84);
  payload.writeUInt32BE(Math.round(width * 65536), 76);
  payload.writeUInt32BE(Math.round(height * 65536), 80);
  return box("tkhd", payload);
}

function mp4Buffer(
  width: number,
  height: number,
  durationSec: number,
  brand = "isom"
): Buffer {
  const ftypPayload = Buffer.concat([
    Buffer.from(brand),
    Buffer.alloc(4),
    Buffer.from("isomiso2"),
  ]);
  const moov = box(
    "moov",
    Buffer.concat([
      mvhdBox(1000, Math.round(durationSec * 1000)),
      box("trak", tkhdBox(width, height)),
    ])
  );
  return Buffer.concat([box("ftyp", ftypPayload), moov]);
}

describe("sniffMediaType", () => {
  it("sniffs JPEG, PNG, WebP and MP4 from magic bytes", () => {
    expect(sniffMediaType(jpegBuffer(100, 100))?.mimeType).toBe("image/jpeg");
    expect(sniffMediaType(pngBuffer(100, 100))?.mimeType).toBe("image/png");
    expect(sniffMediaType(webpBuffer(100, 100))?.mimeType).toBe("image/webp");
    expect(sniffMediaType(mp4Buffer(100, 100, 5))?.mimeType).toBe("video/mp4");
    expect(sniffMediaType(mp4Buffer(100, 100, 5, "qt  "))?.mimeType).toBe(
      "video/quicktime"
    );
  });

  it("returns null for unrecognized bytes", () => {
    expect(sniffMediaType(Buffer.from("hello world, not media"))).toBeNull();
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull();
  });
});

describe("validateMediaUpload images", () => {
  it("accepts a valid PNG at 4:5", () => {
    const result = validateMediaUpload({
      buffer: pngBuffer(1080, 1350),
      mimeType: "image/png",
      kind: "IMAGE",
    });
    expect(result).toEqual({
      ok: true,
      mimeType: "image/png",
      width: 1080,
      height: 1350,
    });
  });

  it("accepts a valid JPEG and WebP", () => {
    expect(
      validateMediaUpload({
        buffer: jpegBuffer(1440, 1080),
        mimeType: "image/jpeg",
        kind: "IMAGE",
      })
    ).toMatchObject({ ok: true, width: 1440, height: 1080 });
    expect(
      validateMediaUpload({
        buffer: webpBuffer(1200, 1500),
        mimeType: "image/webp",
        kind: "IMAGE",
      })
    ).toMatchObject({ ok: true, width: 1200, height: 1500 });
  });

  it("rejects bytes that match no known format", () => {
    const result = validateMediaUpload({
      buffer: Buffer.from("definitely not an image"),
      mimeType: "image/jpeg",
      kind: "IMAGE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unrecognized file format/);
  });

  it("rejects a declared MIME that disagrees with the sniffed bytes", () => {
    const result = validateMediaUpload({
      buffer: pngBuffer(1080, 1350),
      mimeType: "image/jpeg",
      kind: "IMAGE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/declared image\/jpeg/);
  });

  it("rejects an image uploaded as a REEL", () => {
    const result = validateMediaUpload({
      buffer: pngBuffer(1080, 1350),
      mimeType: "image/png",
      kind: "REEL",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expected a video/);
  });

  it("rejects an image outside Meta's 4:5 to 1.91:1 aspect range", () => {
    const tall = validateMediaUpload({
      buffer: pngBuffer(100, 1000),
      mimeType: "image/png",
      kind: "IMAGE",
    });
    expect(tall.ok).toBe(false);
    if (!tall.ok) expect(tall.error).toMatch(/Aspect ratio 0\.10:1/);
    const wide = validateMediaUpload({
      buffer: jpegBuffer(1910, 500),
      mimeType: "image/jpeg",
      kind: "IMAGE",
    });
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.error).toMatch(/Aspect ratio 3\.82:1/);
  });

  it("rejects an image over Meta's 8 MB cap", () => {
    const oversize = Buffer.concat([
      pngBuffer(1080, 1350),
      Buffer.alloc(IMAGE_MAX_BYTES),
    ]);
    const result = validateMediaUpload({
      buffer: oversize,
      mimeType: "image/png",
      kind: "IMAGE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/over Meta's 8 MB limit/);
  });
});

describe("validateMediaUpload reels", () => {
  it("accepts a valid 9:16 MP4 and reports duration", () => {
    const result = validateMediaUpload({
      buffer: mp4Buffer(1080, 1920, 5),
      mimeType: "video/mp4",
      kind: "REEL",
    });
    expect(result).toEqual({
      ok: true,
      mimeType: "video/mp4",
      width: 1080,
      height: 1920,
      durationSec: 5,
    });
  });

  it("accepts a QuickTime-branded MOV", () => {
    const result = validateMediaUpload({
      buffer: mp4Buffer(1080, 1920, 30, "qt  "),
      mimeType: "video/quicktime",
      kind: "REEL",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a video uploaded as an IMAGE", () => {
    const result = validateMediaUpload({
      buffer: mp4Buffer(1080, 1920, 5),
      mimeType: "video/mp4",
      kind: "IMAGE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expected an image/);
  });

  it("rejects a video with no moov metadata and advises faststart", () => {
    const ftypOnly = box(
      "ftyp",
      Buffer.concat([Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom")])
    );
    const result = validateMediaUpload({
      buffer: ftypOnly,
      mimeType: "video/mp4",
      kind: "REEL",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/faststart/);
  });

  it("rejects Reels shorter than 3s and longer than 15 minutes", () => {
    const short = validateMediaUpload({
      buffer: mp4Buffer(1080, 1920, 1),
      mimeType: "video/mp4",
      kind: "REEL",
    });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error).toMatch(/duration 1\.0s/);
    const long = validateMediaUpload({
      buffer: mp4Buffer(1080, 1920, 901),
      mimeType: "video/mp4",
      kind: "REEL",
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toMatch(/15 minute/);
  });

  it("rejects a Reel outside Meta's 0.01:1 to 10:1 aspect range", () => {
    const result = validateMediaUpload({
      buffer: mp4Buffer(2000, 100, 5),
      mimeType: "video/mp4",
      kind: "REEL",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Aspect ratio 20\.00:1/);
  });

  it("rejects a Reel over Meta's 300 MB cap", () => {
    const oversize = Buffer.concat([
      mp4Buffer(1080, 1920, 5),
      Buffer.alloc(REEL_MAX_BYTES),
    ]);
    const result = validateMediaUpload({
      buffer: oversize,
      mimeType: "video/mp4",
      kind: "REEL",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/over Meta's 300 MB limit/);
  });
});

describe("validateUploadRequest", () => {
  it("accepts a supported type inside the cap", () => {
    expect(
      validateUploadRequest({ mimeType: "image/jpeg", byteSize: 1024, kind: "IMAGE" })
    ).toBeNull();
    expect(
      validateUploadRequest({ mimeType: "video/mp4", byteSize: 1024, kind: "REEL" })
    ).toBeNull();
  });

  it("rejects a MIME the kind does not allow", () => {
    expect(
      validateUploadRequest({ mimeType: "image/gif", byteSize: 1024, kind: "IMAGE" })
    ).toMatch(/Unsupported media type/);
    expect(
      validateUploadRequest({ mimeType: "image/jpeg", byteSize: 1024, kind: "REEL" })
    ).toMatch(/Unsupported media type/);
  });

  it("rejects a byte size over the kind cap", () => {
    expect(
      validateUploadRequest({
        mimeType: "image/jpeg",
        byteSize: IMAGE_MAX_BYTES + 1,
        kind: "IMAGE",
      })
    ).toMatch(/exceeds the 8 MB limit/);
    expect(
      validateUploadRequest({
        mimeType: "video/mp4",
        byteSize: REEL_MAX_BYTES + 1,
        kind: "REEL",
      })
    ).toMatch(/exceeds the 300 MB limit/);
  });

  it("rejects a non-positive byte size", () => {
    expect(
      validateUploadRequest({ mimeType: "image/jpeg", byteSize: 0, kind: "IMAGE" })
    ).toMatch(/positive integer/);
  });
});
