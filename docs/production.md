# OpenReply — Production Operations Guide (Railway)

> **Who this is for:** Joel, the owner-operator. You manage this from an
> iPhone or a browser. You do not need to be a DevOps engineer to run it.
> This guide explains every step in plain language, and says plainly where
> something still needs to be confirmed in the Railway or Resend dashboard,
> because no Railway account exists yet and this deployment has not been
> built. Anything marked **(verify)** below is not yet confirmed against a
> live Railway account — check it in the dashboard before you rely on it.
>
> **What this guide does not do:** it does not change the app, demo-mode
> guards, or the Meta send path. It is operations only: deploy it, keep it
> running, fix it when it stops, and keep it safe.
>
> **Status at writing:** the code is on branch `feature/railway-deploy-prep`
> (based on `main` at `21ddd07`). The Meta integration comes **later** — no
> live Instagram messaging is claimed by this guide, and the Meta variables
> stay unset until that separate setup. Demo mode is for local testing only
> (see [docs/demo.md](demo.md)) and must never be turned on in production.

Related docs:

- [docs/setup.md](setup.md) — the full setup walkthrough (Vercel web app +
  Railway worker/databases is the path it describes; this guide moves the
  web app to Railway too, so read the two together)
- [docs/deploy-docker.md](deploy-docker.md) — the same services on plain
  Docker Compose; the concepts, health checks, and backup commands here
  come from that guide
- [docs/deploy-dokploy.md](deploy-dokploy.md) — the same services on
  Dokploy; especially useful for the cron explanation
- [docs/meta-app.md](meta-app.md) — the Meta app setup (for later, not now)
- [docs/demo.md](demo.md) — demo mode (local only, never production)

---

## 1. Infrastructure overview — what runs where

OpenReply is **two programs and two databases**, plus email. All five
pieces have to be running or something silently stops working.

| Piece | Where it runs (Railway plan) | What it does, in one line |
| --- | --- | --- |
| **Web app** | Railway service, from the repo's `Dockerfile` | Shows the dashboard, takes sign-ins, receives Instagram webhooks |
| **Worker** (`openreply-worker`) | Separate Railway service, same repo and image, command `npm run worker` | Sends the DMs — the only part that actually delivers a message |
| **Postgres** | Railway managed Postgres | Stores everything: campaigns, accounts, tokens, logs, workspaces |
| **Redis** | Railway managed Redis | Holds the send queue (BullMQ) and the per-account rate limiter |
| **Resend** | Resend (outside Railway) | Sends the magic-link emails you sign in with |

Plain-language picture: someone comments on Instagram → Meta calls your
web app → the web app puts a "send this DM" job in the Redis queue → the
worker picks the job up and sends the DM → everything about it is recorded
in Postgres. If the worker stops, comments still arrive and are recorded,
but **no DM ever goes out**. That is the single most common "it stopped
working" — check the worker first.

Other facts that shape everything else in this guide:

- The web app and the worker **must share the same `DATABASE_URL`,
  `REDIS_URL`, and `ENCRYPTION_KEY`**. The web app encrypts the Instagram
  token with `ENCRYPTION_KEY`; the worker decrypts it to send. Different
  keys mean every send fails. (Verified in `docs/setup.md`,
  `docs/deploy-docker.md`, and `lib/env.ts`.)
- The web app is the **only** service with a public web address. The
  worker, Postgres, and Redis have no public domain and are reached over
  Railway's private network.
- The public address is plain HTTPS. Meta will not accept `http://`, an IP
  address, or `localhost` for webhooks or logins.
- Railway provides `DATABASE_URL` and `REDIS_URL` from the managed
  Postgres and Redis services. You do not type those in by hand — you link
  the services and Railway fills them in. Use the private (internal)
  addresses for services inside Railway; the public proxy addresses exist
  only for connecting from outside Railway, e.g. running a migration from
  your own machine. (See §4 and §5.)
- This plan replaces the Docker Compose layer in
  `docker-compose.prod.yml` — Railway runs the same services and concepts,
  but you do not run Docker commands yourself.

---

## 2. Service names and purposes

| Service (Railway) | Purpose |
| --- | --- |
| **Web app** (name it something clear, e.g. `openreply-web`) | Next.js dashboard, sign-in, OAuth callback, webhook receiver. Built from the repo `Dockerfile` (multi-stage, Node 20.19.0-slim). Its health check is `GET /api/health` (see §7). Default command is `npm run start`. |
| **Worker** (`openreply-worker`) | The long-running send process. Same repo, same image as the web app, but its start command is `npm run worker` instead of `npm run start`. **No public domain.** If this service is stopped, no DM sends. |
| **Postgres** (Railway managed Postgres) | The database. Campaigns, accounts, tokens, DM logs, workspaces, sessions. Back it up — see §6. |
| **Redis** (Railway managed Redis) | The queue and rate limiter. Must support blocking commands (BullMQ needs them); an HTTP-only Redis will not work. If Redis data is lost, queued-but-unsent DMs are lost with it; comments already received stay in Postgres. |

### The cron scheduler — the fourth job nobody sees

Three small scheduled jobs live under `/api/cron` in the app:

