# Demo mode

OpenReply has a credential-free local demo mode: you can run the whole
comment → keyword match → DM loop against fake data, with no Instagram
account, no Meta app, and no real messages ever sent.

## The guarantee

**Demo mode never sends a real Instagram message.** That is enforced in
depth, not just by the UI:

1. The simulate endpoint (`POST /api/demo/simulate-comment`) only renders
   the DM text that *would* be sent and writes a simulated log row. It does
   not enqueue anything to BullMQ and never calls any Meta client.
2. The DM send path refuses demo accounts: `assertNotDemoSend` in
   `lib/demo.ts` is called by the worker (`lib/queue/dm-worker.ts`) for
   every comment, postback, message, and follow-up job, and by the inbox
   manual-send route. A refused send logs
   `Refused to send real DM for demo account` and is recorded as a failed
   log row so it is visible instead of silent.
3. The send functions in `lib/instagram/send-messages.ts` refuse a context
   built from the demo placeholder token.
4. The real worker refuses to start at all while `DEMO_MODE=1`
   (`worker/dm-worker.ts` exits with a clear message).
5. Demo fixtures carry no usable credential: the demo Instagram account's
   access token is the literal placeholder `DEMO_NO_REAL_TOKEN`, and the
   account row is flagged `isDemo` in the database.

Simulated rows are marked `isDemo` on the `DmLog` model and shown with a
**Demo** badge in DM Logs, so demo activity can never be mistaken for real
activity.

## Enable it

```bash
# in .env (see .env.example)
DEMO_MODE=1
```

Then start the app as usual (`npm run dev`). Do **not** start the worker
in demo mode — it refuses to run (see above). No Redis, Meta app, or
Instagram account is needed for the demo loop itself; Postgres is still
required (the demo data lives there).

## Seed the demo data

```bash
npm run db:seed-demo
```

This creates (idempotently — safe to run twice):

- a demo user, `demo@example.test`
- a workspace, "Demo workspace"
- a demo Instagram account, @demo-brand, flagged `isDemo` with no real token
- three sample campaigns, all set to match any post:
  - **Free Guide** — keyword `guide`
  - **Pricing info** — keywords `price`, `pricing`, `cost`
  - **Free checklist** — keyword `checklist`

It only ever creates/updates those demo rows; it never touches any other
data.

## Sign in

Sign in as `demo@example.test` with a magic link, exactly like any other
account. That still needs a working email provider (Resend by default, or
your own SMTP server via `EMAIL_SERVER` — see `docs/setup.md`). If you use
`ALLOWED_EMAILS`, include `demo@example.test` in the list.

While demo mode is on, every dashboard page shows a permanent,
non-dismissible banner: "Demo mode — simulated activity only, no real
Instagram messages are sent."

## Create or edit a campaign

Campaigns work as normal in demo mode: create or edit one from
**Campaigns**, pick the @demo-brand account, add keywords and a DM
template. The builder requires an account to be selected, and the seeded
demo account is there for exactly that.

## Simulate a comment

1. Open a campaign (e.g. **Free Guide**).
2. Find the **Simulate a comment** panel (visible only in demo mode).
3. Enter a username and a comment, e.g. username `demo-fan`, comment
   `please send me the guide!`, and click **Simulate**.

The panel shows the matched keyword and the exact DM text that *would* be
sent — or a no-match result. A comment with no matching keyword
(e.g. `nice photo!`) is still logged as a simulated no-match.

You can also call the endpoint directly:

```bash
curl -X POST http://localhost:3000/api/demo/simulate-comment \
  -H "Content-Type: application/json" \
  -H "Cookie: <your session cookie>" \
  -d '{"campaignId": "<id>", "commentText": "please send me the guide!", "username": "demo-fan"}'
```

Outside demo mode the endpoint returns 404, and it requires a signed-in
session in demo mode.

## Watch the simulated logs and analytics

- **DM Logs** (`/logs`): simulated rows carry a **Demo** badge and a
  `SENT` status with a `dmSentAt` timestamp — exactly as a real delivery
  would, except nothing left the server.
- **Dashboard** (`/dashboard`): DMs Sent and the 7-day chart count the
  simulated rows, so the analytics render meaningfully once you have
  simulated a few comments.
- **Campaign detail → Insights**: per-campaign send counts include
  simulations.

To reset the demo, re-run `npm run db:seed-demo` (it restores the fixtures
without duplicating them) and delete simulated log rows if you want a clean
slate — they are the `DmLog` rows with `isDemo = true`.

## Going from demo to real

1. Remove `DEMO_MODE=1` from `.env` (or set it to `0`) and restart.
2. Connect a real Instagram account from **Settings**.
3. Create real campaigns against that account.

The demo fixtures stay in the database but are inert: the demo account
cannot send (its token is a placeholder), and the worker refuses demo
accounts even outside demo mode.
