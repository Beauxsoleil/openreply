# Deploy OpenReply on the Split Stack

Step-by-step provisioning for the split stack: **Vercel** (web app) +
**Neon** (Postgres) + **Upstash** (Redis) + **Render** (worker) + **Resend**
(login email). Follow the steps in order — each one hands the next one
something it needs.

> **Who this is for.** You do not need to be a DevOps engineer. You need a
> GitHub account with this repo, an email address you check, and a phone or
> browser. Every step is something you (or an agent working with your
> approvals) can actually do from a browser. Where a dashboard label or a
> limit could not be verified from this repo, the step is marked
> **(verify)** — if the screen looks different from the description, follow
> the *intent* of the step and check the provider's own docs rather than
> guessing.
>
> **What this does not do.** This guide gets the app, database, queue,
> worker, and login email running. It does **not** connect Instagram — Meta
> comes later (see [Step 10](#step-10-what-comes-next-meta)). The Meta
> variables stay **unset** throughout. Nothing here claims live Instagram
> messaging works yet.
>
> **The old Railway plan is abandoned.** Do not follow Railway instructions
> from old branches, pull requests, or chat history. This guide replaces
> them.
>
> **Cost:** about **$7/month**, not $0. Vercel Hobby, Neon Free, Upstash
> Free, and Resend Free cost nothing, but **Render has no free tier for
> background workers** — the worker needs a paid Starter instance, about
> $7/month (estimate), and a card on Render. That is the stack's only
> unavoidable cost. Confirm every limit and price in each provider's
> dashboard — free tiers change. No card is required for Neon Free or
> Resend Free (confirm at signup). (verify: whether Vercel Hobby and
> Upstash Free ask for a card at signup.)

Running the finished stack day to day — health checks, logs, backups,
troubleshooting, rollback — is in
[docs/production.md](production.md). The self-hosted Docker alternative is
in [docs/deploy-docker.md](deploy-docker.md).

---

## Before you start

Have these ready:

- [ ] This repo on GitHub (your fork, or the `Beauxsoleil/openreply` repo),
  on the branch you want to deploy (usually `main`). (verify: confirm the
  deploy branch in each provider's project settings when you connect the
  repo.)
- [ ] A GitHub account that can authorize Vercel and Render to read the
  repo.
- [ ] The email address you will sign in with. This goes in
  `ALLOWED_EMAILS` so nobody else can create an account on your instance.
- [ ] About an hour, unhurried. Most of it is waiting for first deploys.

You will generate three secrets during this guide. Generate each one
**once**, save it in a password manager, and paste the same value everywhere
it is needed:

```bash
# Run on your own computer (Terminal on a Mac, or any shell)
openssl rand -base64 32   # → NEXTAUTH_SECRET
openssl rand -base64 32   # → CRON_SECRET (run again: a different value)
openssl rand -hex 32      # → ENCRYPTION_KEY (must be exactly 64 hex characters)
```

Never paste a secret into a chat, an issue, or a support ticket. Never reuse
the placeholder values from `.env.example` — they are deliberately invalid.
Full rules are in [production.md](production.md#secrets-generation-checklist).

---

## Step 1: Neon — create the Postgres database

Do Neon first, because Vercel and Render both need the connection string
from it.

1. Go to Neon (neon.tech — (verify: confirm the signup URL from Neon's own
   site, do not trust this link text)) and create a free account. No card
   is required for the free tier (confirm at signup).
2. Create a new project. Give it a recognisable name (e.g. `openreply`).
   Accept the defaults for region unless you have a reason to change them.
   (verify: the exact project-creation fields — follow Neon's current
   flow.)
3. Create a database inside the project (the default name is usually
   `neondb` — any name is fine, but write down the one you use).
4. Open the connection details for the database. Neon shows **two**
   forms of the connection string — copy **both** and save them in your
   password manager:

   - **Pooled** (host contains `-pooler`) → save as `DATABASE_URL`. This
     is the one the app and the worker use:
     `postgresql://<user>:<password>@<host>-pooler.<region>.aws.neon.tech/<database>?sslmode=require`
   - **Direct** (same string minus `-pooler`) → save as `DIRECT_URL`.
     This is the one migrations use — never run migrations against the
     pooled endpoint (Neon's pooler is PgBouncer in transaction mode,
     which does not guarantee the same backend connection for a
     migration's session-scoped work).

   You will paste `DATABASE_URL` into Vercel (Step 5) and Render
   (Step 6). `DIRECT_URL` stays on your own machine for the one-off
   migration command in Step 5 — it is not set on Vercel or Render.

   > **Note the free-tier behaviour:** Neon Free gives 0.5 GB storage and
   > 100 compute-hours a month, and scales to zero after 5 minutes idle.
   > The first query after a quiet period takes about half a second longer
   > (~500 ms cold start). That is normal.

5. Keep the Neon dashboard open in a tab — you will come back for the
   connection string if a paste goes wrong.

**Done when:** you have a `DATABASE_URL` saved that starts with
`postgresql://` and points at a Neon host.

---

## Step 2: Upstash — create the Redis database

1. Go to Upstash (upstash.com — (verify: confirm the signup URL from
   Upstash's own site)) and create a free account.
2. Create a new Redis database. Give it a recognisable name (e.g.
   `openreply-queue`). Accept the defaults for region unless you have a
   reason to change them. (verify: the exact creation fields.)
3. Open the database details and copy the connection URL. It looks like:

   ```
   rediss://default:<password>@<host>:<port>
   ```

   Note the double `s` in `rediss://` — that means TLS, and Upstash Free
   only exposes a TLS endpoint. A plain `redis://` URL will not connect.
   Save it in your password manager as `REDIS_URL`. You will paste it into
   Vercel (Step 5) and Render (Step 6).

   > **Note the free-tier behaviour:** Upstash Free gives 256 MB, 500,000
   > commands a month, and 1 database. That is plenty for this app's queue
   > at small volume. Do not substitute an HTTP-only Redis — BullMQ needs
   > blocking commands, which HTTP-only Redis does not support.

**Done when:** you have a `REDIS_URL` saved that starts with `rediss://`.

---

## Step 3: Resend — create the email account and API key

Login is email magic links only, so without working email nobody can sign
in. Do this now, not after deploy.

1. Go to Resend (resend.com — (verify: confirm the signup URL from
   Resend's own site)) and create a free account. No card is required for
   the free tier (confirm at signup).
2. Create an API key (Resend dashboard → API Keys, or equivalent — (verify:
   the exact location)). It starts with `re_`. Save it in your password
   manager as `RESEND_API_KEY`.
3. **Decide about a sender domain now, or defer it knowingly:**
   - **Without a verified domain** (the $0 starting point): Resend can only
     send to the account owner's own email address, from
     `onboarding@resend.dev`. Your own magic-link login will work; nobody
     else can receive a magic link. That is a Resend restriction, not an
     app bug.
   - **With a verified domain** (later, your call): verify a domain you own
     in Resend (free in Resend, but you need a domain and access to its DNS
     settings) and set `EMAIL_FROM` to a sender on that domain, e.g.
     `OpenReply <login@example.com>`. Then anyone in `ALLOWED_EMAILS` can
     sign in.
   - The domain decision is yours to make later. Nothing else in this stack
     unblocks other recipients. Flag it as a decision, not a step you
     missed.
4. For the first deploy, set `EMAIL_FROM` to the onboarding sender if you
   have no verified domain — (verify: the exact onboarding sender address
   format Resend currently uses; it is shown in the Resend dashboard when
   no domain is verified). Update it when you verify a domain.

   > **Alternative:** if you already run your own mail server, you can
   > point `EMAIL_SERVER` at it instead and skip Resend entirely (see the
   > env-var table in [production.md](production.md#4-environment-variable-reference)).
   > If `EMAIL_SERVER` is set, it takes over and `RESEND_API_KEY` is not
   > needed.

**Done when:** you have a `RESEND_API_KEY` saved, and you know whether you
are starting with or without a verified domain.

---

## Step 4: Generate the secrets

If you have not already, run the three commands from
[Before you start](#before-you-start) on your own computer and save the
outputs in your password manager:

| Secret | Command | Notes |
| --- | --- | --- |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` | Session secret. At least 16 characters (the app enforces this). |
| `CRON_SECRET` | `openssl rand -base64 32` | Protects the `/api/cron/*` routes. A different value from `NEXTAUTH_SECRET`. |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | Must be exactly 64 hex characters. Same value on Vercel and Render. Irreplaceable — losing it means every connected Instagram account must reconnect. |

Also invent the webhook verify token for later (Meta setup), or generate it
now and save it: `openssl rand -hex 16` → `WEBHOOK_VERIFY_TOKEN`. It stays
unset until Meta setup — save it, do not set it yet.

**Done when:** all three secrets are in your password manager, and you have
not pasted any of them into a chat or a shared document.

---

## Step 5: Vercel — deploy the web app

1. Go to Vercel (vercel.com — (verify: confirm the signup URL from
   Vercel's own site)) and create an account.
2. Add a new project and import this repo from GitHub. Vercel auto-detects
   Next.js. (verify: the exact import flow and whether a card is requested
   on Hobby signup.)
3. Before deploying, open the project's **Settings → Environment
   Variables** and add these (paste each value exactly — no extra spaces,
   no quotes around them):

   | Variable | Value |
   | --- | --- |
   | `NEXTAUTH_URL` | Your Vercel domain, e.g. `https://your-app.vercel.app` — **but you do not know it yet.** Deploy once first (Step 5.5), copy the domain Vercel assigns, then come back and set this. Until then, use a placeholder you will replace. (verify: whether Vercel lets you set env vars before the first deploy and edit them after; the value must be the final domain, no trailing slash.) |
   | `NEXTAUTH_SECRET` | From Step 4. |
   | `CRON_SECRET` | From Step 4. |
   | `DATABASE_URL` | From Step 1 (Neon). |
   | `REDIS_URL` | From Step 2 (Upstash, `rediss://`). |
   | `ENCRYPTION_KEY` | From Step 4. Exactly 64 hex characters. |
   | `RESEND_API_KEY` | From Step 3. (Skip if you are using `EMAIL_SERVER` instead.) |
   | `EMAIL_FROM` | From Step 3. |
   | `ALLOWED_EMAILS` | Your own email address, e.g. `you@example.com`. |
   | `EMAIL_SERVER` | Only if you use your own SMTP server instead of Resend. |

   Leave **unset** on Vercel for now: `DEMO_MODE` (must stay unset in
   production), `META_GRAPH_API_VERSION`, `INSTAGRAM_APP_ID`,
   `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`.
   Meta comes later.

4. **Run the migrations first (one-off, from your own machine).** The
   Vercel build does **not** run migrations — you run them yourself,
   before the first deploy and before any deploy that includes a schema
   change. From the repo directory on your own machine, with `DIRECT_URL`
   (the direct Neon string from Step 1) set in your shell:

   ```bash
   DIRECT_URL="postgresql://<user>:<password>@<host>.<region>.aws.neon.tech/<database>?sslmode=require" npm run db:migrate
   ```

   That runs `prisma migrate deploy` (26 migrations at the time of
   writing). Never run `prisma db push`, `prisma migrate reset`, or
   `npm run db:seed-demo` against production.
5. Deploy. The build runs the repo's `vercel-build` script —
   `prisma generate && next build` — which generates the Prisma client
   and builds the app. (verify: confirm in the Vercel dashboard that the
   build runs `vercel-build` rather than plain `next build`.)
6. When the deploy finishes, Vercel shows your public URL, e.g.
   `https://your-app.vercel.app`. Copy it. Go back to **Settings →
   Environment Variables**, set `NEXTAUTH_URL` to exactly that URL (no
   trailing slash), and redeploy so the app picks it up.
7. Check the build log if the deploy fails. The common causes are a bad
   `DATABASE_URL` (the app cannot reach Neon — check the connection
   string, that it is the pooled form, and that `?sslmode=require` is
   present) or a malformed `ENCRYPTION_KEY` (must be exactly 64 hex
   characters — the build log names the variable). If the app builds but
   `/api/health` reports a database error, the migrations in step 4 were
   not run or ran against the wrong database — re-run them with
   `DIRECT_URL`.

**Done when:** the Vercel deployment succeeds and you know your public URL.
The app will not be fully healthy yet — the worker is not running — so
`/api/health` will report the worker as unhealthy until Step 6 is done.
That is expected at this point.

---

## Step 6: Render — deploy the worker

The worker is a long-running process that consumes the queue and sends the
DMs. It cannot run on Vercel (serverless functions are short-lived; a queue
consumer has to stay up), so it runs on Render from the same repo.

1. Go to Render (render.com — (verify: confirm the signup URL from
   Render's own site)) and create an account. **Render has no free tier
   for background workers** — the worker needs a paid Starter instance,
   about $7/month (estimate — confirm in the Render dashboard), and a
   card. That is the stack's only unavoidable cost.
2. Create a new **Background Worker** (not a Web Service, not a Static
   Site) connected to this GitHub repo. (verify: the exact service type
   and creation flow in the Render dashboard.)
3. Set the commands (verify: the exact field names in the Render dashboard
   — the expected values are):
   - **Build command:** `npm install` plus `npm run db:generate` — the
     worker only needs the generated Prisma client, not `next build`. Do
     not set the build command to `npm run build`.
   - **Start command:** `npm run worker` (runs `tsx worker/dm-worker.ts`).
4. In the service's **Environment** settings, add these — the **same
   values** as on Vercel:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Same Neon string as Vercel (Step 1). |
   | `REDIS_URL` | Same Upstash `rediss://` string as Vercel (Step 2). |
   | `ENCRYPTION_KEY` | Same 64-hex value as Vercel (Step 4). |
   | `NEXTAUTH_URL` | Same Vercel domain as Vercel (Step 5). |
   | `NEXTAUTH_SECRET` | Same value as Vercel (Step 4). The worker reads it for shared validation; keep it identical. (verify: confirm the worker actually requires `NEXTAUTH_SECRET` — if a deploy works without it, it can be dropped from Render.) |

   Leave **unset** on Render: `DEMO_MODE` (the worker refuses to start
   while `DEMO_MODE=1`), `RESEND_API_KEY` / `EMAIL_FROM` (the worker does
   not send email), `CRON_SECRET` (the worker does not call the cron
   routes), and all Meta variables (unset until Meta setup).

   The tuning variables (`COMMENT_POLL_INTERVAL_MS`,
   `COMMENT_POLL_MAX_PER_SWEEP`, `COMMENT_POLL_LOOKBACK_HOURS`,
   `FOLLOW_RECHECK_DELAYS_MS`, `FOLLOW_RECHECK_ACK_MESSAGE`,
   `HEALTH_STUCK_QUEUE_WAITING`, `DB_POOL_MAX`) are all optional — leave
   them unset to use the defaults unless you have a reason to change them.
   See the env-var table in
   [production.md](production.md#4-environment-variable-reference).

5. Deploy the service. Watch the logs: you want to see
   `[DM Worker] Started`. If the logs say `DEMO_MODE=1 — worker will not
   start`, remove `DEMO_MODE` from the Render environment and redeploy. If
   the logs show a `DATABASE_URL` / `REDIS_URL` / `ENCRYPTION_KEY` error,
   re-paste the value from the source (Neon / Upstash / password manager) —
   character for character.

   > **Note:** the worker is always-on (paid Starter) — it does not
   > sleep, so there is no wake-up delay after quiet periods. If the
   > first DM after a gap is slow, the cause is usually Neon scaling to
   > zero (~500 ms cold start), not the worker.

**Done when:** the Render logs show `[DM Worker] Started`, and
`/api/health` (Step 7) reports `worker.healthy: true`.

---

## Step 7: First health check

1. In any browser (your phone works), open:

   ```
   https://your-app.vercel.app/api/health
   ```

   (Replace `your-app.vercel.app` with your real Vercel domain.)
2. You want `{"status":"ok", ...}` with every check `ok`:
   - `database` — the app can reach Neon.
   - `redis` — the app can reach Upstash.
   - `queue` — the send queue is not stuck.
   - `worker.healthy: true` — the Render worker has sent a recent
     heartbeat (every 30 seconds). Wait ~30 seconds after the worker
     starts and re-check if it still says false.
3. If anything says `error`, read its `detail` field, then work through
   [production.md](production.md#9-troubleshooting). The most common first
   -deploy causes are: a `REDIS_URL` that is `redis://` instead of
   `rediss://`; a `DATABASE_URL` pasted with a typo or the wrong
   pooled/direct form; or `ENCRYPTION_KEY` values that differ between
   Vercel and Render.

**Done when:** `/api/health` returns `status: ok`.

---

## Step 8: First magic-link login

1. Open your Vercel domain in a browser:
   `https://your-app.vercel.app`.
2. Request a magic link with the email address you put in
   `ALLOWED_EMAILS`.
3. Open the email and click the link. You should land on the dashboard,
   signed in.
4. If the email does not arrive, work through the checklist in
   [production.md](production.md#email-troubleshooting-magic-link-not-arriving):
   allowlist first, then Resend's email logs, then `RESEND_API_KEY` /
   `EMAIL_FROM`, then the domain situation, then spam.
5. Confirm the dashboard does **not** show a "Demo mode — simulated
   activity only" banner. If it does, `DEMO_MODE` is set somewhere it
   should not be — remove it from Vercel and Render and redeploy both.

**Done when:** you are signed in to your own dashboard, with no demo
banner.

---

## Step 9: Confirm the scheduled jobs

The three daily Vercel crons are defined in `vercel.json` and run
automatically once Vercel picks them up:

| Job | Schedule (UTC) |
| --- | --- |
| `refresh-tokens` | 05:00 daily |
| `attach-next-reel` | 06:00 daily |
| `snapshot-followers` | 07:00 daily |

1. In the Vercel dashboard, confirm the three crons exist for the project
   and each shows a next-run time. (verify: where Vercel Hobby shows cron
   status and history.)
2. Note the tradeoff: Vercel Hobby allows each cron at most once per day,
   so `attach-next-reel` runs daily here, not every 5 minutes as on the
   Docker stack. A new reel may wait up to a day to be picked up. That is
   a free-tier limit, not a bug.
3. After the first day, check that token expiry dates in Settings keep
   moving forward — that is the visible proof `refresh-tokens` is running.
   If tokens expire, automation silently stops days later; the cron log in
   Vercel is the place to look.

**Done when:** the three crons are listed in the Vercel dashboard.

---

## Step 10: What comes next — Meta

The stack is now deployed and healthy, but **Instagram is not connected**.
Do not tell anyone a DM will send until the end-to-end test passes.

When you are ready, follow [docs/meta-app.md](meta-app.md) — the full
Meta walkthrough. In short:

1. Create the Meta app, add the Instagram product, and collect
   `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, and `FACEBOOK_APP_SECRET`.
2. Set those three plus `WEBHOOK_VERIFY_TOKEN` in **Vercel's**
   environment variables (not Render's) and redeploy Vercel.
3. In Meta's console, register the OAuth redirect URL
   `https://your-app.vercel.app/api/instagram/callback` (no trailing slash)
   and the webhook callback `https://your-app.vercel.app/api/webhook`
   (verify token = your `WEBHOOK_VERIFY_TOKEN`), and subscribe to **both**
   the `comments` and `messages` fields.
4. Publish the Meta app (Live state) — in Development mode only Meta's
   console Test button delivers events.
5. Add your Instagram account as a tester and accept the invite inside
   Instagram, then connect it in OpenReply → Settings.
6. Test end to end: a keyword comment from a **different** Instagram
   account produces a DM and a `SENT` row in DM Logs.

Until that test passes, the honest status is "app deployed, Instagram not
connected yet."

---

## Quick reference: env vars per service

| Variable | Vercel (web) | Render (worker) |
| --- | --- | --- |
| `NEXTAUTH_URL` | ✅ your Vercel domain | ✅ same domain |
| `NEXTAUTH_SECRET` | ✅ | ✅ same value |
| `CRON_SECRET` | ✅ | — (worker does not call cron routes) |
| `DATABASE_URL` | ✅ Neon **pooled** string | ✅ same string |
| `DIRECT_URL` | — (migrations only, from your own machine) | — |
| `REDIS_URL` | ✅ Upstash `rediss://` | ✅ same string |
| `ENCRYPTION_KEY` | ✅ 64 hex | ✅ same value |
| `RESEND_API_KEY` | ✅ (unless `EMAIL_SERVER`) | — |
| `EMAIL_FROM` | ✅ | — |
| `EMAIL_SERVER` | ✅ only if using own SMTP | — |
| `ALLOWED_EMAILS` | ✅ your email(s) | — |
| `DEMO_MODE` | ❌ must stay unset | ❌ must stay unset |
| `WEBHOOK_VERIFY_TOKEN` | Later (Meta) | — |
| `META_GRAPH_API_VERSION` / `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` / `FACEBOOK_APP_SECRET` | Later (Meta) | — |

Full reference — what each variable does, what breaks without it, and the
tuning variables — is in
[production.md](production.md#4-environment-variable-reference).

---

## If something goes wrong

- **Deploy fails on Vercel:** read the build log. Bad `DATABASE_URL` or
  malformed `ENCRYPTION_KEY` are the usual causes (see Step 5.7).
- **Worker will not start on Render:** read the Render logs. `DEMO_MODE=1`
  is the usual cause (see Step 6.5).
- **`/api/health` is not `ok`:** see Step 7.3 and
  [production.md](production.md#9-troubleshooting).
- **Magic link never arrives:** see Step 8.4 and
  [production.md](production.md#email-troubleshooting-magic-link-not-arriving).
- **Anything else:** [production.md](production.md) (operations guide),
  [docs/setup.md](setup.md) (hosting sections there describe the abandoned
  Railway path — use this guide instead), and
  [docs/meta-app.md](meta-app.md) (Instagram, later).
