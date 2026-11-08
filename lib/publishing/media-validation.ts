/**
 * Media validation for the Instagram publishing library.
 *
 * Limits verified 2026-11-07 against Meta's Instagram Graph API
 * IG User media reference (Content Publishing):
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
 * (Meta's own page returned 403 to this VM's fetcher on 2026-11-07; the
 * values below were corroborated against several independent sources that
 * quote the reference verbatim.)
 *
 * Feed image: JPEG only, 8 MB max, aspect ratio 4:5 to 1.91:1, width
 * 320-1440 px (Meta scales outside that width range), sRGB.
 * Reel: MP4 or MOV (H.264/HEVC), 3 s to 15 min, 300 MB max, aspect ratio
 * 0.01:1 to 10:1 (9:16 recommended), 23-60 fps, max 1920 px wide.
 * Reel cover: JPEG, 8 MB max, 9:16 recommended (Meta center-crops).
 *
 * This module validates what can be checked from the bytes themselves.
 * Two deliberate gaps, handled later in the pipeline:
 * - Meta's publishing API accepts JPEG only for feed images. PNG/WebP are
 *   accepted into the library here (creators upload them constantly) and
 *   MUST be converted to JPEG before container creation at publish time.
 * - Video codec / frame-rate / bitrate checks need ffprobe and are not
 *   attempted here; the MP4/MOV box parser below reads duration and
 *   dimensions only.
 */

import imageSize from "image-size";

export type MediaKind = "IMAGE" | "REEL";

export type MediaValidationResult =
  | {
      ok: true;
      /** Canonical MIME sniffed from the file's magic bytes. */
      mimeType: string;
      width: number;
      height: number;
      /** Present for REEL only. */
      durationSec?: number;
    }
  | { ok: false; error: string };

/** Meta: "File size: 8 MB maximum" for feed images (and Reel covers). */
export const IMAGE_MAX_BYTES = 8_000_000;
/** Meta: aspect ratio "must be within a 4:5 to 1.91:1 range". */
export const IMAGE_ASPECT_MIN = 4 / 5;
export const IMAGE_ASPECT_MAX = 1.91;

/** Meta: Reels are 300 MB maximum. */
export const REEL_MAX_BYTES = 300_000_000;
/** Meta: Reels are "3 seconds to 15 minutes". */
export const REEL_MIN_DURATION_SEC = 3;
export const REEL_MAX_DURATION_SEC = 15 * 60;
/** Meta: Reel aspect ratio 0.01:1 to 10:1, 9:16 recommended. */
export const REEL_ASPECT_MIN = 0.01;
export const REEL_ASPECT_MAX = 10;

/** Image types the library accepts at upload time (see JPEG note above). */
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
/** Video containers Meta accepts for Reels. */
export const ALLOWED_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"] as const;

export function maxBytesForKind(kind: MediaKind): number {
  return kind === "IMAGE" ? IMAGE_MAX_BYTES : REEL_MAX_BYTES;
}

export function allowedMimeTypesForKind(kind: MediaKind): readonly string[] {
  return kind === "IMAGE" ? ALLOWED_IMAGE_MIME_TYPES : ALLOWED_VIDEO_MIME_TYPES;
}

/** File extension (no dot) for a sniffed/declared MIME type. */
export function extensionForMimeType(mimeType: string): string | null {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    default:
      return null;
  }
}

/**
 * Cheap up-front check for the upload-url endpoint: declared MIME, kind and
 * byte size, before any bytes exist. Returns an error message or null.
 */
export function validateUploadRequest(input: {
  mimeType: string;
  byteSize: number;
  kind: MediaKind;
}): string | null {
  if (!allowedMimeTypesForKind(input.kind).includes(input.mimeType)) {
    return `Unsupported media type ${input.mimeType} for ${input.kind} uploads`;
  }
  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0) {
    return "byteSize must be a positive integer";
  }
  const max = maxBytesForKind(input.kind);
  if (input.byteSize > max) {
    return `File exceeds the ${max / 1_000_000} MB limit for ${input.kind} uploads`;
  }
  return null;
}

