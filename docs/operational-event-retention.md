# OperationalEvent retention + worker error-flood safeguards

## What happened (November 2026)

The DM worker failed every job for six days: Upstash Redis had exhausted
its 500,000-request quota, and a second failure surfaced as `WRONGPASS
invalid username-password pair`. Every failed BullMQ job wrote one
`OperationalEvent` row, failed jobs were removed after 300 s, and the
5-minute comment sweep re-enqueued the same comments — so the loop never
stopped. Result: ~2.3M rows / 816 MB in Neon, growing ~200 MB/day, and the
database nearly filled.

The safeguards below make that shape of failure impossible to repeat. They
were added in `fix/worker-error-flood` (Phase 5 of the emergency recovery).

## Safeguards

1. **Deduped error logging** (`lib/ops/error-log.ts`). Worker failure
   logging collapses identical errors into one row keyed by
   source + level + normalized message, with an `occurrences` count and
   `lastSeenAt` in the payload. The workspace lookup only runs when a new
   row is actually written, so duplicates cost no database queries.
   Dedupe window: 1 hour (`ERROR_LOG_DEDUPE_WINDOW_MS`).
2. **Rate-limited error logging** (same module). At most 10 new error rows
   per minute (`ERROR_LOG_MAX_NEW_ROWS_PER_MINUTE`); overflow is counted,
   and at most one summary row per 5 minutes reports how many rows were
   suppressed.
3. **Fail fast on Redis auth/quota errors** (`lib/queue/dm-worker.ts`,
   `lib/queue/redis-errors.ts`). A job that fails because Redis rejected
   auth or exhausted its quota throws `UnrecoverableError` — no BullMQ
   retries, because the next attempt fails identically. Ordinary transient
   errors still get the bounded 3-attempt retry with 5/15/45-minute
   backoff.
4. **Circuit breaker** (`lib/queue/worker-circuit.ts`). A quota or auth
   failure pauses the BullMQ consumer, so queued jobs stay queued instead
   of failing in a loop. The worker entrypoint re-checks Redis every
   minute; the breaker only pings once its resume interval has elapsed
   (default 5 min, `WORKER_CIRCUIT_RESUME_CHECK_MS`) and resumes on the
   first successful ping. Auth trips need a credential fix — they never
   self-heal, so the worker stays paused until Redis accepts the password.
5. **Bounded Redis reconnects** (`lib/queue/client.ts`,
   `lib/utils/rate-limiter.ts`). The shared BullMQ connection uses capped
   exponential backoff (100 ms doubling to 30 s) instead of re-dialling
   every couple of seconds forever, and its `error` events are logged at
   most once a minute. The rate limiter's own client (not a BullMQ
   connection) now fails fast: at most 2 retries per request, no offline
   queue, 3 s connect timeout.
6. **Retention prune** (`lib/ops/prune-operational-events.ts`,
   `scripts/prune-operational-events.ts`). Manual job, dry-run by
   default; see below.
7. **Growth monitoring** (`lib/ops/db-growth.ts`, `/api/health`). The
   health endpoint counts `OperationalEvent` rows written in the last hour
   and degrades (HTTP 503) at the critical threshold (default 5,000/hour;
   warning at 500/hour). Normal volume is a handful of rows per hour.

Deliberate one-off audit writes (follow-gate rejections, token-refresh
failures, sweep summaries) are low-volume by construction and keep writing
directly through Prisma; they are not routed through the deduper.

## Retention policy

`OperationalEvent` is the audit log, so the prune is narrow. It deletes
only:

- Repetitive Redis-failure `WORKER`/`ERROR` rows (Upstash quota /
  `WRONGPASS` messages) older than 7 days (`--older-than-days`). These
  carry no per-row information: the message is identical across millions
  of rows.
- Resolved rows (`resolvedAt` set) older than 30 days
  (`--resolved-older-than-days`).

Everything else is preserved: `INFO`/`WARNING` rows, unresolved errors,
non-Redis errors, token-refresh and system events — and all campaign,
`DmLog`, webhook, and publishing data, which the job never touches.

Deletes run in bounded batches (default 500 rows, `--batch-size`) with a
100 ms pause between batches, capped at 100,000 rows per run
(`--max-rows`); re-run to continue.

## Running the prune

Dry-run first (default — deletes nothing, reports the match count):

```sh
npm run prune:operational-events
npm run prune:operational-events -- --older-than-days 3 --max-rows 10000
```

To actually delete, back up Neon first (branch or restore point — verify
the backup is usable), then:

```sh
OPERATIONAL_EVENT_PRUNE_CONFIRM=1 npm run prune:operational-events -- --apply
```

Without both `--apply` and `OPERATIONAL_EVENT_PRUNE_CONFIRM=1` the script
refuses to delete. The script is never run automatically; run it by hand
when the health endpoint or the Neon console shows the table growing.

## After a prune

Deleted rows do not immediately shrink Neon's billed storage: Postgres
marks the space reusable, and Neon reclaims it as the branch's history
expires. While a backup branch exists, it pins the old pages
(copy-on-write), so project storage does not drop until that branch is
deleted after the cleanup is verified — deleting the backup branch needs
Joel's explicit approval. Verify the actual Neon usage in the console
after a prune rather than assuming the freed space. Do not run
`VACUUM FULL` near the storage limit — it needs substantial temporary
disk space.
