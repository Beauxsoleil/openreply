# OpenReply — Production Operations Guide (Split Stack)

This guide runs the live OpenReply instance on the **split stack**: five
managed services, each doing one job — four free, plus a ~$7/month Render
worker (Render has no free tier for background workers, so the stack is
not $0). It is written for someone who manages things from a phone or
browser, not a DevOps engineer. Plain language first; every technical term
is explained where it appears.

> **What this stack is not.** This is the managed-services deployment
> (Vercel + Neon + Upstash + Render + Resend). If you would rather run
> everything on one server you control, use the self-hosted Docker Compose
> stack instead: [docs/deploy-docker.md](deploy-docker.md). That stack is
> still supported and is not going away. The old Railway-based plan is
> abandoned and is not documented anywhere in this repo — do not follow any
> Railway instructions you find in old branches, pull requests, or chat
> history.
>
> **Meta / Instagram comes later.** This guide gets the app, database,
> queue, worker, and login email running. It does **not** connect Instagram.
> The Meta variables stay **unset** until the Meta setup is done, and nothing
> in this guide claims live Instagram messaging works yet. See
> [Meta setup pointers](#meta-setup-pointers) at the end.

Related guides:

- [docs/deploy-split-stack.md](deploy-split-stack.md) — step-by-step
  provisioning: create each service and deploy for the first time. Read that
  first if nothing is deployed yet; this guide is for running it afterwards.
- [docs/setup.md](setup.md) — the full setup walkthrough (hosting sections
  there still describe the abandoned Railway path; use this guide and
  `deploy-split-stack.md` for hosting instead).
- [docs/meta-app.md](meta-app.md) — connecting Instagram with your own Meta
  app (later step).
- [docs/demo.md](demo.md) — demo mode (local only, never production).
- [docs/deploy-docker.md](deploy-docker.md) — the self-hosted Docker
  alternative.

---

## 1. Infrastructure overview

Five services, each with one job. Nothing here runs on your own computer;
all five are hosted services with free tiers.

| Service | Free tier | What it does here |
| --- | --- | --- |
| **Vercel** (Hobby) | Free | Runs the Next.js web app: the dashboard, sign-in, the OAuth callback, and the webhook receiver. Gives you a free public URL like `your-app.vercel.app`. |
| **Neon** | Free: 0.5 GB storage, 100 compute-hours/month | Runs PostgreSQL, the database. Stores campaigns, accounts, tokens, logs, workspaces, and sessions. |
| **Upstash** | Free: 256 MB, 500,000 commands/month, 1 database | Runs Redis, the queue store. Holds the BullMQ send queue and the per-account rate limiter. |
| **Render** | Free | Runs the background worker: the long-running process that actually sends the DMs. |
| **Resend** | Free: 3,000 emails/month, 100/day, 1 verified domain | Sends the login emails (magic links). Sign-in is email-only, so without working email nobody can log in. |

### How a comment becomes a DM

1. Someone comments on your Instagram post (once Meta is connected).
2. Meta sends the comment to your Vercel app at `/api/webhook`. The web app
   checks it against your active campaigns.
3. On a keyword match, the web app puts a job on the queue in Upstash Redis.
4. The worker on Render picks the job up and sends the private reply through
   the Meta API, plus the public reply if you enabled one.
5. Every send, skip, and failure is written to the Neon database and shown
   on the DM Logs page.

The web app and the worker **must share the same `DATABASE_URL`, the same
`REDIS_URL`, and the same `ENCRYPTION_KEY`**. The web app writes an
encrypted Instagram token; the worker decrypts it to send. Different keys
mean every send fails to decrypt. There is one set of secrets, pasted into
two places (Vercel and Render) — see the
[environment variable reference](#4-environment-variable-reference).

### What runs where, in one picture

```
Instagram / Meta ──webhook──▶ Vercel (web app + dashboard)
                                  │  writes job to queue
                                  ▼
                             Upstash (Redis queue)
                                  │  worker picks job up
                                  ▼
Render (worker) ──sends DM──▶ Instagram / Meta
        │   ▲
        │   └── both read/write Neon (Postgres) for campaigns, logs, tokens
        │
        └── Vercel also reads/writes Neon; Resend sends login emails
```

---

## 2. Free-tier limits and honest tradeoffs

Almost everything here is free, with one exception: **the worker costs
about $7/month from day one, because Render has no free tier for
background workers** (see below). Free tiers have sharp edges. Know them
now so they read as expected behaviour later, not as a mysterious outage.

| Limit | What you will notice | Fix (later, costs money) |
| --- | --- | --- |
| **Render has no free background-worker tier.** | The worker runs on a paid Starter instance, about **$7/month** (estimate — confirm in the Render dashboard), always on. There is no free worker to sleep, so there is no wake-up delay — but the stack is not $0. A card is required on Render for the paid instance. | None needed — the worker is already always-on. The "free worker that sleeps after 15 minutes" idea is wrong: that behaviour applies to Render's *free web services*, and a background worker cannot be a free web service. Do not try to run the worker as a free web service with a dummy endpoint and an uptime pinger — it fights the platform and breaks. |
| **Neon scales to zero after 5 minutes idle, ~500 ms cold start.** | The first database query after a quiet period takes about half a second longer. A page load or webhook may feel briefly slow, then it is normal again. | Neon's paid tiers keep compute warm (estimate — confirm in the Neon dashboard). Also watch the compute-hours meter: the worker polls every 5 minutes, which keeps Neon's compute awake, and at the 0.25 CU minimum that can burn through the 100 compute-hours/month allowance. |
| **Vercel Hobby: function timeouts, cron limits, and use terms.** | Serverless functions (the web app's API routes) can only run for a limited time per request (10 s default, 60 s max — the cron routes and webhook are set to 60 s), and each cron can run at most once per day (see [Scheduled jobs](#6-scheduled-jobs)). Long work belongs in the Render worker, not in a web request. Hobby is also for personal/non-commercial use — OpenReply is a product, so running production on Hobby is a terms-of-service grey area, not just a limits question. | Vercel Pro raises the limits (estimate — confirm in the Vercel dashboard). If this becomes a real business service, move to Pro. |
| **Upstash Free: 256 MB, 500,000 commands/month, 1 database.** | BullMQ polls Redis even with no jobs, so the 500K command budget may not last the month — check the Upstash dashboard usage meter in week 1. If you outgrow it, jobs start failing when the allowance is used up. Before calling the queue healthy, run the live smoke test: enqueue a job and watch the worker pick it up and complete it. | Upstash Fixed plans (unmetered commands, ~$10/month estimate) raise the caps — confirm in the Upstash dashboard. |
| **Resend Free: 3,000 emails/month, 100/day, 1 verified domain.** | Enough for magic-link sign-in at this scale. Without a verified domain, Resend can only send to the account owner's own email address (from `onboarding@resend.dev`) — so **your own login works, but nobody else can receive a magic link** until a domain is verified. The domain decision is yours to make later; see [Email](#email-magic-links). | Verify a domain you own (free in Resend, but you need a domain), or a paid Resend plan (estimate — confirm in the Resend dashboard). |

All prices and limits above are **estimates to confirm in each provider's
dashboard** — free tiers change, and the dashboard is the source of truth.
No card is required for Neon Free or Resend Free (per their free-tier terms
as understood when this guide was written — confirm at signup). Render's
paid worker instance **does** require a card. (verify: whether Vercel Hobby
and Upstash Free ask for a card at signup.)

---

## 3. Deploy process, per provider

Deploy order matters the first time: database and queue first, then web,
then worker, then email. After the first deploy, each service redeploys
independently. Full step-by-step for the first time is in
[docs/deploy-split-stack.md](deploy-split-stack.md); this section is the
short version for repeat deploys.

### Vercel (web app)

- Connected to the GitHub repo. Pushing to the deployed branch (or merging a
  pull request into it) triggers a deploy automatically. (verify: confirm the
  exact branch Vercel is set to deploy in the Vercel project settings —
  usually `main`.)
- Build command: the repo's `vercel-build` script —
  `prisma generate && next build`. It generates the Prisma client and
  builds the app. **It does not run database migrations** — those are a
  separate one-off command (see [Migrations](#5-migrations)), run before
  the deploy with Neon's direct connection string. (verify: confirm in the
  Vercel dashboard that the build runs `vercel-build` rather than plain
  `next build`.)
- After deploy, Vercel gives the app its public URL
  (`https://your-app.vercel.app`). That URL is `NEXTAUTH_URL`, and it is
  what the Meta redirect and webhook URLs point at later.
- A failed Vercel deploy leaves the previous working version live. Check the
  build log in the Vercel dashboard (Deployment → build logs) for the error.

### Neon (Postgres)

- Nothing to deploy. Neon is a managed database: you create the project and
  database once, copy the connection string, and it stays up. Schema changes
  arrive through migrations (see below), not through Neon.
- Neon shows more than one connection string: a **pooled** one (host
  contains `-pooler`) and a **direct** one (same string minus `-pooler`),
  both with `?sslmode=require`. The app and the worker use the pooled
  string as `DATABASE_URL`. Migrations use the direct string as
  `DIRECT_URL` (see [Migrations](#5-migrations)) — never run migrations
  against the pooled endpoint.
- If Neon has scaled to zero, the first query after idle takes ~500 ms.
  That is normal, not an error.

### Upstash (Redis)

- Nothing to deploy. Create the database once, copy the `rediss://` URL
  (TLS — note the double `s`), and paste it as `REDIS_URL` in Vercel and
  Render. The app detects TLS automatically from the `rediss://` scheme;
  there is no separate TLS setting to turn on.
- Upstash Redis must support blocking commands — BullMQ needs them. Upstash
  does. An HTTP-only Redis would not work; do not substitute one.

### Render (worker)

- A **Background Worker** service (not a Web Service, not a Static Site)
  running `npm run worker` from the same GitHub repo. (verify: confirm the
  service type and the exact build/start command fields in the Render
  dashboard — the expected values are build `npm install` plus
  `npm run db:generate`, start `npm run worker`.)
- **Render has no free instance type for background workers.** The worker
  runs on a paid Starter instance, about **$7/month** (estimate — confirm
  in the Render dashboard), always on. That is the stack's only unavoidable
  cost, and it requires a card. Do not try to run the worker as a free web
  service with a dummy endpoint and an uptime pinger — it fights the
  platform and breaks.
- The worker only needs the generated Prisma client, not `next build`. Do
  not set its build command to `npm run build`: it runs `next build`
  needlessly.
- The worker is a long-running process, not a web server. It has no public
  URL and does not serve pages. Its health is reported by `/api/health`
  (see [Health checks](#7-health-checks)).
- Every push to the deployed branch redeploys the worker too (if Render is
  connected to the repo with auto-deploy on). A bad deploy shows up in the
  Render logs before anything else.

### Resend (email)

- Nothing to deploy. Create the account and API key once, verify a sender
  domain when you are ready, and paste the key as `RESEND_API_KEY`.
- Until a domain is verified, Resend only sends to the account owner's own
  email (from `onboarding@resend.dev`). Your own magic-link login works;
  anyone else's does not. That is a Resend restriction, not an app bug.
- Alternatively, point `EMAIL_SERVER` at your own SMTP server and skip
  Resend entirely — see the env-var table. If `EMAIL_SERVER` is set, it
  takes over and `RESEND_API_KEY` is not needed.

---

## 4. Environment variable reference

Set these in the **Vercel project settings → Environment Variables** and in
the **Render worker service → Environment** (same values in both, except
where noted). Never put them in a file you commit. The repo's
`.env.production.example` shows the same list with the Docker values; the
table below is the split-stack version.

**How to read this table:** "Required" means the app will not start, sign
anyone in, or send a DM without it. "Optional" means the app runs without
it, and the table says what you lose. "Where it comes from" tells you which
dashboard or command produces the value.

### Core (required on both Vercel and Render)

| Variable | Required? | What breaks without it | Where the value comes from |
| --- | --- | --- | --- |
| `NEXTAUTH_URL` | Required | Magic-link emails, OAuth redirects, and tracked links in DMs all point at the wrong place (or nowhere). Sign-in fails. | Your Vercel domain, e.g. `https://your-app.vercel.app`. No trailing slash. `http://` or `localhost` will not work in production. |
| `NEXTAUTH_SECRET` | Required | Sessions do not work; nobody can stay signed in. The app throws on boot (validated in `lib/env.ts`: at least 16 characters). | Generate: `openssl rand -base64 32`. |
| `DATABASE_URL` | Required | Nothing works — the app cannot reach Postgres. | Neon dashboard → your database → **pooled** connection string (host contains `-pooler`), with `?sslmode=require`. Same value on Vercel and Render. |
| `DIRECT_URL` | Required for migrations only | Migrations fail or behave oddly (Neon's pooled endpoint is PgBouncer in transaction mode, which does not guarantee the same backend connection for a migration's session-scoped work). The running app never reads this variable. | Neon dashboard → your database → **direct** connection string (same string minus `-pooler`), with `?sslmode=require`. Set it wherever you run `npm run db:migrate` from — your own machine, not Vercel/Render. |
| `REDIS_URL` | Required | The queue does not work — webhooks arrive, jobs are never queued, no DM ever sends. | Upstash dashboard → your Redis database → `rediss://` URL (TLS). Same value on Vercel and Render. |
| `ENCRYPTION_KEY` | Required | The app throws on boot. If it differs between Vercel and Render, every DM send fails to decrypt the stored Instagram token. | Generate: `openssl rand -hex 32`. Must be **exactly 64 hex characters**. Same value on Vercel and Render. Losing it means every connected Instagram account must reconnect (see [Backup](#8-backup-and-restore)). |
| `RESEND_API_KEY` | Required in practice | Nobody can sign in — login is magic links only. Not needed if `EMAIL_SERVER` is set instead. | Resend dashboard → API Keys. Starts with `re_`. |
| `EMAIL_FROM` | Required in practice | Magic links are sent from the placeholder address and do not deliver. | A sender on a domain you verified in Resend, e.g. `OpenReply <login@example.com>`. Until a domain is verified, use Resend's onboarding sender for your own address only (see [Email](#email-magic-links)). |
| `ALLOWED_EMAILS` | Optional but strongly recommended | If unset, **anyone** who reaches your public URL can request a magic link and gets their own workspace. | Your own email address(es), comma-separated, e.g. `you@example.com`. Case insensitive. |

### Security / scheduled jobs

| Variable | Required? | What breaks without it | Where the value comes from |
| --- | --- | --- | --- |
| `CRON_SECRET` | Required in practice | The `/api/cron/*` routes refuse every call, so Instagram tokens never refresh and follower snapshots never run. Tokens expire and automation silently stops. If unset, the routes fall back to `NEXTAUTH_SECRET` — set it anyway so the two secrets stay separate. | Generate: `openssl rand -base64 32`. Vercel only (the worker does not call the cron routes). Vercel's own cron calls send it as a `Bearer` token automatically when configured — (verify: confirm how the cron secret is passed to Vercel Crons in the Vercel dashboard; the routes check `Authorization: Bearer <CRON_SECRET>`). |
| `WEBHOOK_VERIFY_TOKEN` | Unset until Meta setup | Without it (and the Meta app), Meta cannot verify your webhook and no comment events arrive. Has no effect before Meta is configured. | Any random string you invent, e.g. `openssl rand -hex 16`. Paste the **same** value into Meta's webhook configuration later. Set on Vercel only (the worker does not verify webhooks). |

### Demo mode — must be UNSET in production

| Variable | Required? | What breaks if it is set | Where the value comes from |
| --- | --- | --- | --- |
| `DEMO_MODE` | **Must be unset** (or `0`) in production | The real worker **refuses to start at all** while `DEMO_MODE=1`, and the DM send path refuses demo accounts. Demo mode is a local-only simulation that never sends a real message (see [docs/demo.md](demo.md)). If the worker will not start and the logs say `DEMO_MODE=1`, this is why. | Nowhere — do not set it on Vercel or Render. |

### Meta / Instagram — UNSET until Meta setup

Leave **all five** unset for now. Meta integration comes later; setting
them early with wrong or placeholder values produces confusing errors, and
nothing in this stack can send a live Instagram message until the Meta app,
webhook, and account connection are all done (see
[docs/meta-app.md](meta-app.md)).

| Variable | Required? | What it is | Where the value comes from |
| --- | --- | --- | --- |
| `META_GRAPH_API_VERSION` | Optional (defaults to `v25.0` in code) | Which version of Meta's Graph API to call. | Leave at the default unless a guide says otherwise. |
| `INSTAGRAM_APP_ID` | Unset until Meta setup | Your Meta app's Instagram app ID (a number). Not the same as the Facebook App ID. | Meta developers console → Instagram product → API setup with Instagram login. |
| `INSTAGRAM_APP_SECRET` | Unset until Meta setup | Secret for the Instagram product. | Same Meta page, click Show. |
| `FACEBOOK_APP_SECRET` | Unset until Meta setup | Secret for the Facebook app. | Meta console → App settings → Basic → App secret. |
| `WEBHOOK_VERIFY_TOKEN` | Unset until Meta setup | Shared secret Meta uses to prove the webhook URL is yours. | You invent it (see above); also pasted into Meta. |

Zernio users: Zernio credentials are saved in Settings, not in environment
variables. There are no `ZERNIO_*` variables to set.

### Optional tuning

Defaults are fine to start. Change these only if you have a reason and you
know what the new value does.

| Variable | Default | What it does | Where it matters |
| --- | --- | --- | --- |
| `EMAIL_SERVER` | Unset | Your own SMTP server URL, e.g. `smtps://login%40example.com:password@mail.example.com:465`. When set, it takes over from Resend and `RESEND_API_KEY` is not needed. URL-encode special characters (`@` → `%40`). Port 465 with `smtps://` is implicit TLS; port 587 with `smtp://` is STARTTLS. | Vercel only (the worker does not send email). |
| `COMMENT_POLL_INTERVAL_MS` | `300000` (5 min) | How often the worker sweeps for comments the webhook missed. The polling reconciler is a safety net, not the main path — do not rely on it to paper over a broken webhook. | Render worker only. |
| `COMMENT_POLL_MAX_PER_SWEEP` | `30` | Max new comments each campaign acts on per sweep. Keep it conservative; higher gets closer to Instagram's rate limits. | Render worker only. |
| `COMMENT_POLL_LOOKBACK_HOURS` | `72` | How far back a sweep considers comments. | Render worker only. |
| `HEALTH_STUCK_QUEUE_WAITING` | `25` | How many waiting jobs with none active counts as a stuck worker in `/api/health`. Below this, a short backlog is treated as normal. | Vercel (the health route reads it). |
| `DB_POOL_MAX` | `3` | Max database connections in the pool. Small on purpose: Vercel serverless functions plus the worker share Neon's connection allowance, and a big pool exhausts it fast. Raise only if you see connection-exhaustion errors, and check Neon's connection limit first. | Both Vercel and Render. |
| `FOLLOW_RECHECK_DELAYS_MS` | `20000,40000` | Follow-gate re-check delays: after someone taps the DM button, OpenReply re-checks whether they followed, at 20 s and then 40 s, because Instagram does not report a brand-new follow immediately. Comma-separated milliseconds. | Render worker only. |
| `FOLLOW_RECHECK_ACK_MESSAGE` | Unset | Optional message sent while a follow re-check is pending (e.g. telling the person the follow is being checked). Unset means nothing extra is sent. | Render worker only. |

### Secrets-generation checklist

Run these on your own computer (Terminal on a Mac, or any shell). Do them
once, save the outputs in a password manager, then paste each value into
**both** Vercel and Render where the table says so.

```bash
# Session secret (NEXTAUTH_SECRET) — any random string, base64
openssl rand -base64 32

# Cron secret (CRON_SECRET) — a different random string, base64
openssl rand -base64 32

# Encryption key (ENCRYPTION_KEY) — MUST be exactly 64 hex characters
openssl rand -hex 32

# Webhook verify token (WEBHOOK_VERIFY_TOKEN, for Meta later) — any random string
openssl rand -hex 16
```

Rules that are not optional:

- **Never paste a secret into a chat, an issue, a support ticket, or a
  shared document.** If a secret has been pasted anywhere it could be
  logged — including a chat with an AI assistant — rotate it (generate a
  new one, update Vercel and Render, redeploy) and treat the old one as
  burned.
- **Never reuse the dev values.** `.env.example` and
  `.env.production.example` contain placeholders that are deliberately
  invalid. Production secrets must be freshly generated per instance.
- **Never commit a `.env` file.** `.env`, `.env.production`, and friends
  are gitignored. If one ever gets committed by accident, rotate every
  secret in it immediately — removing the file from git later does not
  un-expose it.
- **Generate each secret once and use the same value everywhere it is
  needed.** `ENCRYPTION_KEY` in particular must be identical on Vercel and
  Render. Generate it once, paste it twice — do not run the command twice
  and paste a different value in each place.
- **Back up `ENCRYPTION_KEY` in a password manager.** It cannot be
  recovered from the database (see [Backup](#8-backup-and-restore)).

---

## 5. Migrations

OpenReply uses Prisma migrations — numbered, version-controlled schema
changes (26 migrations at the time of writing, in `prisma/migrations/`).
They are the only supported way to change the production database schema.

- **How they run in this stack:** migrations are a one-off command run
  from your own machine (or any shell with the repo and Node), **before**
  deploying the new code. The Vercel build (`vercel-build`) deliberately
  does **not** run them — a build should not be coupled to live DDL, and a
  sleeping Neon database would fail the whole build.
- **One-off command:** with Neon's **direct** connection string set as
  `DIRECT_URL` (same string as `DATABASE_URL` minus `-pooler`), run
  `npm run db:migrate` (which runs `prisma migrate deploy`). The repo's
  `prisma.config.ts` prefers `DIRECT_URL` and falls back to `DATABASE_URL`
  when it is unset. **Do not run migrations against the pooled endpoint:**
  Neon's pooler is PgBouncer in transaction mode, which does not guarantee
  the same backend connection across a migration's session-scoped work, so
  migrations over the pooled URL can fail in ways that never name pooling
  (e.g. `prepared statement "s0" already exists`).
- **Never run on production:** `prisma db push` (pushes the schema without
  a migration record), `prisma migrate reset` (wipes the database), or
  `npm run db:seed-demo` (creates demo fixtures — demo data in production
  is inert but confusing, and the seed is for local demo mode only).
- **Order on upgrade:** migrate first (one-off command above), then deploy
  the code, then check `/api/health`. If a migration fails, the schema is
  unchanged from the failed step's start — read the error, fix the cause,
  and re-run. Never hand-edit the production schema to "fix" a failed
  migration; that leaves the migration history and the real schema
  disagreeing, and the next deploy fails worse.

---

## 6. Scheduled jobs

Three daily jobs run as **Vercel Crons** (defined in `vercel.json`). Vercel
Hobby allows each cron to run at most once per day, which is why they are
daily. All times are UTC.

| Job | Schedule (UTC) | What it does |
| --- | --- | --- |
| `refresh-tokens` | 05:00 daily (`/api/cron/refresh-tokens`) | Refreshes Instagram access tokens before they expire. If it stops running, tokens expire and every automation stops — silently, days later. |
| `attach-next-reel` | 06:00 daily (`/api/cron/attach-next-reel`) | Binds campaigns to newly published reels. Note: on the Docker stack this runs every 5 minutes; on Vercel Hobby it runs **once a day**, so a new reel may wait up to a day to be picked up. That is a free-tier tradeoff, not a bug. |
| `snapshot-followers` | 07:00 daily (`/api/cron/snapshot-followers`) | Records follower counts for the dashboard. |

All three routes require `Authorization: Bearer <CRON_SECRET>` (falling
back to `NEXTAUTH_SECRET` if `CRON_SECRET` is unset — set `CRON_SECRET`
anyway). Vercel's cron system calls them; you do not call them yourself.
(verify: confirm in the Vercel dashboard that Vercel Crons send the
`Authorization` header with your `CRON_SECRET`, or whether the secret must
be configured another way — the routes reject any call without it.)

The worker's own polling reconciler (missed-comment sweeps) does **not**
use a Vercel cron — it runs inside the Render worker on its own interval
(`COMMENT_POLL_INTERVAL_MS`, default 5 minutes), so the once-a-day cron
limit does not affect it. This is also why the worker cannot run on Vercel:
serverless functions are short-lived, and a queue consumer has to stay up.

How to tell the crons are running: after the first day, check the Vercel
dashboard (Crons / logs) for one successful run of each per day, and check
that token expiry dates in Settings keep moving forward. A cron that fails
shows up in the Vercel logs, not in the app dashboard.

---

## 7. Health checks

### `/api/health` — the one URL to check

Open `https://your-app.vercel.app/api/health` in any browser (your phone
works fine). It reports the database, Redis, queue, and worker heartbeat.
You want `{"status":"ok", ...}` with every check `ok`.

| Check | What it means | If it says `error` |
| --- | --- | --- |
| `database` | Can the app reach Neon? | Check `DATABASE_URL` on Vercel (and that Neon has not hit its free-tier limits). |
| `redis` | Can the app reach Upstash? | Check `REDIS_URL` — it must be the `rediss://` URL, not `redis://`, and not `localhost`. |
| `queue` | Is the send queue stuck? (25+ jobs waiting with none active by default — see `HEALTH_STUCK_QUEUE_WAITING`.) | The worker is not consuming. See [Worker troubleshooting](#9-troubleshooting). |
| `worker.healthy` | Has the worker sent a heartbeat recently? (Heartbeat every 30 seconds.) | The worker is not running or cannot reach Redis/Postgres. |

Note the honest edge case: a fresh heartbeat does not prove the worker is
consuming jobs — the heartbeat runs on its own timer. The queue check is
the real signal: a healthy worker never leaves jobs waiting with zero
active. If `worker.healthy` is true but the queue is stuck, the worker
process is alive but its queue consumer has stopped; restart the worker.

### After every deploy or change

1. Open `/api/health` — expect `status: ok`.
2. Sign in with a magic link (see [First checks](#10-first-checks-after-deploy)).
3. If Meta is connected, run the end-to-end comment test from
   [docs/meta-app.md](meta-app.md) (Section 10).

---

## 8. Backup and restore

Back up two things. The first one is the one that hurts to lose.

### 1. Postgres (Neon) — the data that matters

Everything OpenReply knows lives in Postgres: campaigns, accounts, tokens,
logs, workspaces. Neon provides backups / branching on its dashboard
(point-in-time recovery and database branches — exact retention and
availability depend on the plan; check the Neon dashboard). (verify:
Neon Free backup retention and whether point-in-time restore is available
on the free tier.)

Independently of Neon, take your own copy with `pg_dump` from your machine,
using the Neon connection string:

```bash
# Replace the URL with your Neon DATABASE_URL (direct connection)
pg_dump "postgresql://<user>:<password>@<neon-host>/<database>?sslmode=require" \
  > "openreply-$(date +%F).sql"
```

Store the dump **off the machine that made it** (another machine, object
storage, a backup service). A backup that lives on the same disk as the
database is not a backup. Test a restore into a throwaway database once in
a while (`createdb`, restore there, spot-check a table, drop it) — an
untested backup is a rumour.

Restore into a fresh database:

```bash
psql "postgresql://<user>:<password>@<neon-host>/<database>?sslmode=require" \
  < openreply-2026-11-05.sql
```

If the database already has data, drop and recreate it first — or restore
into a new Neon branch/database and point `DATABASE_URL` at that instead,
which is the safer move because the old data stays untouched until you are
sure the restore is good.

### 2. `ENCRYPTION_KEY` — irreplaceable

- **`ENCRYPTION_KEY` cannot be recovered from the database.** It is not
  stored anywhere in Neon. If it is lost, every stored Instagram token is
  unreadable and every connected account has to reconnect. Keep a copy in
  a password manager. This matters more than the database backup itself,
  because a perfect database backup without the key still cannot decrypt
  anything.
- `NEXTAUTH_SECRET` and `CRON_SECRET` can be rotated if lost (rotating
  `NEXTAUTH_SECRET` signs everyone out; update both Vercel and Render, then
  redeploy). `RESEND_API_KEY` and the Meta app secrets can be regenerated
  in their dashboards.

### 3. Redis (Upstash) — the queue (nice to have, not critical)

Redis holds the BullMQ send queue and the rate limiter. If Redis data is
lost, queued-but-unsent DMs are lost with it — comments already received
stay in Postgres, and the worker's polling reconciler re-sweeps for missed
comments, so the damage is bounded. Upstash Free has no backup story worth
relying on; accept the small risk, or move to a paid plan. (verify: whether
Upstash Free offers any backup/export.)

| What | How | How often |
| --- | --- | --- |
| Postgres dump | `pg_dump`, stored off-machine | Weekly at least (daily once real traffic flows) |
| `ENCRYPTION_KEY` | Password manager | On every change (ideally never changes) |
| Redis | Accept the risk, or paid plan | — |

---

## 9. Troubleshooting

### Logs, from an iPhone browser

You do not need a computer. Each provider has a web dashboard with logs:

- **Vercel:** project → Deployments → pick a deployment → Runtime Logs
  (or the Logs tab). This is where web-app errors and cron runs appear.
- **Render:** worker service → Logs tab. This is where the worker's
  startup messages, heartbeat failures, and send errors appear.
- **Neon:** project → Logs / monitoring for database errors and connection
  counts. (verify: exact location of Neon query/connection logs on the free
  tier.)
- **Upstash:** database → monitoring for command counts and memory use.
- **Resend:** dashboard → Emails / Logs for delivery status of each magic
  link.

(verify: the exact dashboard labels above — provider UIs change; follow the
intent — find the deployment/service, then its logs — if a label differs.)

### Worker troubleshooting

**Symptom: DMs are slow after a quiet period, then fine.**

The Render worker is always-on (paid Starter, ~$7/month), so it does not
sleep — there is no "free worker waking up" delay in this stack. If the
first DM after a gap is slow, the cause is usually Neon scaling to zero
after 5 minutes idle (~500 ms cold start) or a cold Vercel function, not
the worker. If DMs stay slow, check `/api/health` and the Render logs
below.

**Symptom: `/api/health` says `worker.healthy: false`.**

The worker is not running or cannot reach Redis/Postgres. In order:

1. Open the Render dashboard → worker service → Logs. Is the process up?
   If the service shows as suspended or failed to deploy, that is the
   answer — read the deploy log.
2. If the logs show `DEMO_MODE=1 — worker will not start`, remove
   `DEMO_MODE` from the Render environment variables and redeploy. Demo
   mode is local-only.
3. If the logs show a `DATABASE_URL` or `REDIS_URL` error, the values on
   Render do not match the ones on Vercel. Copy them again from Neon /
   Upstash — character for character, including the `rediss://` scheme and
   any `?sslmode=require` on the Postgres URL.
4. If the logs show an `ENCRYPTION_KEY` error, the key is malformed (must
   be exactly 64 hex characters) or differs from Vercel's. Regenerate once
   with `openssl rand -hex 32` and paste the same value in both places.
5. If the worker is up and the logs look clean but health still says
   unhealthy, restart the worker service from the Render dashboard and wait
   ~30 seconds (one heartbeat interval), then re-check `/api/health`.

**Symptom: queue is stuck (25+ jobs waiting, none active) but the worker
looks alive.**

The worker process is up but its queue consumer stopped taking jobs — a
dropped Redis connection is the usual cause. Restart the worker service on
Render. If it keeps happening, check the Upstash dashboard: free-tier
connection limits or an expired/rotated Redis credential will drop the
consumer while the heartbeat keeps ticking. Confirm `REDIS_URL` on Render
is the current Upstash `rediss://` URL.

**Symptom: Redis disconnects in the worker logs.**

- Confirm `REDIS_URL` starts with `rediss://` (TLS). Upstash Free only
  exposes a TLS endpoint; a plain `redis://` URL will not connect.
- Confirm the web app and worker share the same `REDIS_URL`. A worker
  pointed at a different (or deleted) Upstash database consumes nothing.
- Upstash Free allows 1 database — if the database was deleted and
  recreated, the URL changed; update both Vercel and Render.

**Symptom: webhooks arrive (rows in `WebhookEvent`) but no DM is ever sent.**

Same as the stuck-queue case: the worker is the first thing to check
(`/api/health`, `worker.healthy`). Also check DM Logs: if no `DmLog` rows
appear at all, the queue is not being consumed. If `DmLog` rows appear with
failures, read Meta's error text there — that is a Meta problem, not a
worker problem (see [docs/meta-app.md](meta-app.md), Section 10.3).

### Email troubleshooting (magic link not arriving)

1. **Check the allowlist first.** If `ALLOWED_EMAILS` is set and your
   address is not in it, sign-in is refused. Add the address (Vercel env
   vars), redeploy, and try again.
2. **Check Resend's logs.** Resend dashboard → Emails: if the message is
   there with status delivered, the problem is on the receiving side (spam
   folder, corporate filter). If it is not there at all, the app never sent
   it — check the Vercel logs for the send error.
3. **Check `RESEND_API_KEY` and `EMAIL_FROM`.** A wrong or revoked key, or
   a sender domain that was never verified, fails the send. The placeholder
   sender `login@example.com` will not deliver.
4. **Check the domain situation.** Without a verified domain, Resend only
   sends to the account owner's own email. If the magic link works for your
   own address but not for anyone else's, this is why — verify a domain in
   Resend (free, but you need a domain you own) or use `EMAIL_SERVER`
   instead. The domain decision is yours; nothing else in this stack
   unblocks other recipients.
5. **Check spam.** Magic links from a new sender land in spam more often
   than you would like. Search for the sender address, not just the inbox.
6. **If you use `EMAIL_SERVER` instead of Resend:** confirm the SMTP URL
   is URL-encoded (`@` → `%40` in the username/password), the port matches
   the scheme (465 with `smtps://`, 587 with `smtp://`), and the mail
   server accepts logins from Vercel's network. A wrong port or an
   un-encoded `@` is the usual failure.

### Other symptoms

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Sign-in fails with a callback error | `NEXTAUTH_URL` does not match the domain you are on | Set `NEXTAUTH_URL` to exactly the Vercel domain, no trailing slash, `https://`. |
| App throws on boot naming `ENCRYPTION_KEY` | Key is not exactly 64 hex characters | Regenerate with `openssl rand -hex 32`, paste the same value on Vercel and Render. |
| App throws naming another variable | A required variable is missing on that service | Compare Vercel's and Render's env vars against the table in Section 4 — a variable set on one and missing on the other is the classic miss. |
| Cron jobs never run / tokens expire | `CRON_SECRET` mismatch, or Vercel Crons not configured | Confirm `CRON_SECRET` on Vercel and that the three crons exist in `vercel.json` and in the Vercel dashboard. |
| Instagram connect fails | Meta not set up yet, or a Meta value is wrong | Meta comes later — see below. Do not debug Meta until the Meta app exists. |

---

## 10. First checks after deploy

Run these once, after the first deploy and after every big change:

1. `https://your-app.vercel.app/api/health` returns `status: ok`.
2. Request a magic link with your allowlisted email and sign in.
   (If the link does not arrive, see
   [Email troubleshooting](#email-troubleshooting-magic-link-not-arriving).)
3. Confirm the dashboard loads and the demo banner is **absent** — if you
   see "Demo mode — simulated activity only", `DEMO_MODE` is set somewhere
   it should not be.
4. Confirm the three Vercel crons exist in the Vercel dashboard and have a
   next-run time.
5. In Render, confirm the worker service is running (not suspended) and its
   logs show `[DM Worker] Started`.

Full first-deploy walkthrough, including the first magic-link login, is in
[docs/deploy-split-stack.md](deploy-split-stack.md).

---

## 11. Redeploy and rollback, per provider

### Redeploy

- **Vercel:** push to the deployed branch, or click Redeploy on a
  deployment in the Vercel dashboard. A redeploy re-runs `vercel-build`
  (generate + build only — it does not run migrations). If the deploy
  includes a schema change, run the migration one-off command first (see
  [Migrations](#5-migrations)).
- **Render:** push to the deployed branch (if auto-deploy is on), or click
  Manual Deploy in the Render dashboard. A worker redeploy restarts the
  process; jobs already in the queue wait in Upstash Redis and are picked
  up when the new worker starts. In-flight jobs retry (BullMQ attempts: 3).
- **Neon / Upstash / Resend:** nothing to redeploy — they are managed
  services, not code. Changing a connection string or API key means
  updating the env vars on Vercel and Render and redeploying both.

### Rollback

- **Vercel:** open the previous good deployment in the Vercel dashboard
  and promote it (or redeploy it). Code rolls back; the database does not
  — migrations are one-way. If the bad deploy included a migration, rolling
  back the code without rolling back the schema can leave the old code
  talking to a new schema. Prefer fixing forward (a new deploy with the
  fix) over rolling back when a migration was involved.
- **Render:** redeploy the previous commit from the Render dashboard, or
  push a revert. Same migration caveat as Vercel: the worker and the web
  app must agree on the schema, so roll both back together if you roll
  back at all.
- **Database rollback:** restore from a Neon backup/branch or from your own
  `pg_dump` (see [Backup](#8-backup-and-restore)). This is the only way to
  undo a migration — there is no "un-migrate" button. Test the restore on a
  throwaway database first.
- **Secrets rollback:** if a rotated secret breaks sign-in, put the old
  value back in both Vercel and Render and redeploy both. Keep the previous
  values in your password manager until the new ones are proven working.

---

## 12. Meta setup pointers

Meta integration comes **later**, after this stack is healthy. When you are
ready, follow [docs/meta-app.md](meta-app.md) — the full walkthrough. The
production URLs you will paste into Meta's console are, with
`your-app.vercel.app` replaced by your real Vercel domain:

| Meta field | Value |
| --- | --- |
| OAuth redirect URI | `https://your-app.vercel.app/api/instagram/callback` (no trailing slash) |
| Webhook callback URL | `https://your-app.vercel.app/api/webhook` |
| Webhook verify token | Your `WEBHOOK_VERIFY_TOKEN` value, exactly as set on Vercel |
| Privacy policy URL | `https://your-app.vercel.app/privacy` |
| Terms of service URL | `https://your-app.vercel.app/terms` |
| Data deletion URL | `https://your-app.vercel.app/data-deletion` |

And the env vars to set on **Vercel** at that point (leave them unset until
then): `META_GRAPH_API_VERSION` (default `v25.0`), `INSTAGRAM_APP_ID`,
`INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`.
Subscribe the webhook to **both** the `comments` and `messages` fields.
Real comment webhooks are only delivered when the Meta app is **Live** —
in Development mode only Meta's console Test button delivers events.

Do not promise anyone a working Instagram DM until the end-to-end test in
[docs/meta-app.md](meta-app.md) (Section 10) passes: a keyword comment from
a **different** Instagram account produces a DM and a `SENT` row in DM
Logs. Until then, the honest status is "app deployed, Instagram not
connected yet."

---

## 13. Estimated costs

All free tiers, as understood when this guide was written. **Confirm every
figure in the provider dashboards** — free tiers change, and the dashboard
is the source of truth.

| Service | Tier | Estimated cost |
| --- | --- | --- |
| Vercel (web app) | Hobby | $0 |
| Neon (Postgres) | Free — 0.5 GB storage, 100 compute-hours/month, scales to zero after 5 min idle | $0 |
| Upstash (Redis) | Free — 256 MB, 500,000 commands/month, 1 database | $0 |
| Render (worker) | **Starter — no free tier for background workers** | ~**$7/month** (estimate — confirm in the Render dashboard) |
| Resend (email) | Free — 3,000 emails/month, 100/day, 1 verified domain | $0 |
| **Total today** | | **~$7/month** |
| First future spend | Upstash Fixed plan (unmetered commands) if BullMQ's idle polling outgrows the 500K/month free budget — watch the usage meter in week 1 | ~$10/month (estimate — confirm in the Upstash dashboard) |

No card is required for Neon Free or Resend Free (confirm at signup). A
card **is** required on Render for the paid worker instance.
(verify: whether Vercel Hobby and Upstash Free ask for a card at signup.)

---

## 14. Security maintenance

- **Rotate secrets on a schedule, and immediately if exposed.** Generate a
  new value, update Vercel **and** Render, redeploy both, and confirm
  `/api/health` and sign-in still work before deleting the old value from
  your password manager. Rotating `NEXTAUTH_SECRET` signs everyone out;
  rotating `ENCRYPTION_KEY` is not a rotation — it is a destructive event
  (every connected Instagram account must reconnect), so treat the key as
  never-rotated and never-exposed instead.
- **Keep dependencies updated.** Run `npm audit` and update Next.js,
  Prisma, BullMQ, and Auth.js when security fixes land. Test with `npm
  test`, `npm run typecheck`, and `npm run lint` before deploying.
  Dependabot or Renovate on the repo can file the update PRs for you.
  (verify: whether Dependabot/Renovate is enabled on this repo.)
- **Allowlist discipline.** Keep `ALLOWED_EMAILS` set to just the people
  who should sign in. Review it when someone leaves or a new person needs
  access. An unset allowlist is an open signup form on a public URL.
- **Never commit `.env` files.** `.env`, `.env.production`, and any file
  holding a real secret are gitignored. Check `git status` before every
  commit; if a secrets file ever appears there, stop and remove it, then
  rotate everything in it.
- **Least privilege on dashboards.** The Vercel, Neon, Upstash, Render, and
  Resend accounts hold the keys to the whole instance. Use strong,
  unique passwords and two-factor authentication on each, and do not share
  the logins more widely than needed.
- **Watch the logs.** A weekly glance at Vercel logs, Render worker logs,
  and Resend delivery logs catches token-refresh failures and queue stalls
  before they become "nothing has worked for days." The token-refresh cron
  fails silently everywhere else.
