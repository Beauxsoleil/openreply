# Deploying OpenReply on Railway (all services)

This guide covers running the whole OpenReply stack on Railway: web app,
worker, managed Postgres, and managed Redis. It replaces the split
Vercel-web + Railway-worker setup in `docs/setup.md` — here the web app
also lives on Railway, so web and worker share Railway's private network
and can both use the internal database/Redis hostnames.

> **⚠️ Config as Code is deprecated — read before relying on these files.**
>
> Railway deprecated Config as Code (`railway.json` / `railway.toml`) in
> favour of Infrastructure as Code (`.railway/railway.ts`, applied with the
> Railway CLI). Per Railway's docs (checked 2026-11-05):
>
> - New services **cannot opt into** Config as Code.
> - Existing `railway.json` files **stop being read on 2026-12-01** (hard
>   cutoff).
>
> `railway.json` and `railway.worker.json` in this repo are therefore a
> **short-lived bridge**: they work for a service created before the
> cutoff, and they document the exact settings to mirror in the dashboard
> or in IaC. Do not treat them as the durable source of truth. The
> durable follow-up is to author `.railway/railway.ts` (see
> <https://docs.railway.com/infrastructure-as-code>) and migrate with
> `railway config migrate` before 2026-12-01. Until then, after creating
> each service, verify in the dashboard that the settings below actually
> took effect — a dashboard value and a config-file value can disagree,
> and the file wins for the current deployment only.

## Topology

One Railway project, four services, all from this repo except the two
managed databases:

| Service | Source | Start command | Public domain |
| --- | --- | --- | --- |
| `openreply-web` | This repo, `Dockerfile` | `npm run start` | Yes — this is `NEXTAUTH_URL` |
| `openreply-worker` | Same repo/image | `npm run worker` | No |
| `openreply-cron` (optional) | Same repo/image | `sh scripts/cron.sh` | No |
| Postgres | Railway managed database | — | No |
| Redis | Railway managed database | — | No |

The worker and cron services run from the same image as the web app; only
the start command differs. The Dockerfile already ships everything all
three need (full `node_modules`, source tree, generated Prisma client,
`scripts/`, `wget`).

## Step-by-step

1. Create a Railway project. Add a Postgres database and a Redis database
   from the Railway catalogue. Note their internal hostnames
   (`postgres.railway.internal`, `redis.railway.internal`).
2. **Web service:** New → GitHub Repo → this repo, `main` branch.
   Railway auto-detects `railway.json` at the repo root and applies it:
   Dockerfile builder, `npm run start`, healthcheck on `/api/health`,
   restart `ON_FAILURE` (max 10 retries), and `npm run db:migrate` as a
   pre-deploy command. Assign a public domain (container port `3000`);
   that domain becomes `NEXTAUTH_URL`.
3. **Worker service:** New → GitHub Repo → same repo, `main` branch.
   Name it `openreply-worker`. In Service → Settings → **Config File**,
   point it at `/railway.worker.json` (absolute path from the repo root —
   the config-file path does *not* follow the service's Root Directory).
   That file sets the Dockerfile builder, `npm run worker`, and restart
   `ON_FAILURE` (max 10 retries). Do **not** give it a public domain and
   do **not** add a pre-deploy migration command — migrations run once,
   from the web service, so two services never run `migrate deploy`
   concurrently.
4. **Cron service (optional, recommended):** same pattern as the worker —
   a third service from the same repo. There is no config file for it in
   this repo; set the start command in the dashboard to
   `sh scripts/cron.sh`, no public domain, restart `ON_FAILURE`. It is a
   long-running loop (calls `attach-next-reel` every 5 minutes and
   `refresh-tokens` + `snapshot-followers` once a day), not a one-shot
   script, so it runs as a service, not a scheduled job. Set
   `CRON_BASE_URL` to the web service's private domain
   (e.g. `http://openreply-web.railway.internal:3000`) — the cron
   service calls the web app's `/api/cron` routes over Railway's private
   network. See "Cron alternatives" below.
5. Set the environment variables (below) on each service. The managed
   Postgres/Redis services expose `DATABASE_URL` / `REDIS_URL` as
   reference variables — attach them to the web, worker, and cron
   services so all three share the same values.
6. Deploy the **worker first, then the web service** (see the healthcheck
   note below), then check `https://<your-domain>/api/health`.

## Environment variables

Set these on the web, worker, and cron services (same values everywhere
unless noted). Full list and comments live in `.env.example`.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Railway Postgres reference variable (internal hostname). Same value on all three services. |
| `REDIS_URL` | Railway Redis reference variable (internal hostname). Same value on all three services. |
| `NEXTAUTH_URL` | The web service's public domain, e.g. `https://openreply.example.com`. |
| `NEXTAUTH_SECRET` | Strong random secret. Also the fallback the `/api/cron` routes accept when `CRON_SECRET` is unset. |
| `CRON_SECRET` | Strong random secret for `/api/cron` (cron service only needs it plus `CRON_BASE_URL`). |
| `ENCRYPTION_KEY` | 64 hex chars (`openssl rand -hex 32`). **Must be identical on web and worker** or DM sends fail to decrypt. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Magic-link email (or `EMAIL_SERVER` for your own SMTP). |
| `META_GRAPH_API_VERSION`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN` | Meta app credentials. |
| `ALLOWED_EMAILS` | Optional allowlist for sign-in; without it anyone reaching the public URL can request a magic link. |
| `CRON_BASE_URL` | Cron service only: the web service's private URL (see step 4). |

Do **not** set `DEMO_MODE=1` in production — demo mode disables real
Instagram sends. Railway injects `PORT` automatically; `next start`
listens on it, so no port override is needed.

## Migrations

`railway.json` runs `npm run db:migrate` (`prisma migrate deploy`) as a
pre-deploy command on the web service: it runs after the image builds and
before the new deployment goes live, with the database reachable over the
private network. That is the correct place for it — migrations must
**not** run during the Docker build, when the database is unreachable
(the `vercel-build` script bundles them into the build and fails the same
way on Railway). The worker service deliberately has no pre-deploy
command, so migrations run exactly once per deploy.

## Healthcheck — deploy the worker first

`/api/health` answers 200 only when the database, Redis, queue, **and
worker heartbeat** are all healthy, and 503 otherwise. On a fresh
project the web service cannot pass its Railway healthcheck until the
worker is up and heartbeating, so deploy the worker first and allow up
to 5 minutes (`healthcheckTimeout: 300` in `railway.json`) for the first
web deploy to go healthy. If the worker is down later, the web service
reports degraded — that is by design, not a false alarm: a web app that
cannot reach its worker cannot deliver DMs.

## Cron alternatives

Running `scripts/cron.sh` as a long-running service (step 4) is the
minimal option and mirrors `docker-compose.prod.yml`. Railway also has
native cron jobs (`deploy.cronSchedule` in a config file, or a Cron Job
service in the dashboard): a cron job starts the service on a schedule
and the service is expected to exit. That would need a **one-shot**
caller script (one run of `attach-next-reel`, one of `refresh-tokens`,
one of `snapshot-followers`) — `scripts/cron.sh` is a loop, not
one-shot, so it cannot be dropped into a cron job as-is. Nobody has
built the one-shot variant; if it is built later, the schedules are
`*/5 * * * *` for `attach-next-reel` and a daily run for
`refresh-tokens` + `snapshot-followers`. Until then, use the service.

## What is not in this repo

- No Railway account or project exists yet — this guide and the two
  config files are preparation only. Provisioning is a separate step
  done in the Railway dashboard (or with the Railway CLI for IaC).
- `railway.json` covers the **web** service only. The worker's settings
  live in `railway.worker.json` and must be linked per service (step 3);
  Railway reads one config file per service, not one file for the whole
  project.
