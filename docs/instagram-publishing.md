# Instagram publishing — implementation contract

Status: **implemented on `feature/instagram-publishing-foundation` (PR #16),
not yet launched.** All components below exist and are tested; the launch
gates in "Before first publish" are still open.

## Scope
Phase 1: Instagram professional account image/Reel drafts and scheduled publishing. Uses the existing Unified Login account, workspace permissions, Neon Postgres, Redis and Oracle worker. Never store media bytes in Neon; use private R2 storage with time-limited media delivery URLs valid for Meta ingestion.

## What is implemented (PR #16)
- **Data model + migration** `prisma/migrations/20261107184400_add_publishing_models`:
  `MediaAsset`, `ScheduledPost` (incl. atomic `leaseUntil`, `containerId`,
  `instagramMediaId`, optional DM-automation link), `PublishAttempt`.
- **Media storage** (`lib/publishing/r2.ts`, `lib/publishing/media-validation.ts`):
  presigned-PUT uploads (bytes never flow through Next.js), magic-byte
  sniffing, image dimensions via `image-size`, hand-rolled MP4/MOV box
  parser, Meta limits enforced (JPEG ≤ 8 MB, 4:5–1.91:1 for feed images;
  MP4/MOV 3 s–15 min, ≤ 300 MB for Reels). Media library, deletion
  (blocked while a non-canceled post references the asset), 1-hour
  presigned delivery URLs created near publish time.
- **Publishing API** (`app/api/publishing/posts`, `app/api/publishing/media`):
  create/edit draft, schedule, reschedule, cancel, delete draft, list,
  detail + attempt history, safe retry (FAILED only). Workspace roles and
  account ownership enforced; demo accounts refused. UTC internally, IANA
  timezones for display/scheduling (`lib/publishing/timezone.ts`, DST
  gap resolves forward, fall-back fold resolves to the earlier occurrence).
  **Format guard:** feed images must be JPEG, Reels must be MP4/MOV at
  schedule time — PNG/WebP uploads are accepted by the library but cannot
  publish (no server-side conversion in this PR).
- **Meta publishing** (`lib/meta/publishing.ts`): media container creation,
  processing-status polling, publish, permalink confirmation, and a
  permission probe (`checkPublishPermission`) that fails clearly when
  `instagram_content_publish` is missing from the token. Works on both
  Graph hosts; Unified Login accounts use `instagram_content_publish`,
  Instagram Login accounts use `instagram_business_content_publish`.
- **Worker** (`lib/queue/publishing.ts`, `lib/publishing/publisher.ts`,
  `lib/publishing/reconciler.ts`, `worker/publishing-worker.ts`):
  separate `publishing` BullMQ queue, deterministic `publish_<postId>`
  job ids, Postgres as the authoritative schedule, atomic lease claiming,
  exponential backoff, per-step `PublishAttempt` audit rows, startup +
  interval reconciliation (rebuilds queue jobs after restarts, recovers
  stale leases). A publish whose outcome is unknown (timeout after
  submit) lands in `RECONCILE_REQUIRED` and is never blindly retried.
  Heartbeats are per-worker (`health:worker:publishing`), separate from
  the DM worker. Run as `npm run worker:publishing` alongside the DM
  worker; it does not touch DM logic.
- **UI** (`app/(dashboard)/publishing`): Later-style studio in the
  Obsidian & Ember theme — calendar (month/week/list), composer (upload
  with progress, caption, account, date/time + timezone, phone-frame
  preview, optional DM-automation picker), media library, publishing
  history (published/failed with error text, Instagram account links,
  safe retry). Mobile-first.
- **DM-automation attachment:** a scheduled post may link an existing
  comment-to-DM campaign. Only after a successful publish is the real
  Instagram media ID bound to the campaign (`Automation.postId`) and the
  campaign activated — and only when `automationActivateOnPublish` was
  explicitly set. Never for failed or canceled posts.

## Permissions and safeguards
- Verify the current Meta app and account are eligible for `instagram_content_publish` before enabling scheduling.
- Never publish from demo accounts, expired/invalid tokens or disconnected accounts.
- Enforce workspace membership and account ownership on every read/write. Reject media belonging to another workspace.
- Validate image/video encoding, dimensions, duration, file size, and caption against the live Graph API version.
- Store a UTC `scheduledAt` plus the user-selected IANA timezone; preserve intended wall time across daylight saving transitions.
- Create Meta media containers near publish time; they expire and must not be created when drafting weeks in advance.
- Use database-backed schedule as source of truth; Redis jobs may be rebuilt after restart.
- Acquire an atomic database lease before processing; only one worker may publish a post.
- If a publish request times out after submission, mark `RECONCILE_REQUIRED`; do not blindly retry and risk duplicate posts.
- Poll media processing and check rate limits; retry transient errors with bounded backoff and persist audit attempts.
- No implicit attachment to DM automations; binding happens only after a confirmed publish, only when explicitly requested.

## Before first publish (launch gates — all still open)
1. **Migration:** apply `20261107184400_add_publishing_models` to Neon.
   It only adds new tables; safe to apply before merging. From a host
   that can reach Neon (this VM cannot — its egress proxy breaks TLS to
   port 5432; use Oracle Cloud Shell on the worker VM):
   `git fetch && git checkout feature/instagram-publishing-foundation && git pull`
   then `DIRECT_URL='<Neon direct URL>' npx prisma migrate deploy`.
   The migration was verified end-to-end against a disposable local
   Postgres (all migrations in order, tables/indexes/FKs, smoke
   insert/read-back).
2. **Meta permission:** add `instagram_content_publish` to the Unified
   Login configuration (docs/meta-app.md §13.2), then **regenerate the
   system-user token** and re-paste it in Settings (§13.3–13.4). A token
   issued before the permission was added does not gain it. No second
   Meta app needed. Standard Access covers Joel's own accounts; Advanced
   Access/App Review only matters for publishing on accounts he does not
   own.
3. **R2 bucket + keys:** create a private Cloudflare R2 bucket and an API
   token, set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` in Vercel (Production + Preview)
   and in the publishing worker's environment. Add a CORS rule to the
   bucket allowing `PUT` from `https://openreply-seven-rose.vercel.app`
   (AllowedHeaders `Content-Type`, ExposeHeaders `ETag`).
4. **Worker deploy:** on the Oracle VM, run the publishing worker as a
   second long-lived process (`npm run worker:publishing`) with
   `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, the R2 vars, plus
   `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` (the permission probe
   must call `debug_token` with the app access token as the caller — a
   system-user token cannot inspect itself). The reconciler rebuilds
   queue jobs after restarts; no manual re-enqueue.
5. **End-to-end test:** schedule a test post on the real account and
   confirm it publishes, then delete it from Instagram. Do not claim live
   publishing works until that test passes.

## Known limitations
- PNG/WebP uploads cannot publish (JPEG only for feed images); rejected
  at schedule time with a re-upload message. No server-side conversion.
- No Stories, carousels, best-time recommendations, or multi-platform
  publishing. No feature flag: scheduling is available once deployed,
  and publishes fail cleanly with a named `PermissionError` until the
  Meta permission + token are in place.
- Meta limits: 100 API-published posts per account per rolling 24h;
  media containers expire 24h after creation.
- Reels cover image is not yet supported (Meta `cover_url` is wired in
  the client but the composer does not collect one).
- `checkPublishPermission` inspects the publishing token via
  `debug_token`, calling it with the app access token
  (`INSTAGRAM_APP_ID|INSTAGRAM_APP_SECRET`) as the caller — a
  system-user token cannot inspect itself (Meta #100). The publishing
  worker needs both vars in its environment.

## Non-goals for first release
Stories, carousels, auto-activation of DM campaigns, best-time recommendations, and multi-platform publishing.
