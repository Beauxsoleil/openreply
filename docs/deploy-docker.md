# Deploying OpenReply with Docker Compose

This guide deploys OpenReply on a single server with plain Docker Compose — no Vercel, no Railway, no Dokploy. Everything runs on your box: the web app, the worker, the cron scheduler, Postgres, and Redis.

If you would rather have a platform manage the services for you, see [Self-Hosting on Dokploy](deploy-dokploy.md) or the Vercel + Railway path in [Setup](setup.md).

## What you are deploying

| Service | What it does |
| --- | --- |
| `web` | The Next.js dashboard, OAuth callback, and webhook receiver (port 3000) |
| `worker` | A long-running process that sends the DMs. Without it, webhooks arrive and nothing ever replies |
| `cron` | Runs `scripts/cron.sh`: refreshes Instagram tokens daily and binds campaigns to newly published reels every 5 minutes |
| `postgres` | Campaigns, logs, accounts, sessions |
| `redis` | The BullMQ send queue and the per-account rate limiter |

The web app and the worker **must share the same `DATABASE_URL`, `REDIS_URL`, and `ENCRYPTION_KEY`**. The web app writes an encrypted Instagram token; the worker decrypts it to send. Different keys mean every send fails to decrypt. The Compose file gives all five services the same `.env.production` file, so this stays in sync automatically — as long as you only edit that one file.

## Prerequisites