| Job | What it does | How often |
| --- | --- | --- |
| `refresh-tokens` | Renews Instagram tokens before they expire | Once a day (05:00 UTC in `scripts/cron.sh`) |
| `attach-next-reel` | Binds a campaign created ahead of time to the reel published after it | Every 5 minutes |
| `snapshot-followers` | Records follower counts (Instagram only keeps ~30 days of history) | Once a day (05:00 UTC in `scripts/cron.sh`) |

**`refresh-tokens` is the one that hurts if it never runs.** The token
expires and every automation stops — with no error anywhere. Comments keep
arriving and nothing answers them. (`docs/deploy-dokploy.md` and
`scripts/cron.sh` both call this out.)

On Vercel these jobs run from the `crons` block in `vercel.json`. **Nothing
outside Vercel reads that file**, so on Railway they simply never run
unless you provide a scheduler. The repo ships the scheduler as
`scripts/cron.sh`: a loop that calls `attach-next-reel` every 5 minutes and
the other two once a day, using `CRON_SECRET` (or `NEXTAUTH_SECRET` as a
fallback) to call the web app's `/api/cron/*` routes.

How that maps to Railway — two plain options, no design invented here:

1. **A separate small service** from the same repo/image, running
   `sh scripts/cron.sh`, with `CRON_BASE_URL` set to the web app's
   internal address and `CRON_SECRET` set to the same value as the web
   app. This is the same pattern as `docker-compose.prod.yml` (the `cron`
   service there) and `docs/deploy-dokploy.md`. It is the option this
   guide recommends, because it matches what the repo already ships.
2. **A Railway scheduled job / cron, if your Railway plan offers one**
   **(verify)** — a job that calls the same `/api/cron/*` URLs on a
   schedule. This guide does **not** claim Railway offers this, what it is
   called, or how to configure it: confirm in the Railway dashboard
   before choosing it. If you use it, the schedule to aim for is the one
   in `scripts/cron.sh` (every 5 minutes for `attach-next-reel`, daily for
   the other two).

Whichever you pick, verify it the same way: after the first day, the cron
logs should show `attach-next-reel ok ...` every 5 minutes and
`refresh-tokens ok` / `snapshot-followers ok` once a day (see §7). A
`FAILED` line means a scheduled job is not running.

> Do **not** rely on the worker alone for these jobs. The worker runs its
> own comment-polling sweep every few minutes (a safety net for comments
> the webhook missed), but it does not run the token refresh.

---

## 3. Deploy process

> **(Verify)** — No Railway account exists yet, so the exact Railway
> dashboard labels, the default auto-deploy setting, and the exact click
> path below have **not** been confirmed against a live account. The steps
> are the plan the coordinator verified; if a screen looks different,
> follow its intent and note the difference rather than guessing.

### First deploy, in order

