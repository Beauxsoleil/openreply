/**
 * Instagram Content Publishing client (Meta Graph API).
 *
 * Verified 2026-11-07 against Meta's documentation:
 * - Content Publishing guide:
 *   https://developers.facebook.com/docs/instagram-platform/content-publishing/
 * - IG User media reference (container create):
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
 * - media_publish reference:
 *   https://developers.facebook.com/docs/instagram-api/reference/user/media_publish
 * (Direct fetches of developers.facebook.com from this VM returned HTTP 403
 * on 2026-11-07, so the endpoints below were verified against Meta's docs as
 * surfaced by web search plus the corroborating references above; re-check
 * them against the live docs before the first real publish.)
 *
 * Flow (same on both hosts; only the base URL and permission name differ):
 *   1. POST /{ig-user-id}/media — create a container.
 *      Image: { image_url, caption } (media_type is IMAGE by default).
 *      Reel:  { media_type: "REELS", video_url, caption, cover_url? }.
 *      `cover_url` wins over `thumb_offset` when both are sent, so this
 *      client sends at most one of them (cover_url only).
 *      Returns { id } — the container id, NOT a published post.
 *   2. GET /{container-id}?fields=status_code — poll until FINISHED.
 *      status_code values: IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED.
 *      Containers expire 24h after creation if never published.
 *      Meta's guidance is to poll about once a minute for up to ~5 minutes;
 *      the publisher polls every ~10s for up to 10 minutes so large Reels
 *      get more time, and treats a timeout as unknown-outcome.
 *   3. POST /{ig-user-id}/media_publish { creation_id } — publishes the
 *      container. Returns { id } — the Instagram media id of the live post.
 *   4. GET /{media-id}?fields=id,permalink,media_type,media_product_type
 *      — read back the permalink. A Reel reads back as media_type VIDEO
 *      with media_product_type REELS.
 *
 * Permissions — the two hosts use DIFFERENT permission names for the same
 * capability, and a messaging token cannot publish:
 *   - facebook host (Unified Login, graph.facebook.com):
 *     `instagram_content_publish`
 *   - instagram host (Instagram Login, graph.instagram.com):
 *     `instagram_business_content_publish`
 * `checkPublishPermission` probes the token's granted scopes via
 * `debug_token` and throws a PermissionError naming the missing permission
 * instead of letting the container create fail opaquely. The app's Unified
 * Login config currently does NOT include `instagram_content_publish`, so
 * live publishing fails this probe until the permission is added in the
 * Meta console and the system-user token is regenerated (see
 * docs/meta-app.md §13.2).
 *
 * Media must sit at a publicly reachable HTTPS URL when the container is
 * created — Meta downloads it; there is no binary upload endpoint. OpenReply
 * passes a time-limited R2 presigned delivery URL created near publish time.
 * Limit: 100 API-published posts per Instagram account per rolling 24h.
 */

import {
  debugToken,
  graphBaseFor,
  handleResponse,
  PermissionError,
  TokenExpiredError,
  type MetaGraphHost,
} from "./client";

/** The publish permission for a host — the names differ, the capability is the same. */
export function getPublishPermission(host: MetaGraphHost): string {
  return host === "facebook"
    ? "instagram_content_publish"
    : "instagram_business_content_publish";
}

function requireHttpsUrl(url: string, field: string): void {
  if (!/^https:\/\//.test(url)) {
    throw new Error(
      `Meta can only ingest media from a public HTTPS URL (${field} must start with https://)`
    );
  }
}

async function postJson<T>(
  url: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(response);
}

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return handleResponse<T>(response);
}

export interface CreateContainerArgs {
  accessToken: string;
  instagramAccountId: string;
  caption?: string;
  host: MetaGraphHost;
}

/**
 * Create a single-image container.
 * POST /{ig-user-id}/media { image_url, caption } -> { id: containerId }
 */
export async function createImageContainer(args: {
  accessToken: string;
  instagramAccountId: string;
  imageUrl: string;
  caption?: string;
  host: MetaGraphHost;
}): Promise<{ id: string }> {
  requireHttpsUrl(args.imageUrl, "imageUrl");
  return postJson<{ id: string }>(
    `${graphBaseFor(args.host)}/${args.instagramAccountId}/media`,
    args.accessToken,
    {
      image_url: args.imageUrl,
      ...(args.caption ? { caption: args.caption } : {}),
    }
  );
}

/**
 * Create a Reel container.
 * POST /{ig-user-id}/media { media_type: "REELS", video_url, caption, cover_url? }
 * -> { id: containerId }
 */