type SniffedType = { family: "image" | "video"; mimeType: string } | null;

/** Magic-byte sniffing. The client-sent MIME is never trusted on its own. */
export function sniffMediaType(buffer: Uint8Array): SniffedType {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { family: "image", mimeType: "image/jpeg" };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { family: "image", mimeType: "image/png" };
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x45 && // E
    buffer[10] === 0x42 && // B
    buffer[11] === 0x50 // P
  ) {
    return { family: "image", mimeType: "image/webp" };
  }
  if (
    buffer.length >= 8 &&
    buffer[4] === 0x66 && // f
    buffer[5] === 0x74 && // t
    buffer[6] === 0x79 && // y
    buffer[7] === 0x70 // p
  ) {
    // MP4/MOV: distinguish by major brand; both are accepted for REEL.
    const brand = Buffer.from(buffer.subarray(8, 12)).toString("ascii");
    return {
      family: "video",
      mimeType: brand === "qt  " ? "video/quicktime" : "video/mp4",
    };
  }
  return null;
}

function aspectError(ratio: number, min: number, max: number, kind: MediaKind): string {
  return (
    `Aspect ratio ${ratio.toFixed(2)}:1 is outside Meta's ${min}-` +
    `${max}:1 range for ${kind === "IMAGE" ? "feed images" : "Reels"}`
  );
}

interface Box {
  type: string;
  /** Offset of the box payload (after size/type/largesize fields). */
  payloadStart: number;
  payloadEnd: number;
}

/** Read one MP4/MOV box header at `offset`; null when truncated. */
function readBox(buffer: Buffer, offset: number): (Box & { headerSize: number }) | null {
  if (offset + 8 > buffer.length) return null;
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buffer.length) return null;
    size = Number(buffer.readBigUInt64BE(offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = buffer.length - offset;
  }
  if (!Number.isFinite(size) || size < headerSize) return null;
  const payloadStart = offset + headerSize;
  const payloadEnd = Math.min(buffer.length, offset + size);
  if (payloadEnd < payloadStart) return null;
  return { type, payloadStart, payloadEnd, headerSize };
}

/** Walk the direct children of the box spanning [start, end). */
function childBoxes(buffer: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(buffer, offset);
    if (!box || box.payloadEnd <= offset) break;
    boxes.push(box);
    offset = box.payloadEnd;
  }
  return boxes;
}

/**
 * Minimal MP4/MOV metadata reader: duration from mvhd (timescale/duration)
 * and dimensions from the first trak's tkhd (16.16 fixed-point width/height).
 * Returns null when the moov metadata cannot be found — the usual cause is
 * a file whose moov atom sits at the end (not faststart); the caller should
 * advise re-exporting with faststart (`-movflags +faststart`).
 */
export function parseMp4Metadata(buffer: Buffer): {
  width: number;
  height: number;
  durationSec: number;
} | null {
  const top = childBoxes(buffer, 0, buffer.length);
  const moov = top.find((box) => box.type === "moov");
  if (!moov) return null;
  const moovChildren = childBoxes(buffer, moov.payloadStart, moov.payloadEnd);
  const mvhd = moovChildren.find((box) => box.type === "mvhd");
  if (!mvhd) return null;
  const mvhdPayload = buffer.subarray(mvhd.payloadStart, mvhd.payloadEnd);
  if (mvhdPayload.length < 24) return null;
  const version = mvhdPayload[0];
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (mvhdPayload.length < 32) return null;
    timescale = mvhdPayload.readUInt32BE(20);
    duration = Number(mvhdPayload.readBigUInt64BE(24));
  } else if (version === 0) {
    timescale = mvhdPayload.readUInt32BE(12);
    duration = mvhdPayload.readUInt32BE(16);
  } else {
    return null;
  }
  if (!timescale || !Number.isFinite(duration)) return null;
  const durationSec = duration / timescale;

  let width = 0;
  let height = 0;
  for (const trak of moovChildren.filter((box) => box.type === "trak")) {
    const tkhd = childBoxes(buffer, trak.payloadStart, trak.payloadEnd).find(
      (box) => box.type === "tkhd"
    );
    if (!tkhd) continue;
    const payload = buffer.subarray(tkhd.payloadStart, tkhd.payloadEnd);
    const tkhdVersion = payload[0];
    // Width/height are 16.16 fixed-point at offset 76 (v0) or 88 (v1).
    const widthOffset = tkhdVersion === 1 ? 88 : 76;
    if (payload.length < widthOffset + 8) continue;
    width = payload.readUInt32BE(widthOffset) / 65536;
    height = payload.readUInt32BE(widthOffset + 4) / 65536;
    if (width > 0 && height > 0) break;
  }
  if (!width || !height) return null;
  return { width, height, durationSec };
}