1. **Create a Railway account and a new project.**
2. **Add Postgres, then Redis.** In the project, add a PostgreSQL service
   and a Redis service (Railway's managed databases). Note their service
   names — you will link them to the app services next.
3. **Add the web app.** Add a service from the GitHub repo
   `Beauxsoleil/openreply`, branch `main`. Railway builds it from the
   repo's `Dockerfile`. Give it a public domain in the service settings —
   that domain becomes your public URL (see `NEXTAUTH_URL` in §4). This is
   the **only** service that gets a public domain.
4. **Add the worker.** Add a second service from the **same repo and
   branch**, named `openreply-worker`. Same image, but set its start
   command to `npm run worker` and give it **no public domain**.
   (In Docker terms this is the `worker` service in
   `docker-compose.prod.yml` with `command: ["npm", "run", "worker"]`.)
5. **Set the environment variables** on both services (§4). The web app
   and worker must have identical `DATABASE_URL`, `REDIS_URL`, and
   `ENCRYPTION_KEY`. Railway fills in `DATABASE_URL` / `REDIS_URL` when
   you link the Postgres/Redis services — use the private (internal)
   addresses inside Railway.
6. **Set `NEXTAUTH_URL`** on both services to the web app's public domain
   (e.g. `https://<your-railway-domain>` — fill in the real domain after
   Railway assigns it; do not guess it). No trailing slash.
7. **Run the database migrations** (§5) before the first real use — or
   confirm the deploy ran them (see below).
8. **Add the cron scheduler** (§2) — a separate small service running
   `sh scripts/cron.sh`, or a Railway scheduled job if one is available
   **(verify)**.
9. **Check it worked** (see "How to check it worked" below).

### How a deploy is triggered

- **Push to `main` deploys.** When a change is merged to the `main`
  branch on GitHub, Railway builds the new image and rolls it out to the
  web and worker services. **(Verify)** the auto-deploy setting in each
  service's settings — confirm it is on for `main` and that it deploys
  after checks pass, before you rely on it.
- **A manual redeploy** from the Railway dashboard redeploys the
  currently deployed commit without a new push (see §9).
- **Migrations are not part of the build.** The Docker build has no
  database to reach, so `prisma migrate deploy` cannot run during the
  build. Run migrations as a separate step (§5) after the deploy, before
  you call the new version good. (The same rule is stated in
  `docs/deploy-docker.md` and `docs/deploy-dokploy.md`.)

### How to check it worked

1. Open `https://<your-railway-domain>/api/health` in the iPhone browser.
   You want `{"status":"ok", ...}` with every check `ok`:
   - `database` / `redis` — the datastores are reachable.
   - `queue` — the send queue is not stuck.
   - `worker.healthy` — the worker has sent a recent heartbeat. If this
     is `false`, the worker is not running or cannot reach Redis, and no
     DM will ever send even though webhooks are being received.
   - If anything is wrong it answers `503` with `status: "degraded"` and a
     per-check `detail` — read that before guessing.
2. Open the dashboard at your public URL, request a magic link with an
   allowlisted email, and sign in. (Email must work first — see §8.)
3. Check the worker service logs show `[DM Worker] Started` and no
   startup error (see §7).
4. Only then connect Instagram / test a campaign. The end-to-end test is
   in [docs/setup.md](setup.md#test-it-end-to-end) and
   [docs/meta-app.md](meta-app.md#10-publish-a-test-campaign-and-verify-a-real-dm)
   — but remember Meta setup comes **later**; do not do it as part of
   this deploy.

---

## 4. Environment variable reference

**Rules for this whole table:**

- Set variables in **Railway → each service → Variables**. Never put them
  in the repo, in a chat message, or in a GitHub issue.
- No secret values are in this guide. Placeholders like
  `replace-with-...` mean "generate a real one" (§4.1).
- Web and worker must have **identical** `DATABASE_URL`, `REDIS_URL`,
  and `ENCRYPTION_KEY`.
- `NEXTAUTH_URL` must be the same public domain on both services.
- Meta variables stay **unset** until the Meta setup (later). Zernio
  credentials, if ever used, are saved in Settings, not in environment
  variables — there are no `ZERNIO_*` variables.
- `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` appear in
  `.env.production.example` for Docker Compose only. **On Railway you do
  not set them** — the managed Postgres service provides `DATABASE_URL`
  for you.

### 4.1 Secrets-generation checklist — do this first

Generate each secret **once**, on a computer (Terminal on a Mac, or any
shell), and paste the output straight into Railway's Variables — never
into chat, an issue, or a file that gets committed. Generate fresh ones
for production; **never reuse dev secrets** from `.env` or Codespaces.

```bash
# NEXTAUTH_SECRET — session secret (any strong random string)
openssl rand -base64 32

# CRON_SECRET — protects the /api/cron routes
openssl rand -base64 32

# ENCRYPTION_KEY — MUST be exactly 64 hex characters (32 bytes)
openssl rand -hex 32

# WEBHOOK_VERIFY_TOKEN — for later, when Meta is set up
openssl rand -base64 32
```

Checklist:

- [ ] `NEXTAUTH_SECRET` generated, pasted into Railway (web **and**
      worker), nowhere else.
- [ ] `CRON_SECRET` generated, pasted into Railway (web, worker, **and**
      the cron service if you run one), nowhere else.
- [ ] `ENCRYPTION_KEY` generated with `openssl rand -hex 32`, is exactly
      64 hex characters, identical on web and worker. **Back it up in a
      password manager.** Losing it means every connected Instagram
      account has to reconnect — there is no way to recover it from the
      database.
- [ ] `WEBHOOK_VERIFY_TOKEN` generated and saved for later (Meta setup).
      Do not paste it into Meta yet — Meta comes later.
- [ ] Nothing pasted into chat, email, or an issue. If a secret ever is,
      rotate it immediately (see §12).

### 4.2 The table

"Required" means the app will not start, sign anyone in, or send a DM
without it. "Optional" means the app runs without it — the table says what
you lose. Defaults are the values the code uses when a variable is unset,
verified in the source files named in the last column.

| Variable | Required? | What breaks without it / what it does | Where the value comes from |
| --- | --- | --- | --- |
| `NEXTAUTH_URL` | **Required** | Must be your public HTTPS URL, no trailing slash (e.g. `https://<your-railway-domain>`). Magic-link emails, OAuth redirects, and tracked links in DMs all point at it. Wrong value = sign-in fails and Meta redirects fail. The app's core validation (`lib/env.ts`) requires it to be a valid URL. | Railway: the public domain Railway assigns to the web service. Set it **after** the domain exists, on web **and** worker. |
| `NEXTAUTH_SECRET` | **Required** | Signs sessions. Missing or under 16 characters = the app refuses to start (`lib/env.ts` requires min 16). Rotating it signs everyone out. | Generated: `openssl rand -base64 32` (§4.1). Same value on web and worker. |
| `DATABASE_URL` | **Required** | Postgres connection string. Without it the app throws `DATABASE_URL environment variable is required` (`lib/db/client.ts`) and nothing works — no dashboard, no logins, no sends. | **Railway-provided.** Link the managed Postgres service; Railway fills this in. Inside Railway use the private (internal) address; the public proxy address is only for connecting from outside Railway (e.g. a migration from your machine). |
| `REDIS_URL` | **Required** | Redis connection string for the BullMQ queue and rate limiter. Without it the queue cannot run and no DM sends. Must support blocking commands — an HTTP-only Redis will not work. | **Railway-provided.** Link the managed Redis service; Railway fills this in. Same private-vs-public rule as `DATABASE_URL`. |
| `CRON_SECRET` | Required in practice | Protects `/api/cron/*` (token refresh, reel attach, follower snapshot). If unset, the routes fall back to `NEXTAUTH_SECRET` (`app/api/cron/*/route.ts`, `scripts/cron.sh`) — so the jobs still work, but set a separate `CRON_SECRET` anyway so a leaked cron secret does not also sign sessions. The cron service exits immediately if neither is set. | Generated: `openssl rand -base64 32` (§4.1). Same value on web, worker, and the cron service. |
| `ENCRYPTION_KEY` | **Required** | Encrypts Instagram tokens and provider credentials at rest. Must be **exactly 64 hex characters** or the app throws on boot (`ENCRYPTION_KEY must be a 32-byte hex string`, `lib/env.ts`). If web and worker differ, every send fails to decrypt. If lost or changed, every connected Instagram account must reconnect. | Generated: `openssl rand -hex 32` (§4.1). Same value on web and worker. Back it up in a password manager. |
| `WEBHOOK_VERIFY_TOKEN` | Required for Meta, **unset for now** | Meta sends this value when it verifies your webhook callback; a mismatch means "Verify and save" fails in Meta's console. Not used until Meta setup. | Generated: `openssl rand -base64 32` (§4.1). Later, paste the **same** value into Meta's webhook config. Leave unset on Railway until then. |
| `RESEND_API_KEY` | **Required** (unless `EMAIL_SERVER` is set) | Login is email magic links only — without working email, nobody can sign in. Missing key = sign-in emails never send. | Resend dashboard: create an account, verify a sender domain, create an API key, paste it in. |
| `EMAIL_FROM` | **Required** | The sender address on magic-link emails, e.g. `OpenReply <login@example.com>`. Must be on a domain you verified in Resend — the placeholder will not deliver. | Resend: an address on your verified sender domain. |
| `EMAIL_SERVER` | Optional (SMTP alternative) | If set, magic links go through your own SMTP server instead of Resend, and `RESEND_API_KEY` is not needed. Format e.g. `smtps://login%40example.com:password@mail.example.com:465` (port 465 = implicit TLS; port 587 with `smtp://` = STARTTLS). URL-encode special characters (`@` → `%40`). | Your own mail server, if you run one. Leave unset if you use Resend. |
| `ALLOWED_EMAILS` | Required in practice | Comma-separated allowlist of who may sign in (case-insensitive), e.g. `you@example.com`. **If unset, anyone who reaches your public URL can request a magic link and gets their own workspace.** Set it to just your own address(es) before going live. | Your own email address(es) — you type them in. |
| `DEMO_MODE` | **Must be UNSET in production** | `DEMO_MODE=1` (or `true`) turns on demo mode: the worker refuses to start, and no real Instagram message can ever be sent (`worker/dm-worker.ts`, `lib/env.ts`, `docs/demo.md`). Demo mode is local testing only. If the worker logs say it will not start because of demo mode, this variable is set — remove it and redeploy. | Do not set it. If it is set anywhere in Railway, delete it. |
| `META_GRAPH_API_VERSION` | Optional (Meta only, **unset for now**) | Graph API version, e.g. `v25.0`. Defaults to `v25.0` when unset (`lib/env.ts`). Leave at the default unless the setup guide says otherwise. | Leave unset for now; set when Meta setup happens. |
| `INSTAGRAM_APP_ID` | Meta only, **unset for now** | Your Meta app's Instagram app ID (a number like `2036...`, from Instagram → API setup with Instagram login). Not the Facebook App ID on the Basic settings page. Missing = the connect flow reports `instagram=misconfigured`. | Meta developer console — later. Leave unset now. |
| `INSTAGRAM_APP_SECRET` | Meta only, **unset for now** | Instagram app secret (same Meta page, click Show). Used to verify webhook signatures. | Meta developer console — later. Leave unset now. |
| `FACEBOOK_APP_SECRET` | Meta only, **unset for now** | Facebook app secret (App settings → Basic → App secret). OpenReply verifies webhook signatures against **both** app secrets, so set both when the time comes. | Meta developer console — later. Leave unset now. |
| `COMMENT_POLL_INTERVAL_MS` | Optional | How often the worker sweeps for comments the webhook missed. Default `300000` (5 minutes, `worker/dm-worker.ts`). Defaults are fine to start. | Leave unset unless you have a reason to change it. |
| `COMMENT_POLL_MAX_PER_SWEEP` | Optional | Max new comments each campaign acts on per sweep. Default `30` (`lib/polling/comment-reconciler.ts`). Keep it conservative — higher gets closer to Instagram's rate limits. | Leave unset to start. |
| `COMMENT_POLL_LOOKBACK_HOURS` | Optional | How far back a sweep considers comments. Default `72` (`lib/polling/comment-reconciler.ts`). | Leave unset to start. |
| `HEALTH_STUCK_QUEUE_WAITING` | Optional | Queue-health threshold for `/api/health`: how many waiting jobs with none active counts as "stuck". Default `25` (`app/api/health/route.ts`). | Leave unset to start. |
| `DB_POOL_MAX` | Optional | Max Postgres connections per process. Default `3` (`lib/db/client.ts`). The default is deliberately small — on shared/serverless setups a bigger pool exhausts the database's connection limit and surfaces as "Can't reach database server". | Leave unset to start. Raise only if the database has headroom and you know why. |
| `FOLLOW_RECHECK_DELAYS_MS` | Optional | Comma-separated delays (ms) for re-checking a follow after someone taps "I'm following" in the follow gate. Default `20000,40000` (`lib/queue/dm-worker.ts` — an early check, then a later one, because Instagram can take over a minute to report a follow). | Leave unset to start. |
| `FOLLOW_RECHECK_ACK_MESSAGE` | Optional | If set, the exact message sent to someone while their follow is being re-checked (so the chat does not sit silent). If unset, no acknowledgement is sent and the re-check still happens. | Leave unset unless you want that message; type the exact wording yourself. |

---

## 5. Database migrations

There are **26 Prisma migrations** in `prisma/migrations/` (plus the
`migration_lock.toml` file — counted in the checkout). Migrations move
the production database schema forward to match the code. Get this wrong
and the new code boots against the old schema.

### The rules

1. **Always use `prisma migrate deploy`.** That is what `npm run
   db:migrate` runs (`package.json`: `db:migrate="prisma migrate deploy"`).
   It applies only pending migrations, in order, and records them so they
   are never applied twice.
2. **Never run `prisma db push` on production.** `db push` forces the
   schema without recording migrations and can destroy data. It is a dev
   shortcut, not a production tool.
3. **Never run `prisma migrate reset` on production.** It wipes the
   database.
4. **Never seed production with demo data.** `npm run db:seed-demo`
   creates the demo user, workspace, and fake campaigns — local demo only
   (`docs/demo.md`). Never run it against the production database.
5. **Migrate before the new code serves traffic.** Order for every
   upgrade: deploy → migrate → verify (§3). Migrating after the restart
   means the new code boots against the old schema.

### How to run a migration on Railway

> **(Verify)** — the exact Railway way to run a one-off command (a
> "run a command" / deploy-hook / CLI option) has not been confirmed
> against a live Railway account. The two routes below are the ones the
> repo's own docs support; confirm which one Railway offers before you
> need it, and do not guess at a third.

- **Option A — from your own machine, using the public Postgres URL.**
  This is the route `docs/setup.md` documents for the Vercel + Railway
  setup, and it works the same here:

  ```bash
  DATABASE_URL="postgresql://...proxy.rlwy.net.../railway" npm run db:migrate
  ```

  Use the **public** Postgres URL (`DATABASE_PUBLIC_URL` in Railway —
  the `*.proxy.rlwy.net` one), never the internal `*.railway.internal`
  one, because your machine is outside Railway's private network. Copy
  it from the Postgres service's Variables/Connect tab in Railway.

- **Option B — as a step in the deploy, if Railway supports it (verify).**
  Some platforms let you run a command after deploy or before start
  (Dokploy does this with `NIXPACKS_START_CMD=npx prisma migrate deploy
  && npm start`; Vercel does it with the `vercel-build` script). Do **not**
  put `prisma migrate deploy` in the Docker **build** step — the build
  cannot reach the database. If Railway offers a deploy hook or a
  one-off-command run, that is where a migration belongs. Confirm the
  mechanism in the dashboard; do not invent one.

After migrating, check `/api/health` and the worker logs. A failed
migration shows up in the migration command's output, not in the web
logs — read that output before restarting anything.

---

## 6. Backup and restore

Back up **two things**. The first is the one that hurts to lose.

### 6.1 Postgres — the data that matters

Everything OpenReply knows lives in Postgres: campaigns, accounts,
tokens, logs, workspaces. Back it up daily.

> **(Verify)** — Railway's managed Postgres backup feature (whether it
> takes automatic backups, how often, and how to restore from one in the
> dashboard) has **not** been confirmed against a live Railway account.
> Check the Postgres service in the Railway dashboard for its backup
> settings and retention, and use them if they exist. Do not assume a
> backup exists until you have seen it. The `pg_dump` procedure below is
> the verified, platform-independent backup from
> `docs/deploy-docker.md`, adapted for Railway's public URL — it works
> regardless of what Railway's dashboard offers.

**Back up with `pg_dump`** (from a computer with Postgres client tools,
using the public Postgres URL):

```bash
pg_dump "postgresql://...proxy.rlwy.net.../railway" > "openreply-$(date +%F).sql"
```

Store the dump **off Railway and off the machine that made it** (another
machine, object storage, a backup service). A backup that lives in the
same place as the database is not a backup.

**Restore** into a fresh/empty database:

```bash
psql "postgresql://...proxy.rlwy.net.../railway" < openreply-2026-11-05.sql
```

If the database already has data, drop and recreate it first — and only
do that when you mean to replace everything. (In Docker terms this is
`docker compose ... down -v`, which deletes **all** data; the Railway
equivalent is deleting/recreating the Postgres service data, which is
equally destructive — do not do it casually.)

**Test your backups.** Once in a while, restore a dump into a throwaway
database, spot-check a table, then drop it. An untested backup is a
rumour.

### 6.2 `.env` values — the secrets

Without these you cannot decrypt anything, even with a perfect database
backup. In particular:

- **`ENCRYPTION_KEY` is irreplaceable.** There is no way to recover it
  from the database. If it is lost, every connected Instagram account has
  to reconnect and every stored token is unreadable. Keep a copy in a
  password manager.
- `NEXTAUTH_SECRET`, `CRON_SECRET`, and the Meta app secrets can be
  rotated if lost, but rotating `NEXTAUTH_SECRET` signs everyone out.

Railway stores the variables, but keep your own copy of the generated
secrets in a password manager too — Railway is not your backup for them.

### 6.3 Redis — the queue (nice to have, not critical)

Redis holds the BullMQ send queue and the rate limiter. If Redis data is
lost, queued-but-unsent DMs are lost with it — comments already received
stay in Postgres, and the worker's polling reconciler re-sweeps for missed
comments, so the damage is bounded. Backing up Redis is worth doing if
you want zero lost sends, but it is not in the same league as the Postgres
backup. **(Verify)** whether Railway's managed Redis offers backups or
persistence settings in its dashboard.

### Backup schedule

| What | How | How often |
| --- | --- | --- |
| Postgres dump | `pg_dump` (above), stored off-platform; plus Railway's own backups if offered **(verify)** | Daily |
| Secrets (`ENCRYPTION_KEY` above all) | Password manager | On every change |
| Redis | Railway Redis persistence/backups if offered **(verify)**; otherwise skip — see above | Weekly, or skip |

---

## 7. Log inspection

You can do all of this from the iPhone browser — no laptop needed for
routine checks.

### From the Railway dashboard (first stop)

> **(Verify)** — the exact Railway dashboard layout (where Deployments,
> Logs, and Metrics live per service) has not been confirmed against a
> live account. The pattern below is the standard one: open the project,
> open the service, open its logs. If the labels differ, follow the
> intent.

1. Open Railway in the browser, open the project, open the service
   (`openreply-web`, `openreply-worker`, or the cron service).
2. Open its **Logs** / **Deployments** view. You can follow logs live or
   look at a snapshot.
3. Check one service at a time — web logs, worker logs, and cron logs
   tell you different things.

### From the command line (optional, not iPhone-friendly)

A Railway CLI exists for terminal use **(verify — not confirmed in the
repo docs; confirm the install and login steps in Railway's own docs
before relying on it)**. The dashboard is the supported path for this
guide; the CLI is a convenience for a laptop, not a requirement.

### What to look for

| Where | Healthy looks like | Worried looks like |
| --- | --- | --- |
| `/api/health` (browser) | `{"status":"ok", ...}`, every check `ok`, `worker.healthy: true` | `503` / `status: "degraded"` — read the per-check `detail`, it names the problem |
| Web logs | Normal requests, no startup throw | App throws on boot naming a variable (`ENCRYPTION_KEY must be a 32-byte hex string`, `NEXTAUTH_URL ...`, `DATABASE_URL environment variable is required`) — fix that variable (§4) |
| Worker logs | `[DM Worker] Started`, then quiet except for sends and the every-5-minute poll sweep | `DEMO_MODE=1 — worker will not start` (remove `DEMO_MODE`, §4); repeated `Heartbeat failed` (cannot reach Redis/Postgres); `Comment reconciliation failed` repeating |
| Cron logs | `attach-next-reel ok ...` every 5 minutes; `refresh-tokens ok` / `snapshot-followers ok` once a day around 05:00 UTC | `FAILED` lines, or nothing at all for a day — the scheduler is not running (§2, §8) |
| Dashboard → DM Logs | `SENT` rows for real comments | Failed rows — read Meta's error text; skip rows explain why a comment did not match (keyword, paused campaign, your own comment) |

### The two fastest checks, every time

1. **`GET /api/health`** — database, Redis, queue, worker heartbeat in
   one page. If `worker.healthy` is `false`, the worker is the problem.
2. **DM Logs in the dashboard** — tells you whether sends are happening
   and why any single one failed.

---

## 8. Troubleshooting

### Worker problems

**`/api/health` says `status: degraded` with `worker.healthy: false`.**
The worker is not running or cannot reach Redis. Check in order:

1. In Railway, is the `openreply-worker` service running (not crashed,
   not stopped, not failing to start)? Read its logs.
2. Do web and worker share the **same** `DATABASE_URL`, `REDIS_URL`,
   and `ENCRYPTION_KEY`? A mismatch on `ENCRYPTION_KEY` makes every send
   fail to decrypt; a wrong `REDIS_URL` means the worker cannot reach the
   queue at all. (Inside Railway the URLs must be the internal
   `*.railway.internal` ones, not `localhost` and not the public proxy.)
3. Is `DEMO_MODE` set? The worker refuses to start in demo mode — remove
   the variable and redeploy (§4).
4. Restart the worker service in Railway and watch `/api/health` again.
   The heartbeat runs every 30 seconds (`worker/dm-worker.ts`), so give
   it a minute.

**Queue stuck — lots of jobs waiting, none active.**
`/api/health` reports this as a queue error when 25 or more jobs are
waiting with none active (the `HEALTH_STUCK_QUEUE_WAITING` default, §4).
It means the worker is not consuming: same root cause as above — the
worker is down or cannot reach Redis. A heartbeat alone does not prove
the worker is consuming: the heartbeat runs on its own timer, so a
worker whose queue connection dropped can still look alive while the
backlog grows (`app/api/health/route.ts` documents a real case of 385
jobs waiting for hours behind a healthy-looking heartbeat). Trust the
queue counts, not just the heartbeat.

**Webhooks arrive but no DM is ever sent.**
The worker is the first thing to check (`/api/health`,
`worker.healthy`). Also check DM Logs and the `WebhookEvent` table: if
events are being recorded but no `DmLog` rows appear, the queue is not
being consumed.

**Redis disconnects.**
Look for repeated Redis connection errors in the worker logs. Common
causes: the Redis service restarted, `REDIS_URL` is wrong or points at
`localhost` (which means nothing inside Railway), or the Redis service
itself is down in Railway. Restart the worker after Redis is back — the
worker reconnects, and queued jobs that were persisted survive a Redis
restart only if Redis persistence is on **(verify in the Railway Redis
settings)**.

**Comments work, but the token refresh never happens.**
Check the cron service logs (§2, §7). If the cron service is not running,
start it and check its logs — it exits immediately if neither
`CRON_SECRET` nor `NEXTAUTH_SECRET` is set. If it is running but logging
`FAILED`, the web app is not answering `/api/cron/*` — check that
`CRON_SECRET` matches between the cron service and the web app.

### Email problems (magic link not arriving)

Work through this list in order:

1. **Is the address allowlisted?** If `ALLOWED_EMAILS` is set and your
   address is not in it, you will not get a link. Add it and redeploy.
2. **Is Resend set up?** `RESEND_API_KEY` must be a real key, and
   `EMAIL_FROM` must be on a domain you verified in Resend. The
   placeholder sender domain will not deliver. Check the web logs for the
   send error — it names the problem.
3. **Is the domain verified in Resend?** Log in to Resend and check the
   domain's verification status (DNS records). An unverified domain is
   the most common cause after a wrong key. Resend's dashboard shows
   whether it is verified and which DNS records are missing.
4. **Check spam / promotions.** Magic links look like bulk mail to some
   filters. Search for the sender address before assuming it never sent.
5. **If you use `EMAIL_SERVER` instead of Resend:** it takes over
   completely, so `RESEND_API_KEY` is irrelevant — check the SMTP
   credentials, host, and port instead (465 with `smtps://`, 587 with
   `smtp://`), and that special characters in the user/password are
   URL-encoded (`@` → `%40`).
6. **Still nothing?** Send a test magic link and watch the web logs at
   the same moment — the error appears there, not in your inbox.

---

## 9. Redeploy and rollback

### Redeploy

- **New code:** push/merge to `main` on GitHub and let Railway deploy it
  (§3). Then run migrations if the change ships any (§5), then check
  `/api/health` and the worker logs.
- **Same code, fresh start:** use Railway's **Redeploy** on the service
  **(verify the exact button/label in the dashboard)**. This restarts the
  service from the currently deployed commit — the right move after a
  variable change or a stuck worker, and the first thing to try before
  assuming the code is broken. Remember: changing an environment variable
  usually needs a redeploy/restart before the service picks it up.
- **Order matters on upgrade:** deploy → migrate → verify. Never migrate
  after the new code is already serving traffic against the old schema.

### Rollback

Two ways, for two different problems:

1. **Roll back to a previous deployment in Railway (fastest).** In the
   service's Deployments view, redeploy the previous good deployment
   **(verify the exact Railway rollback/redeploy-previous option in the
   dashboard — this guide does not claim a specific button name)**. Use
   this when the new deploy is broken and the old one was fine. Note:
   rolling back the code does **not** roll back a migration that already
   ran — if the bad deploy already migrated the database forward, the old
   code may not work against the new schema. That is why you check
   `/api/health` after every deploy, and why a backup (§6) matters.
2. **Git revert + redeploy (cleanest).** Revert the bad commit on `main`
   (or merge a revert PR), let Railway deploy the revert, migrate if the
   revert ships a migration, and verify. Use this when the problem is the
   change itself and you want the history to show it.

After any rollback: check `/api/health`, check the worker logs show
`[DM Worker] Started`, and confirm a test sign-in works before calling it
done.

---

## 10. Meta setup pointers (for later — not now)

> **Do not do this section yet.** Meta integration comes later, after the
> Railway deploy is stable. This section exists so the URLs are ready to
> fill in when that work starts — nothing here claims live Instagram
> messaging works today.

Full guide: [docs/meta-app.md](meta-app.md). Short version in
[docs/setup.md](setup.md#the-meta-app).

When the time comes, you will need these four URLs, all built from your
Railway public domain. Fill in `<your-railway-domain>` after the deploy
— do not guess it:

| What | URL pattern |
| --- | --- |
| Production URL (also `NEXTAUTH_URL`) | `https://<your-railway-domain>` |
| OAuth redirect URL (register in Meta) | `https://<your-railway-domain>/api/instagram/callback` |
| Webhook callback URL (register in Meta) | `https://<your-railway-domain>/api/webhook` |
| Verify token (paste the same value into Meta) | The `WEBHOOK_VERIFY_TOKEN` you generated in §4.1 |
| Privacy / terms / data-deletion pages (Meta asks for these before you can publish the app) | `https://<your-railway-domain>/privacy`, `.../data-deletion`, `.../terms` (OpenReply ships these pages) |

Required permissions (request **only** these three for comment-to-DM;
`docs/meta-app.md` §8 has the detail, including the fourth insights scope):

| Permission | What OpenReply uses it for |
| --- | --- |
| `instagram_business_basic` | Identify the connected professional account after Instagram Login |
| `instagram_business_manage_comments` | Receive comments via the `comments` webhook; post a public reply if enabled |
| `instagram_business_manage_messages` | Send the private reply after a keyword comment; handle inbound DMs, Story replies, and DM button taps |

Also subscribe the webhook to **both** `comments` **and** `messages`
fields — `comments` alone means the "also reply when someone DMs these
words" toggle never fires. And remember: publishing the app makes it Live,
but Standard Access still only covers accounts with a role on the app
(admins, developers, Instagram testers) — each account needs the tester
invite and must accept it inside Instagram. Strangers need App Review for
Advanced Access. All of that is in [docs/meta-app.md](meta-app.md) — do
not start it from this summary alone.

---

## 11. Estimated recurring costs

> **These are estimates to confirm in the Railway and Resend dashboards,
> not quotes.** Prices change, and usage depends on how many comments and
> DMs you process. Check the dashboards before budgeting on any number
> here.

| Cost | Estimate (unverified — confirm in dashboard) |
| --- | --- |
| Railway Hobby plan | **$5/month + usage** (per the plan brief for this deploy). The $5 is the plan fee; the web service, worker service, Postgres, and Redis each also use metered resources (compute, memory, storage, egress), which are billed on top. Check the Railway project's usage/billing page for the real monthly total after the first month. |
| Resend | Free tier exists **(verify its current limits — sending limit and what counts — in the Resend dashboard; this guide does not state numbers it could not verify from the repo docs)**. Magic-link sign-in sends very little email, so the free tier is expected to cover it — confirm that against your actual send volume in Resend. |
| Meta / Instagram API | No charge from Meta for the API itself (per the repo docs); the cost is your hosting and email. Instagram's policies, permissions, messaging windows, and rate limits still apply. |
| Domain (optional) | None if you use the Railway-provided domain. A custom domain is optional and would cost whatever the registrar charges. |

What drives the bill up: an always-on worker (it runs 24/7 by design —
it cannot be serverless), Postgres storage growing with logs, and Redis
memory holding the queue. What keeps it down: the worker is one small
service, and OpenReply's per-account rate limiting (750 private replies
per hour, per Meta's cap) bounds the send volume.

---

## 12. Security maintenance

### Secret rotation

- **Rotate anything that has been exposed.** If a secret is pasted into
  chat, an issue, a log, or a screenshot — including a chat with an AI
  assistant — rotate it in Railway (and in Meta/Resend, if it is theirs)
  and redeploy. Do not just delete the message; assume it was logged.
- **`ENCRYPTION_KEY` is the exception: do not rotate it casually.**
  Changing it makes every stored Instagram token unreadable and forces
  every account to reconnect. Only change it if it was exposed, and plan
  the reconnects first.
- **Rotating `NEXTAUTH_SECRET` signs everyone out.** That is expected —
  warn yourself before doing it, then sign back in.
- **Rotating `CRON_SECRET`** means updating it on the web app, the
  worker, and the cron service at the same time, then redeploying all
  three.
- **Rotating `RESEND_API_KEY`:** create the new key in Resend, update
  Railway, redeploy, then delete the old key in Resend.
- After any rotation, check `/api/health` and sign in once to confirm the
  new value works.

### Dependency updates

- Update dependencies (Next.js, Prisma, BullMQ, Auth.js) deliberately,
  not automatically: run `npm run typecheck`, `npm run lint`, and `npm
  test` locally or in CI, then deploy and verify (§3). A dependency bump
  that breaks the worker build means no DMs until it is fixed — check the
  worker logs after every deploy.
- Keep Node at a version Prisma 7 and Next.js 16 support (the Dockerfile
  pins Node 20.19.0-slim; `docs/deploy-dokploy.md` notes both need Node
  20.19+, 22.12+, or 24+). Do not let the runtime drift below that.

### Allowlist discipline

- Keep `ALLOWED_EMAILS` set to just your own address(es). Every time you
  add someone, ask whether they need their own workspace — an allowlisted
  address can sign in and gets a workspace. Remove addresses that should
  no longer have access, then redeploy.
- Never leave `ALLOWED_EMAILS` unset on a public instance "temporarily" —
  that is the window someone else signs up in.

### Never commit `.env` files

- `.env`, `.env.production`, and any file holding real secrets are
  gitignored. Keep them that way. Before every commit, check `git status`
  for stray files — the checkout already carries one local-only file,
  `docker-compose.override.yml` (a local VM workaround), which must not
  be committed and must not be deleted.
- Secrets live in Railway Variables and in your password manager. Nowhere
  else. No secret values in code, in docs, in screenshots, or in chat.

### The short version, taped to the wall

1. `/api/health` must say `ok` and `worker.healthy: true`.
2. If no DM arrives, check the worker first.
3. If tokens stop refreshing, check the cron service first.
4. If nobody can sign in, check Resend and `ALLOWED_EMAILS` first.
5. Back up Postgres daily; keep `ENCRYPTION_KEY` in a password manager.
6. Never paste a secret anywhere except Railway Variables.
