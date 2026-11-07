/**
 * Typed fetch wrappers for the publishing API contract.
 *
 * Code against the contract in the PR #16 brief; the route implementations
 * land in parallel, so these wrappers only assume the documented shapes:
 * every response is `{ success: true, data }` on success and
 * `{ success: false, error }` on failure.
 *
 * Pure fetch/URL/body logic lives here so it is unit-testable in node
 * (see __tests__/publishing-api-client.test.ts). The browser-only upload
 * helper uses XMLHttpRequest for progress; it is never called from tests.
 */

export type PostStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "PREPARING"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED"
  | "RECONCILE_REQUIRED"
  | "CANCELED";

export type PostKind = "IMAGE" | "REEL";

export interface MediaAssetSummary {
  id: string;
  mimeType: string;
  originalName?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

export interface MediaAsset extends MediaAssetSummary {
  byteSize: number;
  createdAt: string;
  previewUrl: string | null;
}

export interface ScheduledPost {
  id: string;
  caption: string;
  kind: PostKind;
  status: PostStatus;
  scheduledAt: string | null;
  timezone: string;
  publishedAt: string | null;
  instagramMediaId: string | null;
  lastError: string | null;
  attemptCount: number;
  automationId: string | null;
  automationActivateOnPublish: boolean;
  mediaAsset: MediaAssetSummary;
  instagramAccount: { id: string; username: string };
}

export interface PostAttempt {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string;
  errorCode: string | null;
}

export interface ScheduledPostDetail extends ScheduledPost {
  attempts: PostAttempt[];
}

export interface InstagramAccountOption {
  id: string;
  username: string;
  instagramId: string;
  name?: string | null;
}

export interface CampaignOption {
  id: string;
  name: string;
  isActive: boolean;
  instagramAccount: { username: string; instagramId: string };
}

export interface CreatePostInput {
  instagramAccountId: string;
  mediaAssetId: string;
  kind: PostKind;
  caption: string;
  scheduledAt?: string | null;
  timezone: string;
  automationId?: string | null;
  automationActivateOnPublish?: boolean;
}

export interface UpdatePostInput {
  caption?: string;
  scheduledAt?: string | null;
  timezone?: string;
  automationId?: string | null;
  automationActivateOnPublish?: boolean;
  /**
   * Not in the published PATCH contract (which lists only caption,
   * scheduledAt, timezone, automationId, automationActivateOnPublish).
   * Sent only by the cancel action; if the parallel API stream does not
   * accept it, the server error is surfaced and the post stays as-is.
   */
  status?: "CANCELED";
}

export interface UploadUrlResponse {
  uploadUrl: string;
  storageKey: string;
  expiresIn: number;
}

/** Error thrown by the wrappers; `status` is the HTTP status (0 = network). */
export class PublishingApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PublishingApiError";
    this.status = status;
  }
}

/**
 * Turn a raw API/server error into plain words for the UI. Technical
 * details are kept out: the user gets what happened and what to do next.
 */
export function toPlainError(error: unknown): string {
  if (error instanceof PublishingApiError) {
    if (error.status === 409)
      return "This media is already used by a scheduled post, so it can't be deleted yet. Cancel or delete that post first.";
    if (error.status === 401) return "Your session expired. Refresh the page and sign in again.";
    if (error.status === 403) return "You don't have permission to do that in this workspace.";
    if (error.status === 404) return "That item no longer exists. Refresh the list and try again.";
    if (error.status === 0) return "Couldn't reach the server. Check your connection and try again.";
    return error.message || "Something went wrong. Please try again.";
  }
  if (error instanceof Error) return error.message || "Something went wrong. Please try again.";
  return "Something went wrong. Please try again.";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new PublishingApiError("Couldn't reach the server.", 0);
  }
  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: T;
    error?: string;
  } | null;
  if (!response.ok || !payload?.success) {
    throw new PublishingApiError(
      payload?.error || `Request failed (${response.status})`,
      response.status
    );
  }
  return payload.data as T;
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function listPosts(): Promise<ScheduledPost[]> {
  return request<ScheduledPost[]>("/api/publishing/posts");
}