/**
 * Validate real uploaded bytes. Sniffs the format from magic bytes (the
 * declared MIME is checked against the sniffed one, never trusted alone),
 * then enforces Meta's size, aspect-ratio and (for Reels) duration limits.
 */
export function validateMediaUpload(input: {
  buffer: Uint8Array;
  mimeType: string;
  kind: MediaKind;
}): MediaValidationResult {
  const { buffer, mimeType, kind } = input;
  const sniffed = sniffMediaType(buffer);
  if (!sniffed) {
    return {
      ok: false,
      error:
        "Unrecognized file format: expected a JPEG, PNG or WebP image, or an MP4/MOV video",
    };
  }
  if (sniffed.family === "image" && kind !== "IMAGE") {
    return { ok: false, error: `Image file uploaded as ${kind}; expected a video` };
  }
  if (sniffed.family === "video" && kind !== "REEL") {
    return { ok: false, error: `Video file uploaded as ${kind}; expected an image` };
  }
  if (mimeType !== sniffed.mimeType) {
    return {
      ok: false,
      error: `File contents are ${sniffed.mimeType} but the upload declared ${mimeType}`,
    };
  }

  const maxBytes = maxBytesForKind(kind);
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      error: `File is ${(buffer.length / 1_000_000).toFixed(1)} MB, over Meta's ${maxBytes / 1_000_000} MB limit for ${kind === "IMAGE" ? "feed images" : "Reels"}`,
    };
  }

  if (kind === "IMAGE") {
    let dimensions;
    try {
      dimensions = imageSize(Buffer.from(buffer));
    } catch {
      return { ok: false, error: "Could not read image dimensions from the file" };
    }
    if (!dimensions.width || !dimensions.height) {
      return { ok: false, error: "Could not read image dimensions from the file" };
    }
    const ratio = dimensions.width / dimensions.height;
    if (ratio < IMAGE_ASPECT_MIN || ratio > IMAGE_ASPECT_MAX) {
      return { ok: false, error: aspectError(ratio, IMAGE_ASPECT_MIN, IMAGE_ASPECT_MAX, kind) };
    }
    return {
      ok: true,
      mimeType: sniffed.mimeType,
      width: dimensions.width,
      height: dimensions.height,
    };
  }

  const metadata = parseMp4Metadata(Buffer.from(buffer));
  if (!metadata) {
    return {
      ok: false,
      error:
        "Could not read video metadata (moov atom not found). Re-export with faststart so the moov atom sits at the front of the file, e.g. ffmpeg -movflags +faststart",
    };
  }
  const ratio = metadata.width / metadata.height;
  if (ratio < REEL_ASPECT_MIN || ratio > REEL_ASPECT_MAX) {
    return { ok: false, error: aspectError(ratio, REEL_ASPECT_MIN, REEL_ASPECT_MAX, kind) };
  }
  if (
    metadata.durationSec < REEL_MIN_DURATION_SEC ||
    metadata.durationSec > REEL_MAX_DURATION_SEC
  ) {
    return {
      ok: false,
      error: `Reel duration ${metadata.durationSec.toFixed(1)}s is outside Meta's ${REEL_MIN_DURATION_SEC}s to 15 minute range`,
    };
  }
  return {
    ok: true,
    mimeType: sniffed.mimeType,
    width: Math.round(metadata.width),
    height: Math.round(metadata.height),
    durationSec: metadata.durationSec,
  };
}