export async function createReelContainer(args: {
  accessToken: string;
  instagramAccountId: string;
  videoUrl: string;
  caption?: string;
  coverUrl?: string;
  host: MetaGraphHost;
}): Promise<{ id: string }> {
  requireHttpsUrl(args.videoUrl, "videoUrl");
  if (args.coverUrl) requireHttpsUrl(args.coverUrl, "coverUrl");
  return postJson<{ id: string }>(
    `${graphBaseFor(args.host)}/${args.instagramAccountId}/media`,
    args.accessToken,
    {
      media_type: "REELS",
      video_url: args.videoUrl,
      ...(args.caption ? { caption: args.caption } : {}),
      // cover_url takes precedence over thumb_offset on Meta's side; send
      // only cover_url, never both.
      ...(args.coverUrl ? { cover_url: args.coverUrl } : {}),
    }
  );
}

/** Raw container status values Meta returns in `status_code`. */
export type ContainerStatusCode =
  | "IN_PROGRESS"
  | "FINISHED"
  | "ERROR"
  | "EXPIRED"
  | "PUBLISHED";

export interface ContainerStatus {
  id: string;
  status: ContainerStatusCode;
}

/**
 * Poll a container's processing status.
 * GET /{container-id}?fields=status_code -> { id, status }
 */
export async function getContainerStatus(args: {
  accessToken: string;
  containerId: string;
  host: MetaGraphHost;
}): Promise<ContainerStatus> {
  const url = new URL(
    `${graphBaseFor(args.host)}/${args.containerId}`
  );
  url.searchParams.set("fields", "status_code");
  url.searchParams.set("access_token", args.accessToken);
  const data = await getJson<{ id: string; status_code: ContainerStatusCode }>(
    url.toString(),
    args.accessToken
  );
  return { id: data.id, status: data.status_code };
}

/**
 * Publish a finished container.
 * POST /{ig-user-id}/media_publish { creation_id } -> { id: instagramMediaId }
 */
export async function publishContainer(args: {
  accessToken: string;
  instagramAccountId: string;
  containerId: string;
  host: MetaGraphHost;
}): Promise<{ id: string }> {
  return postJson<{ id: string }>(
    `${graphBaseFor(args.host)}/${args.instagramAccountId}/media_publish`,
    args.accessToken,
    { creation_id: args.containerId }
  );
}

export interface PublishedMedia {
  id: string;
  permalink?: string;
  media_type: string;
  media_product_type?: string;
}

/**
 * Read back a published post (permalink + types).
 * GET /{media-id}?fields=id,permalink,media_type,media_product_type
 * A Reel reads back as media_type VIDEO with media_product_type REELS.
 */
export async function getPublishedMedia(args: {
  accessToken: string;
  mediaId: string;
  host: MetaGraphHost;
}): Promise<PublishedMedia> {
  const url = new URL(`${graphBaseFor(args.host)}/${args.mediaId}`);
  url.searchParams.set(
    "fields",
    "id,permalink,media_type,media_product_type"
  );
  url.searchParams.set("access_token", args.accessToken);
  return getJson<PublishedMedia>(url.toString(), args.accessToken);
}

/**
 * Probe the token's granted scopes and confirm the publish permission for
 * this host is present. Throws a PermissionError naming the missing
 * permission — never let a publish proceed on a messaging-only token and
 * fail opaquely at container creation.
 *
 * Uses the existing `debugToken` helper with the token debugging itself:
 * Meta's /debug_token accepts a user access token belonging to the same app
 * as the inspecting token. A token that is not valid at all throws
 * TokenExpiredError. `debugToken` always reads graph.facebook.com, which is
 * where token inspection lives for both hosts.
 */
export async function checkPublishPermission(args: {
  accessToken: string;
  host: MetaGraphHost;
}): Promise<{ permission: string; scopes: string[] }> {
  const required = getPublishPermission(args.host);
  const result = await debugToken(args.accessToken, args.accessToken);
  const data = result.data;
  if (data && data.is_valid === false) {
    throw new TokenExpiredError(
      "Instagram access token is not valid (debug_token reports is_valid=false)"
    );
  }
  const scopes = data?.scopes ?? [];
  if (!scopes.includes(required)) {
    throw new PermissionError(
      `Token is missing the ${required} permission required to publish to Instagram ` +
        `(host ${args.host}). Add ${required} to the Meta app's login configuration ` +
        `and regenerate the token; a messaging-only token cannot publish.`
    );
  }
  return { permission: required, scopes };
}
