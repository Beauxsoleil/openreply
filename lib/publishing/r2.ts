/**
 * Cloudflare R2 storage for publishing media.
 *
 * Media bytes never live in Neon. Uploads go to a private R2 bucket; Meta
 * ingests them from a time-limited presigned delivery URL created near
 * publish time. Credentials live only in server-side env vars and are never
 * exposed to the browser: the browser uploads through
 * POST /api/publishing/media, never directly to R2.
 *
 * Required env vars (all four, or storage reports itself unconfigured):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Null when any required variable is missing: callers answer 503. */
export function getR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function isPublishingStorageConfigured(): boolean {
  return getR2Config() !== null;
}

export function requireR2Config(): R2Config {
  const config = getR2Config();
  if (!config) {
    throw new Error(
      "Publishing storage is not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET"
    );
  }
  return config;
}

let client: S3Client | null = null;

function getR2Client(config: R2Config): S3Client {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }
  return client;
}

/** Object layout: publishing/<workspaceId>/<assetId>.<ext> */
export function mediaStorageKey(
  workspaceId: string,
  assetId: string,
  extension: string
): string {
  const ext = extension.replace(/^\.+/, "").toLowerCase();
  return `publishing/${workspaceId}/${assetId}.${ext}`;
}

export async function putMediaObject(
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<void> {
  const config = requireR2Config();
  await getR2Client(config).send(
    new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType })
  );
}

export async function deleteMediaObject(key: string): Promise<void> {
  const config = requireR2Config();
  await getR2Client(config).send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: key })
  );
}

/**
 * Time-limited delivery URL for Meta ingestion. Created near publish time:
 * containers expire, and a stale URL must never be stored on the post.
 */
export async function getMediaDeliveryUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  const config = requireR2Config();
  return getSignedUrl(
    getR2Client(config),
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: expiresInSeconds }
  );
}

/**
 * Presigned PUT URL so the browser uploads bytes straight to R2: Vercel
 * serverless request bodies cap at ~4.5 MB, so media must never flow
 * through a Next.js route. The signed URL carries no credentials and only
 * permits this one PUT; the bucket still needs a CORS rule allowing PUT
 * from the app origin (see the confirm route / PR notes).
 */
export async function putMediaUploadUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 900
): Promise<string> {
  const config = requireR2Config();
  return getSignedUrl(
    getR2Client(config),
    new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds }
  );
}

/**
 * Fetch an uploaded object back for server-side validation. Refuses to
 * accumulate more than `maxBytes` so a lying Content-Length or a huge
 * object cannot blow up the serverless function.
 */
export async function getMediaObject(key: string, maxBytes: number): Promise<Buffer> {
  const config = requireR2Config();
  const response = await getR2Client(config).send(
    new GetObjectCommand({ Bucket: config.bucket, Key: key })
  );
  if (!response.Body) throw new Error(`R2 object ${key} has no body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`R2 object ${key} exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
