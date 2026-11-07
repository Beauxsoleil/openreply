# Instagram publishing — implementation contract

Status: foundation only. **Publishing is not enabled** by this change.

## Scope
Phase 1: Instagram professional account image/Reel drafts and scheduled publishing. Uses the existing Unified Login account, workspace permissions, Neon Postgres, Redis and Oracle worker. Never store media bytes in Neon; use private R2 storage with time-limited media delivery URLs valid for Meta ingestion.

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
- No implicit attachment to DM automations; future integration must explicitly bind the confirmed Instagram media ID after success.

## Required implementation before launch
1. Add a generated Prisma migration and test it against a disposable database.
2. Implement authenticated CRUD APIs, including ownership and scheduling validation.
3. Add R2 upload/presigned delivery handling, malware/type and media-format checks.
4. Implement a separate BullMQ publishing queue, startup reconciliation and Oracle worker process.
5. Implement Graph API container creation, processing polling, publish, outcome reconciliation, and permission checks.
6. Add calendar/composer/history UI in the Obsidian & Ember theme.
7. Test daylight-saving transitions, duplicate workers, timeout after successful publish, Meta errors, account disconnection, and demo-mode safety.
8. Enable behind a feature flag only after real account authorization and successful end-to-end test.

## Non-goals for first release
Stories, carousels, auto-activation of DM campaigns, best-time recommendations, and multi-platform publishing.