- **Docker Engine 24+ and Docker Compose v2** on the server. Check with `docker --version` and `docker compose version`. (Docker Desktop on macOS/Windows includes both.)
- **A domain name** pointing at the server (an `A` record for e.g. `openreply.example.com`). Meta requires a public HTTPS URL for webhooks and OAuth redirects — `http://`, an IP address, and `localhost` will not work.
- **A way to serve HTTPS.** The Compose stack itself serves plain HTTP on localhost only (see [TLS and reverse proxy](#tls-and-reverse-proxy)). The usual answer is Caddy, Traefik, or nginx in front of it.
- **A Resend account** (or your own SMTP server) for login emails. Login is email magic links only — without working email, nobody can sign in. [Resend](https://resend.com) has a free tier; verify a sender domain before you deploy.
- **Ports 80 and 443 open** on the server's firewall (for the reverse proxy), and port 3000 **closed** to the internet — the app is only meant to be reached through the proxy.
- About 2 GB of free disk for the image, plus room for the Postgres volume to grow.

## First deploy

### 1. Get the code on the server

```bash
git clone https://github.com/diwenne/openreply.git
cd openreply
```

### 2. Create the environment file

```bash
cp .env.production.example .env.production
```

Open `.env.production` in an editor and fill in every `REQUIRED` value. The comments in the file say how to generate each secret. The three things people get wrong:

1. **`NEXTAUTH_URL` must be your public HTTPS URL** (e.g. `https://openreply.example.com`), with no trailing slash. Not `http://`, not `localhost`. This is what magic-link emails, OAuth redirects, and tracked links in DMs all point at — and it has to match the URLs you register in Meta.
2. **`ENCRYPTION_KEY` must be exactly 64 hex characters** — generate it with `openssl rand -hex 32`. The app throws on boot otherwise. Losing or changing it later means every connected Instagram account has to reconnect, so back it up somewhere safe (a password manager, not in the repo).
3. **`ALLOWED_EMAILS` should be set to just your own address(es).** If you leave it unset, anyone who reaches your public URL can request a magic link and gets their own workspace.

`DATABASE_URL` must stay in sync with `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` in the same file (same user, same password, same database, host `postgres` — the Compose service name, not `localhost`).

Never commit `.env.production`. It is gitignored; keep it that way.

### 3. Build the image

```bash
docker compose -f docker-compose.prod.yml build
```

This runs `npm run build` inside the image (`prisma generate && next build`). It needs internet access to fetch npm packages. Expect a few minutes on the first build.

> If you publish the image to a registry instead (the repo has a `docker-publish.yml` workflow that pushes to Docker Hub when `DOCKERHUB_ENABLED` is `true`), you can skip the build and pull it. The Compose file builds from the local checkout by default.

### 4. Run the database migrations

Do this **once**, before the first start, and again after every upgrade that ships a migration:

```bash
docker compose -f docker-compose.prod.yml run --rm web npm run db:migrate
```

This runs `prisma migrate deploy` from the `web` container against the Postgres service. It starts Postgres (and Redis, as dependencies) if they are not already running, applies any pending migrations, then removes the one-off container. Do not run migrations as part of the build: the build has no database to reach.

### 5. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

Check that everything came up healthy:

```bash
docker compose -f docker-compose.prod.yml ps
```

You should see all five services `Up`, with `web`, `postgres`, and `redis` marked `(healthy)`. The worker has no healthcheck of its own — its health is reported by `/api/health` (below), and the `cron` service depends on the web app being healthy before it starts calling it.

### 6. Verify it works

```bash
curl http://localhost:3000/api/health
```

You want `{"status":"ok", ...}` with every check `ok`. In particular:

- `database` / `redis` — the datastores are reachable.
- `queue` — the send queue is not stuck.
- `worker.healthy` — the worker process has sent a recent heartbeat. If this is `false`, the worker is not running or cannot reach Redis, and no DM will ever send even though webhooks are being received.

Then open the dashboard at your public URL (`https://openreply.example.com`), request a magic link with an allowlisted email, and sign in. From here, connecting Instagram and testing a campaign are the same as in [Setup](setup.md) — pick Zernio or your own Meta app, register the OAuth redirect (`https://your-domain/api/instagram/callback`) and webhook (`https://your-domain/api/webhook`) URLs, and test a keyword comment from a second account.

## TLS and reverse proxy

The Compose stack binds the web app to `127.0.0.1:3000` only — it is not reachable from the internet on its own. A reverse proxy in front of it terminates TLS and forwards to `web:3000` (or `127.0.0.1:3000` from the host). This is also what gives Meta the public HTTPS endpoint it requires.

**Caddy (simplest — automatic HTTPS):**

```caddyfile
openreply.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy obtains and renews a Let's Encrypt certificate for the domain automatically. Run it on the host (`caddy run`) or as another container on the same Docker network (then proxy to `web:3000` instead).

**Traefik or nginx** work the same way: terminate TLS at the proxy, forward plain HTTP to the web service on port 3000. The details depend on your setup; the contract is just "public HTTPS in, `web:3000` out".

Two things to get right at the proxy:

- **Do not redirect or rewrite the webhook path.** Meta POSTs to `/api/webhook` and does not reliably follow redirects — a 307 from a non-primary domain silently stops webhooks. Make sure the domain Meta has is the one the proxy actually serves.
- **Forward the original host and protocol headers** (`X-Forwarded-Host`, `X-Forwarded-Proto`). Auth.js uses them to validate callbacks; if the app thinks it is on `http://localhost:3000` while the browser is on `https://your-domain`, sign-in fails.

If you want the app reachable directly on port 3000 without a proxy (not recommended — no TLS, and Meta will refuse the webhook), change the `ports:` line in `docker-compose.prod.yml` from `"127.0.0.1:3000:3000"` to `"3000:3000"`.

## Viewing logs

Per service:

```bash
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f worker
docker compose -f docker-compose.prod.yml logs -f cron
docker compose -f docker-compose.prod.yml logs -f postgres
docker compose -f docker-compose.prod.yml logs -f redis
```

`-f` follows; drop it for a snapshot, add `--tail 100` to limit it. `logs -f` with no service name tails everything at once.

The `cron` logs are worth a glance after the first day: you should see `attach-next-reel ok ...` lines every 5 minutes and `refresh-tokens ok` / `snapshot-followers ok` once a day around 05:00 UTC. A `FAILED` line there means a scheduled job is not running — and the token-refresh one fails silently everywhere else, until Instagram tokens expire and every automation stops.

## Upgrading

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm web npm run db:migrate
docker compose -f docker-compose.prod.yml up -d
curl http://localhost:3000/api/health
```

Order matters: pull, rebuild, **migrate**, then restart. Migrating after the restart means the new code boots against the old schema. Check `/api/health` and the `worker` logs after every upgrade; a failed migration shows up in the `run --rm web` output, not in the web logs.

## Backup and recovery

Back up three things. The first two are the ones that hurt to lose.

### 1. Postgres — the data that matters

Everything OpenReply knows lives in Postgres: campaigns, accounts, tokens, logs, workspaces. Back it up daily with `pg_dump` from the host:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U postgres -d openreply > "openreply-$(date +%F).sql"
```

`-T` disables TTY allocation so the dump streams cleanly to the file. Store the dump **off the server** (another machine, object storage, a backup service). A backup that lives on the same disk as the database is not a backup.

Restore into a fresh stack (after `up -d`, before you need the data):

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres -d openreply < openreply-2026-11-05.sql
```

If the database already has data, drop and recreate it first (`dropdb` / `createdb` inside the container, or `docker compose -f docker-compose.prod.yml down -v` to wipe the volumes entirely and start clean — note `-v` deletes **all** data, including Redis).

To check a dump is restorable before you need it, restore it into a throwaway database once in a while (`createdb openreply_restore_test`, restore there, spot-check a table, drop it). An untested backup is a rumour.

### 2. `.env.production` — the secrets

Without it you cannot decrypt anything, even with a perfect database backup. In particular:

- **`ENCRYPTION_KEY` is irreplaceable.** There is no way to recover it from the database. If it is lost, every connected Instagram account has to reconnect, and every stored token is unreadable. Keep a copy in a password manager.
- `NEXTAUTH_SECRET`, `CRON_SECRET`, `POSTGRES_PASSWORD`, and the Meta app secrets can be rotated if lost, but rotating `NEXTAUTH_SECRET` signs everyone out and rotating `POSTGRES_PASSWORD` requires updating both it and `DATABASE_URL` in the same file.

### 3. Redis — the queue (nice to have, not critical)

Redis holds the BullMQ send queue and the rate limiter, persisted with append-only mode (`--appendonly yes` in the Compose file, volume `redisdata`). If Redis data is lost, queued-but-unsent DMs are lost with it — comments already received stay in Postgres, and the worker's polling reconciler re-sweeps for missed comments, so the damage is bounded. Backing up the `redisdata` volume (snapshot it while Redis is stopped, or `docker compose ... exec redis redis-cli BGSAVE` and copy the resulting `appendonly.aof`) is worth doing if you want zero lost sends, but it is not in the same league as the Postgres backup.

### What to back up, how often

| What | How | How often |
| --- | --- | --- |
| Postgres dump | `pg_dump` (above), stored off-server | Daily |
| `.env.production` | Password manager / secrets store | On every change |
| Redis AOF | Volume snapshot or `BGSAVE` copy | Weekly, or skip — see above |

## Troubleshooting

**`docker compose ... up` fails with a missing-variable or validation error.**
`docker compose -f docker-compose.prod.yml config -q` validates the file without starting anything. A missing `.env.production` shows up as an error about `env_file` not found — copy the example file first (step 2).

**Web container is up but never becomes healthy.**
`docker compose -f docker-compose.prod.yml logs web` — the usual causes are a bad `DATABASE_URL` (host must be `postgres`, and the password must match `POSTGRES_PASSWORD`), a malformed `ENCRYPTION_KEY` (must be exactly 64 hex characters), or `NEXTAUTH_URL` failing the URL check in `lib/env.ts`. The app throws on boot for the last two, and the message names the variable. `curl http://localhost:3000/api/health` answers 503 with a per-check `detail` once the app is up; check that before guessing.

**`/api/health` says `status: degraded` with `worker.healthy: false`.**
The worker is not running or cannot reach Redis. Check `docker compose -f docker-compose.prod.yml ps` (is `worker` up?), then `logs worker`. The common cause is a `REDIS_URL` that does not resolve inside the containers — it must be `redis://redis:6379`, not `localhost`. Note the health endpoint also reports `degraded` when the queue is stuck (25+ jobs waiting with none active), which is the same root cause: the worker is not consuming.

**Webhooks arrive but no DM is ever sent.**
Same as above — the worker is the first thing to check (`/api/health`, `worker.healthy`). Also check the DM Logs page and the `WebhookEvent` table: if events are being recorded but no `DmLog` rows appear, the queue is not being consumed.

**Comments work, but the token refresh never happens.**
Check `docker compose -f docker-compose.prod.yml logs cron`. If the container is not running, `up -d` again and check its logs — it exits immediately if neither `CRON_SECRET` nor `NEXTAUTH_SECRET` is set. If it is running but logging `FAILED`, the web app is not answering `/api/cron/*` — check that `CRON_SECRET` matches between the cron service and the web app (they share `.env.production`, so this only breaks if you overrode it per-service).

**`npm run db:migrate` fails with `P1001: Can't reach database server`.**
The migration command runs inside the `web` container against host `postgres`. If you ran `prisma migrate deploy` from your laptop instead, it cannot resolve `postgres` — run the Compose command from step 4, which runs it inside the Compose network.

**Magic-link email never arrives.**
Check `RESEND_API_KEY` (or `EMAIL_SERVER`) and `EMAIL_FROM` in `.env.production` — the placeholder sender domain will not deliver. Check the web logs for the send error, and confirm the address you are signing in with is in `ALLOWED_EMAILS` if you set it. Mailpit is a dev-only tool; it does not exist in this stack.

**Instagram connect fails with a redirect mismatch or `code=100`.**
The OAuth redirect registered in Meta must be exactly `https://your-domain/api/instagram/callback` (no trailing slash), and `NEXTAUTH_URL` must be the same domain. The `code=100` "Unsupported request" error with a valid-looking token usually means the Instagram account has no role on the Meta app — see [Setup](setup.md#step-6-add-your-instagram-account-as-a-tester-and-accept-the-invite).

**Disk filling up.**
Docker build cache and old images grow over time: `docker system prune -a` (after an upgrade, once the new image is running) reclaims it. The Postgres volume grows with logs — the daily `pg_dump` is also your reminder that the data exists somewhere else.