export async function getPost(id: string): Promise<ScheduledPostDetail> {
  return request<ScheduledPostDetail>(
    `/api/publishing/posts/${encodeURIComponent(id)}`
  );
}

export async function createPost(
  input: CreatePostInput
): Promise<{ id: string; status: PostStatus }> {
  return request<{ id: string; status: PostStatus }>(
    "/api/publishing/posts",
    jsonBody(input)
  );
}

export async function updatePost(
  id: string,
  input: UpdatePostInput
): Promise<ScheduledPost> {
  return request<ScheduledPost>(
    `/api/publishing/posts/${encodeURIComponent(id)}`,
    { ...jsonBody(input), method: "PATCH" }
  );
}

export async function deletePost(id: string): Promise<void> {
  await request<unknown>(`/api/publishing/posts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function retryPost(id: string): Promise<ScheduledPost> {
  return request<ScheduledPost>(
    `/api/publishing/posts/${encodeURIComponent(id)}/retry`,
    jsonBody({})
  );
}

export async function listMedia(
  kind?: PostKind | "ALL",
  q?: string
): Promise<MediaAsset[]> {
  const params = new URLSearchParams();
  if (kind && kind !== "ALL") params.set("kind", kind);
  if (q?.trim()) params.set("q", q.trim());
  const suffix = params.size ? `?${params}` : "";
  return request<MediaAsset[]>(`/api/publishing/media${suffix}`);
}

export async function getMedia(id: string): Promise<MediaAsset> {
  return request<MediaAsset>(
    `/api/publishing/media/${encodeURIComponent(id)}`
  );
}

export async function requestUploadUrl(input: {
  fileName: string;
  mimeType: string;
  byteSize: number;
  kind: PostKind;
}): Promise<UploadUrlResponse> {
  return request<UploadUrlResponse>(
    "/api/publishing/media/upload-url",
    jsonBody(input)
  );
}

export async function confirmMedia(input: {
  storageKey: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  kind: PostKind;
}): Promise<MediaAsset> {
  return request<MediaAsset>("/api/publishing/media/confirm", jsonBody(input));
}

export async function deleteMedia(id: string): Promise<void> {
  await request<unknown>(`/api/publishing/media/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * Connected Instagram accounts. Reuses GET /api/instagram/accounts — the
 * lightweight list endpoint (the Settings page uses the heavier
 * /api/dashboard/stats aggregation, which this page does not need).
 */
export async function listInstagramAccounts(): Promise<{
  instagramAccounts: InstagramAccountOption[];
  selectedInstagramAccountId: string | null;
}> {
  return request<{
    instagramAccounts: InstagramAccountOption[];
    selectedInstagramAccountId: string | null;
  }>("/api/instagram/accounts");
}

/**
 * DM-automation campaigns for the "activate after publishing" picker.
 * Reuses GET /api/automations, the same endpoint the Campaigns page lists.
 */
export async function listCampaigns(): Promise<CampaignOption[]> {
  return request<CampaignOption[]>("/api/automations");
}

/**
 * Upload a file end to end: presigned URL -> PUT bytes (with progress) ->
 * confirm. Browser-only (XMLHttpRequest upload progress); callers in node
 * tests should not use it.
 */
export async function uploadMediaFile(
  file: File,
  kind: PostKind,
  onProgress?: (fraction: number) => void
): Promise<MediaAsset> {
  const { uploadUrl, storageKey } = await requestUploadUrl({
    fileName: file.name,
    mimeType: file.type,
    byteSize: file.size,
    kind,
  });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new PublishingApiError(`Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new PublishingApiError("Couldn't reach the server.", 0));
    xhr.send(file);
  });
  return confirmMedia({
    storageKey,
    originalName: file.name,
    mimeType: file.type,
    byteSize: file.size,
    kind,
  });
}
