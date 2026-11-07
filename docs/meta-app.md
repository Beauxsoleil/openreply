# Connect Instagram with your own Meta app

This guide walks you through connecting Instagram to OpenReply with a Meta
developer app you own. It is the long way around: if you would rather skip
creating and reviewing a Meta app, use [Zernio](zernio.md) instead — an
optional paid provider that handles the Meta side for you. OpenReply stays
self-hosted either way.

> **Do you actually need this guide?** If OpenReply will only ever serve
> Instagram accounts you own (or a handful of accounts you can add as
> testers), you need Sections 1–6 and 9–10 only. **App Review (Sections 7–8)
> is only for letting strangers connect their accounts through your app.**
> Skip it otherwise — it is the slowest part of this whole process, and
> running your own instance for your own accounts never needs it.

> **Newer Meta apps only offer Unified Login.** If your app's Instagram
> product shows "API setup with Unified login" and there is no Instagram
> App ID anywhere, the Instagram Login flow in Sections 3–5 and 9.2 cannot
> work for it — skip to **Section 13**, which covers the Unified Login
> path (a system-user token pasted into Settings instead of an OAuth
> redirect).

> **Meta renames its menus often.** The button and menu names below matched
> Meta's console when this guide was written. If a screen looks different,
> follow the *intent* of the step (add the Instagram product, register a
> redirect URL, subscribe to a webhook field) rather than the exact label,
> and check the linked Meta documentation for the current layout.

Related docs: the hosting walkthrough in [setup.md](setup.md) (Steps 1–3 get
your instance deployed; the Meta app section there is the short version of
this guide), and the App Review drafts in
[../META_APP_REVIEW.md](../META_APP_REVIEW.md).

---

## 1. What you need before you start

- **A Facebook account.** You need one to register as a Meta developer.
  Use an account you actually check — Meta sends review results and
  security notices to its email.
- **An Instagram Business or Creator account.** A personal account cannot be
  connected: the Instagram API only works with professional accounts. Switch
  in the Instagram app under Settings → Account type, if needed. This is the
  account whose comments will trigger DMs.
- **A deployed, publicly reachable OpenReply instance over HTTPS.** Your
  Vercel domain (for example `https://your-app.vercel.app`) is what
  everything below points at. Have it ready before you start — you will
  paste it into Meta's console several times.
- **A running worker.** The web app receives webhooks; the worker sends the
  DMs. If the worker is not running, comments arrive and nothing is ever
  sent. Check `/api/health` on your instance: it should report
  `worker.healthy: true`.
- **Email sign-in working** on your instance (magic links), so you can sign
  in to test the connection. See [setup.md](setup.md).

### Meta requires public HTTPS — localhost will not work

Meta's servers have to reach your instance to deliver webhooks, and
Instagram's login has to redirect back to it. That means:

- **OAuth redirect URLs and webhook callback URLs must be public HTTPS.**
  `http://` URLs and `localhost` are not accepted for real Instagram
  traffic.
- A **Codespaces forwarded URL** (`https://<name>-3000.app.github.dev`) is
  temporary and will stop working when the codespace stops. It is fine for
  poking at the dashboard, not for a real connection.
- For **local development only**, use an HTTPS tunnel such as
  `ngrok http 3000` and set `NEXTAUTH_URL` to the tunnel URL — then update
  the redirect and webhook URLs in Meta's console to match it. See the
  local-development section of [setup.md](setup.md#local-development).
- If you later change your domain (for example, adding a custom domain),
  update `NEXTAUTH_URL` **and** both Meta URLs (Sections 5 and 6). A
  non-primary domain will 307-redirect webhook POSTs, and Meta does not
  reliably follow redirects — webhooks silently stop.

---

## 2. Create the Meta developer app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
   and sign in with your Facebook account. If you have never used it, Meta
   will ask you to register as a developer first — that is free.
2. Click **Create App**.
3. When it asks for a use case, choose **Other**, then **Business** as the
   app type.
4. Give the app a name (anything recognisable, for example `OpenReply` or
   `OpenReply — <your name>`), enter a contact email you actually check,
   and create the app.

> **Do not pick the Marketing API use case**, and do not pick
> "Authenticate with Facebook Login". OpenReply uses Instagram Login. The
> Facebook Login variant makes the OAuth flow fail later with a mismatched
> client error. If you accidentally added the Marketing API use case, remove
> it — it has its own heavy review requirements and can block publishing.

---

## 3. Add the Instagram product (Instagram Login)

Your new app does not have Instagram in it yet. Add it:

1. In your app's dashboard, find **Add Product** (in the left sidebar, or
   at the bottom of the dashboard) and click it.
2. Find **Instagram** in the product list and click **Set up**.
3. In the left sidebar, open the Instagram product and select **API setup
   with Instagram login**. (The exact label varies — it may read "API Setup
   with Instagram Login".)

> **If step 3 only offers "API setup with Unified login"**, your app is a
> newer one and Meta does not issue it an Instagram App ID at all. Do not
> try to force the Instagram Login flow — the authorize URL fails with
> "Invalid platform app". Use **Section 13** (Unified Login) instead of
> Sections 3–5 and 9.2. Sections 1, 6 (webhooks), 7 (publishing), 9.1
> (testers), and 10 still apply as written.

This is the step first-timers stall on: if you cannot find any Instagram
settings in the app, the product has not been added yet. Go back to **Add
Product**.

Do **not** choose "API Setup with Facebook Login" — that is a different
integration for Facebook Pages, not the Instagram Login flow OpenReply uses.
OpenReply needs no Facebook Page at all.

You should now see the Instagram product's pages, including **API setup
with Instagram login** (where the app ID, app secret, and redirect URLs
live) and the webhook configuration. The next sections use them.

---

## 4. Collect the app credentials

There are two app secrets and two app IDs, which is confusing. Here is what
maps to what:

| Environment variable | Where it lives in Meta's console |
| --- | --- |
| `INSTAGRAM_APP_ID` | Instagram product → **API setup with Instagram login**. A number like `2036...` |
| `INSTAGRAM_APP_SECRET` | Same page, click **Show** |
| `FACEBOOK_APP_SECRET` | **App settings → Basic** → App secret, click **Show** |

The Instagram app ID is **not** the same number as the Facebook App ID
shown on the Basic settings page. Use the one under the Instagram product.

Set all four of these in your deployment's environment variables (Vercel and
Railway, or your `.env` file for local work) — the exact names come from
`.env.example`:

```bash
INSTAGRAM_APP_ID=123456789012345
INSTAGRAM_APP_SECRET=your-instagram-app-secret
FACEBOOK_APP_SECRET=your-facebook-app-secret
WEBHOOK_VERIFY_TOKEN=replace-with-a-random-string
```

- `WEBHOOK_VERIFY_TOKEN` is not from Meta: pick any random string (for
  example, `openssl rand -hex 16`). You will paste the **same value** into
  Meta's webhook configuration in Section 6, and Meta uses it to prove the
  callback URL is yours.
- OpenReply verifies webhook signatures against **both**
  `FACEBOOK_APP_SECRET` and `INSTAGRAM_APP_SECRET`, so you do not have to
  guess which one Meta signs with. Set both.
- `META_GRAPH_API_VERSION` (for example `v25.0`) is also in `.env.example`;
  leave it at the default unless the setup guide says otherwise.
- Never commit these values. `.env` is gitignored for a reason. If a secret
  is ever pasted somewhere it could be logged — including a chat with an AI
  assistant — rotate it in Meta's console and update your deployment.

After setting them, redeploy (or restart) the web app so it picks the new
values up. If the Connect button later sends you to
`settings?instagram=misconfigured`, the app is telling you one of these is
missing — the `missing=` parameter names which.

---

## 5. Register the OAuth redirect URL

In the Instagram product, open **Set up Instagram business login**, then
**Business login settings**. In the **OAuth redirect URIs** field, add
exactly this, using your own public domain (no trailing slash):

```
https://your-app.vercel.app/api/instagram/callback
```

That path is the one OpenReply's code uses: the connect flow builds its
authorization URL with `redirect_uri` set to
`<NEXTAUTH_URL>/api/instagram/callback`, and the callback route at
`app/api/instagram/callback/route.ts` exchanges the code for a token. If
this URL is missing or wrong here, connecting an account fails with a
redirect URI mismatch.

Notes:

- You can register more than one URI, which is useful if you change domains
  later — keep the old and new both listed.
- You do **not** need the "Embed URL" that Meta shows on this page.
  OpenReply builds its own login URL. Users connect from inside OpenReply
  (Section 9), not from an embedded button.
- If you use a custom domain, update this URL to it, and update the webhook
  callback in Section 6 to match.

---

## 6. Configure the webhook

Still in the Instagram product, find the **Configure webhooks** step.

- **Callback URL:** `https://your-app.vercel.app/api/webhook`
- **Verify token:** the exact value of `WEBHOOK_VERIFY_TOKEN` from your
  environment (Section 4).
- Click **Verify and save**. It should succeed immediately, because
  OpenReply answers Meta's verification challenge (a `GET` to
  `/api/webhook` with `hub.mode=subscribe`, `hub.verify_token`, and
  `hub.challenge`). If the button is greyed out, click into the verify-token
  field and paste the token again — editing the callback URL often clears
  it.

Then subscribe to the webhook fields. OpenReply needs **both** of these:

| Field | What it carries |
| --- | --- |
| `comments` | New comments on the connected account's posts and reels. This is comment-to-DM — what most people come here for. |
| `messages` | Inbound DMs and Story replies, plus button taps on DMs OpenReply sent. This is what a campaign's "also reply when someone DMs these words" toggle runs on, and what follow-gate button taps arrive on. |

Subscribe to `comments` alone and that DM toggle looks enabled but never
fires, because the events it needs are never delivered. OpenReply also
subscribes the account itself to both fields when it connects
(`subscribed_fields: ["comments", "messages"]`), but the app-level
subscription here is what makes Meta deliver events to your callback URL in
the first place — do both.

### Test that delivery works

You can test delivery without a real comment: click **Test** next to
`comments`, then click **Send to My Server**. This is a two-step control —
clicking Test only previews the sample payload; the second button is what
actually POSTs it to your endpoint. After sending, a row should appear in
your `WebhookEvent` table (and a failed delivery, if any, shows up on the
Diagnostics page in OpenReply — see Section 10).

If your primary domain ever changes, update this callback URL to the new
domain. A non-primary domain will 307-redirect the POST, and Meta does not
reliably follow redirects, so webhooks silently stop.

---

## 7. Publish the app — and understand Standard vs Advanced Access

Real comment webhooks are only delivered when the app is in **Live** state.
In Development mode, only the console Test button delivers events. This is
the single most common reason for "I set everything up and nothing
happens."

### Publishing

1. In the left sidebar, go to **Publish**.
2. Set the **privacy policy, terms of service, and data deletion URLs**
   first, or Meta will not let you publish. OpenReply ships these pages on
   your own domain:
   ```
   https://your-app.vercel.app/privacy
   https://your-app.vercel.app/data-deletion
   https://your-app.vercel.app/terms
   ```
3. Publish the app.

Depending on your access level, Meta may let you go live for your own
tester accounts immediately, or it may require App Review first (Section 8).

### Publishing is not Advanced Access

This one costs an afternoon, because the symptom points nowhere near the
cause.

A published app still holds **Standard Access** to
`instagram_business_basic`, `instagram_business_manage_comments`, and
`instagram_business_manage_messages`. Standard Access only covers Instagram
accounts that have a role on your app — admins, developers, and Instagram
testers. Publishing makes the app live; it does not widen who the
permissions apply to. **Advanced Access, which covers everyone else, comes
only from App Review.**

So connecting a second account fails even though the first one works, on
the same app, with the same code.

The symptom: Instagram's consent screen appears and the login succeeds, the
code exchange returns a normal `IGAA…` token with all the requested
permissions — and then every single call against `graph.instagram.com` is
refused:

```
Unsupported request - method type: get  [code=100, type=IGApiException]
```

`/access_token`, `/refresh_access_token`, `/me` — all of them, identically.
Nothing about the message suggests a missing role, and the token itself
looks fine.

The fix for your own accounts is the tester invite in Section 9, once per
account. For accounts you do not control, you need App Review — Section 8.

---

## 8. App Review (only if strangers will connect)

You only need this section if people who are **not** testers on your app
will connect their own Instagram accounts — for example, you run OpenReply
for clients. If it is just your accounts, stop here: you are done with Meta
and can go to Section 9.

### 8.1 Where to request permissions

In your app's dashboard, go to **App Review → Permissions and Features**.
Search for each permission below and click **Request Advanced Access** on
its row. Requesting is per permission: each one gets its own justification,
screencast, and review decision.

> There is also a "Complete app review" entry point inside **Instagram →
> API setup with Instagram login** on some app configurations. It leads to
> the same submission flow — use whichever one your console shows.

### 8.2 Which permissions to request

Request **only** these three. Do not request extra permissions "just in
case" — each one is a separate review, and unrelated permissions are a
common rejection trigger.

| Permission | What OpenReply uses it for |
| --- | --- |
| `instagram_business_basic` | Identify the connected professional account after Instagram Login, so OpenReply can associate the account with the right workspace. |
| `instagram_business_manage_comments` | Receive comments through the `comments` webhook and, if the account owner enabled it, post a public reply under a matching comment — only on the connecting account's own media. |
| `instagram_business_manage_messages` | Send the one-time private reply after a keyword comment, and handle inbound DMs, Story replies, and DM button taps. |

Paste-ready justifications for each permission, plus the compliance
positioning (no scraping, no passwords, tokens encrypted at rest with
AES-256-GCM, per-account rate limiting, disconnect from Settings) are in
[../META_APP_REVIEW.md](../META_APP_REVIEW.md) — use them, adjusted to your
wording.

> **Note on a fourth scope:** OpenReply's OAuth flow also requests
> `instagram_business_manage_insights`, which powers follower-count
> snapshots and per-media insights in the dashboard
> (`lib/meta/oauth.ts`). It is not part of the core comment-to-DM flow, and
> it is not in the App Review drafts — if you want insights to work for
> non-tester accounts too, request Advanced Access for it as well, with a
> justification about showing the account owner their own follower and
> media insights. If you skip it, comment-to-DM still works; only the
> insights features fail for those accounts.

### 8.3 Business verification

Meta usually requires **business verification** before granting Advanced
Access. It asks for a document proving a legal business entity: a business
registration or license, articles of incorporation, a business tax
document, or a business bank statement. Start it from **App settings →
Basic → Verification** (or the prompt inside the App Review flow) — it can
take days, so start it before you submit the permission requests.

If you do not have a registered business, you cannot complete this step,
and the practical path is to run OpenReply for your own accounts instead,
which never needs review.

### 8.4 Before you submit: make every permission work for real

Meta expects each requested permission to have been used successfully —
make at least one real API call with each permission shortly before
submitting (connect a tester account, run the Section 10 end-to-end test,
and confirm the DM Logs show a SENT row). A permission with no recent
successful use is an easy rejection.

Also fill in **App settings → Basic** completely first: app icon, category,
contact email, privacy policy and terms URLs. Reviewers open that page
first, and an empty-looking app reads as unfinished.

### 8.5 The submission, step by step

1. Complete business verification (Section 8.3).
2. In **App Review → Permissions and Features**, click **Request Advanced
   Access** on `instagram_business_basic`. Fill in:
   - **How will your app use this permission?** — paste the justification
     from [../META_APP_REVIEW.md](../META_APP_REVIEW.md).
   - **Screencast** — upload the video from Section 8.6.
   - **Test instructions / demo access** — the reviewer login from
     Section 8.7.
3. Repeat for `instagram_business_manage_comments` and
   `instagram_business_manage_messages` (and `instagram_business_manage_insights`
   if you are requesting it). Each permission needs its own screencast
   showing *that* permission producing a real result.
4. Submit. Watch **App Review → Requests** for the decision, and the
   contact email on the app — Meta sends the result there. Expect days, not
   hours; budget for a resubmit.

### 8.6 Screencast script

Record on your published app, with real accounts, in **one take**, about
two to three minutes. Narrate each step as you do it:

1. Sign in to OpenReply with an email magic link.
2. Go to **Settings** and click **Connect using your own Meta app**. Show
   the Instagram consent screen with the permissions being granted.
3. Create a campaign on a recent post with keyword `LINK`, a DM message,
   and save.
4. On a second phone or account, comment `LINK` on that post.
5. Show the second account receiving the DM, and the public reply
   appearing under the comment (if you enabled one).
6. Back in OpenReply, show the **DM Logs** page with the SENT row.

Reviewers want to see the permission produce a real result for a real user.
This flow does that directly. Record a separate short screencast per
permission, each one showing that permission's part of the flow — do not
reuse one video for all three and hope the reviewer connects the dots.

### 8.7 Reviewer test users

A reviewer cannot test your app without a way in. Give them one, in the
submission's test instructions:

1. **An OpenReply login they can use.** Create a login for a throwaway
   email address on your instance (if `ALLOWED_EMAILS` is set, add that
   address to the allowlist first) and put the email in the submission.
   Magic-link sign-in means the reviewer needs access to that inbox — use
   an inbox you control and forward the link, or a shared test mailbox.
   Test the login yourself in an incognito window before submitting.
2. **A connected Instagram test account.** Connect one of your tester
   Instagram accounts (Section 9) to that OpenReply login, with a live
   campaign on a recent post, so the reviewer can comment the keyword and
   watch the DM arrive without setting anything up.
3. **Step-by-step instructions in the submission**, for example:
   > Sign in to https://your-app.vercel.app with the email above (magic
   > link sent to that inbox). Open Campaigns, find the "Reviewer test"
   > campaign on post <link>. From any Instagram account, comment LINK on
   > that post. The DM arrives on the commenting account, and the SENT row
   > appears under Logs → DM Logs.
4. **Meta test users (optional, for the Meta side).** Under **App roles →
   Test Users** you can create Facebook test users for the reviewer to use
   inside Meta's own console. These are for testing the app's Meta-side
   behaviour, not a substitute for the OpenReply login above.

Do not give the reviewer your personal Instagram or Facebook credentials,
and do not put any real secret (app secret, `ENCRYPTION_KEY`) in the
submission.

### 8.8 Rejection and resubmit playbook

Meta scrutinizes automated-DM apps and often rejects the first submission.
A rejection is not a ban — read the reason, fix exactly what it names, and
resubmit. Common rejections and fixes:

| Rejection reason | What it usually means | Fix |
| --- | --- | --- |
| Screencast does not show the permission in use | The video showed setup screens, or a different permission's flow | Re-record one take, per permission, showing the permission producing a visible result (comment → DM, public reply appearing). Narrate what is happening. |
| Could not access the app / demo login did not work | The reviewer could not sign in, or the magic link expired | Test the reviewer login in an incognito window first. Put working credentials and a working inbox in the test instructions. Keep the test campaign live until the review closes. |
| Use case unclear / permission not justified | The justification was generic ("we need it for our app") | Rewrite it around the specific user action: who comments, what keyword they chose, what DM they get, and why only this permission enables it. Use the drafts in [META_APP_REVIEW.md](../META_APP_REVIEW.md). |
| No recent successful API calls | The permission was never exercised, or not recently | Run the Section 10 end-to-end test on a tester account, confirm the SENT row in DM Logs, then resubmit promptly. |
| Business verification incomplete | The legal-entity document was missing, mismatched, or unreadable | Re-upload a clear document whose business name matches the app's business exactly. If you have no registered business, stop here — run OpenReply for your own accounts instead. |
| Requested unnecessary permissions | Extra permissions were requested that the screencast never shows | Drop the extra permissions and resubmit with only the three in Section 8.2. |
| App appears incomplete | Empty Basic settings, placeholder privacy policy, or a broken dashboard | Fill in App settings → Basic completely, make sure the privacy/terms/data-deletion URLs load, and confirm the dashboard works end to end before resubmitting. |

When you resubmit, say what changed since the last submission in the notes
— reviewers see the history, and a short "fixed X, re-recorded the
screencast to show Y" saves them guessing. Then wait: do not submit the
same request twice while one is pending.

---

## 9. Connect a professional account inside OpenReply

### 9.1 Add the account as a tester first (direct Meta only)

In Development mode — and for Standard Access even after publishing — only
accounts that have a role on your app can connect. Even your own account has
to be added, and it has to accept. Both halves are required; the second half
is the one people miss.

**Half one, on the Meta side.** In the app dashboard, open **App roles →
Roles** (in the newer console this is also reachable from the Instagram
product under "Generate access tokens"). Find the section for **Instagram
testers**, click add, and enter the exact Instagram username of the account
you want to connect. Send the invite.

**Half two, on the Instagram side.** Open Instagram as that account (the
phone app is easiest):

1. Go to your profile, then the menu, then **Settings and activity**.
2. Open **Apps and websites** (older versions: Website permissions, then
   Apps and websites).
3. Open **Tester invites**.
4. Accept the invite from your app.

Until you accept here, the account is not really a tester and the login
will keep failing with "Insufficient Developer Role". If you do not see the
invite, double-check you sent it to the exact username and that the account
is a Business or Creator account. Repeat this two-part dance once per
account — a second account fails even though the first one works if it was
never invited (Section 7).

### 9.2 The in-app connect flow

> **Unified Login apps:** if your app has no Instagram App ID, this
> OAuth flow cannot run — use the token-paste flow in **Section 13**
> instead of the steps below.

1. Sign in to OpenReply as a workspace owner or admin.
2. Go to **Settings**. Under the Instagram accounts section, click
   **Connect using your own Meta app**. (The Overview page has a Connect
   Instagram button that goes to the same place.)
3. Instagram's consent screen appears, listing the permissions OpenReply is
   requesting. Confirm the account shown is the professional account you
   intend to connect, and allow it.
4. You are redirected back to OpenReply. On success you land on the
   dashboard with a confirmation, and the account appears in Settings with
   its username, the token expiry date, and **Webhook ready** once OpenReply
   has subscribed it to the `comments` and `messages` fields. If the token
   refresh or webhook subscription had a problem, it shows **Webhook
   pending** instead — check the webhook configuration in Section 6.

What success looks like: the account is listed in Settings, and its posts
are available in the campaign post picker. What failure looks like:

- Redirected to Settings with `instagram=denied` — you declined on
  Instagram's consent screen. Try again and allow.
- `instagram=misconfigured` — an env var is missing on the server; the
  `missing=` parameter names it. Fix Section 4 and redeploy.
- `instagram=already_connected` — that Instagram account is already
  connected to a workspace (possibly another one). Disconnect it there
  first, or sign in to that workspace.
- `instagram=failed` with a `reason=` — the token exchange failed. The
  full message is also saved as an Operational Event (Diagnostics page).
  The usual causes are a redirect URI mismatch (Section 5) or an
  "Insufficient Developer Role" because the tester invite was never
  accepted (Section 9.1).
- `instagram=forbidden` — your OpenReply user is not an owner or admin of
  the workspace. Only owners and admins can connect accounts.

### 9.3 Moving from ManyChat or another DM tool

Do this whenever the Instagram account was ever connected to ManyChat or
another comment-to-DM tool, even if you have cancelled it. Skip it and
comments look fine, but every DM button tap fails.

The symptom: comments work. The public reply posts and the first DM
arrives. But when the commenter taps the DM button, nothing comes back, and
DM Logs shows the button tap as failed with:

```
The action is invalid since it's not the thread owner. [code=100 sub=2534037 type=IGApiException]
```

Instagram lets any connected app send the one private reply to a comment,
which is why the first DM gets through. Every message after that, including
the reply to a button tap, has to come from the app that owns the
conversation. If another tool is still connected to the Instagram account,
it can stay the owner even after you cancel or turn it off.

Fix it in Meta Business Suite, under **Settings → Integrations →
Conversation routing**:

1. Select the Instagram account and open the **Partner apps** tab. It lists
   every app connected to the account's messages. Remove any old DM tool
   from inside that tool — for example, ManyChat's Settings → Instagram →
   Disconnect channel. These apps often do not appear under Instagram's
   Apps and websites or Facebook's Business integrations, so Partner apps
   is the place to check.
2. Click **Manage** next to your OpenReply app and switch on both **Access
   all conversations** and **Take control of conversations**, then save.

Tap the button again on a fresh comment. The follow-up DM should now send.

---

## 10. Publish a test campaign and verify a real DM

### 10.1 Create the campaign

1. In OpenReply, go to **Campaigns → New campaign** (or open a template
   from the campaign list).
2. Give it a name, pick the **Instagram account** you just connected, and
   pick the **post or reel** the campaign watches ("When someone comments
   on…"). The post picker shows the account's recent posts.
3. Under "And this comment has…", enter your keyword — `TEST` is a good
   first one. Choose whole-word or partial matching (whole-word is the
   default; partial also matches inside longer words). You can add several
   keywords, or switch to "any word" to match every comment on the post.
4. Optionally turn on the **public reply** (a visible reply posted under
   the matching comment) and the **DM trigger** (the same keywords also fire
   when someone DMs the account — for example, replying to a Story). The DM
   trigger only works if you subscribed to the `messages` webhook field in
   Section 6.
5. Under "They will get…", write the **opening DM** and its button label.
   Optionally turn on the **follow gate**, which asks the commenter to
   follow before handing over the link. Use `{username}` in a message to
   greet the commenter by name.
6. Under "And then, they will get…", write the **DM with the link** and up
   to two tappable link buttons. Tracked links show clicks and CTR per
   campaign.
7. Save. New campaigns are active by default; on the Campaigns list each
   card has an **Active / Paused** toggle — make sure yours shows Active.
   A paused campaign matches nothing.

### 10.2 Run the end-to-end test

1. Confirm the account appears in OpenReply and `/api/health` reports
   `worker.healthy: true`. If the worker is not healthy, no DM will send
   even though webhooks are being received.
2. From a **different Instagram account**, comment `TEST` on the post you
   picked. It must be a different account — OpenReply ignores your own
   comments on purpose, because Meta rejects DMing yourself.
3. Watch for the DM on the commenting account. If you enabled a public
   reply, it should appear under the comment too.
4. Back in OpenReply, open **Logs → DM Logs** and confirm a **SENT** row
   for the comment. That is the done signal.

### 10.3 If nothing arrives — where it stopped

Work backwards through the pipeline. Each stage has a place to look:

| Check | Where | What it tells you |
| --- | --- | --- |
| Worker healthy? | `/api/health`, or Diagnostics → Worker health | `worker.healthy: false` means the worker is not running or cannot reach Redis. No DM will send. Start the worker (`npm run worker`) and check `REDIS_URL` and `DATABASE_URL`. |
| Did Meta deliver the comment? | Diagnostics → Webhook Failures; Postgres `WebhookEvent` table | No row at all means Meta never delivered: the app is still in Development mode (Section 7), the webhook is not subscribed to `comments` (Section 6), or the callback URL is wrong / redirecting. A row with a signature failure means `FACEBOOK_APP_SECRET` / `INSTAGRAM_APP_SECRET` is wrong for this app. |
| Did the campaign match? | DM Logs; Diagnostics → Campaign DM Failures And Skips | A skip row explains why: keyword did not match (check whole-word vs partial), campaign paused, or it was your own comment (ignored by design). |
| Did the send fail? | DM Logs (failed rows carry Meta's error); Diagnostics → Operational Event Timeline | Read Meta's error text. `code=100` with "not the thread owner" is the ManyChat trap (Section 9.3). `code=100` "Unsupported request" on every call is the Standard Access / missing-tester-role trap (Section 7). |
| Token expired? | Settings (token expiry date); Diagnostics → Token Refresh Failures | OpenReply refreshes tokens daily via cron. If refresh is failing, check the cron is running and the app secret is correct. |

If you want to inspect where a comment stopped, the Postgres tables tell
you: `WebhookEvent` for delivery, `DmLog` for send status and errors,
`OperationalEvent` for worker crashes and the polling reconciler's sweep
logs. The polling reconciler is a safety net, not the main path: the worker
sweeps for missed comments every few minutes, so a comment can still be
picked up late if a webhook was dropped — but do not rely on it to paper
over a broken webhook.

---

## 11. The Zernio alternative

If the Meta app, webhook, tester invites, and App Review in this guide feel
like too much, you do not have to do any of it. **Zernio** is an optional
paid connection provider (and a sponsor of OpenReply) that manages the
Instagram connection, platform credentials, API calls, and incoming events
for you. OpenReply stays self-hosted and still runs your campaigns,
keyword matching, queues, logs, link tracking, and inbox.

With Zernio you skip Sections 2–8 entirely: no Meta app, no app secrets,
no webhook configuration, no tester invites, no App Review. You save a
Zernio API key in OpenReply's Settings, select a profile, and import the
Instagram account. The full walkthrough is in [docs/zernio.md](zernio.md) —
including its feature limits (the post picker shows the latest 25 posts,
follower snapshots can be up to 24 hours old, post reporting needs
Zernio's analytics add-on).

Both paths use the official Instagram API and are subject to Instagram's
policies, account requirements, permissions, rate limits, and messaging
windows. Zernio accounts and direct-Meta accounts can live side by side in
one workspace, but an account is never migrated between providers
automatically.

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Insufficient Developer Role" on the Instagram login screen | The account was never added as an Instagram tester, or never accepted the invite | Section 9.1: invite the exact username under App roles → Roles → Instagram testers, then accept in Instagram → Settings → Apps and websites → Tester invites. |
| A personal Instagram account will not connect | The Instagram API only supports Business and Creator accounts | Switch the account to Business or Creator in Instagram → Settings → Account type, then try again. |
| Redirect URI mismatch when connecting | The redirect URL registered in Meta does not exactly match what OpenReply sends | Section 5: register `https://your-domain/api/instagram/callback` exactly, no trailing slash, on the Instagram product's Business login settings. Check `NEXTAUTH_URL` matches the same domain. |
| Webhook "Verify and save" fails, or the button is greyed out | Verify token mismatch, or the token field was cleared when the callback URL was edited | Section 6: paste `WEBHOOK_VERIFY_TOKEN` again and click Verify. Confirm the value matches your deployment's env exactly, and that the callback URL is public HTTPS with no redirect. |
| Webhook verified, but no comment ever arrives | App is in Development mode, or not subscribed to `comments` | Section 7: publish the app (Live state). Section 6: subscribe to `comments` (and `messages`). Use the console Test → Send to My Server to confirm delivery reaches your `WebhookEvent` table. |
| Comment arrives, no DM, worker healthy | Campaign paused, keyword did not match, or it was your own comment | Section 10.3: check DM Logs for the skip reason. Confirm the campaign is Active, the keyword matches under the chosen whole-word/partial mode, and the comment came from a different account. |
| Comment arrives, no DM, `worker.healthy: false` | Worker not running or cannot reach Redis/Postgres | Start `npm run worker`. Check `/api/health`, and that web and worker share the same `DATABASE_URL`, `REDIS_URL`, and `ENCRYPTION_KEY`. |
| Every `graph.instagram.com` call fails with `code=100` "Unsupported request", token looks fine | Standard Access + the account has no role on the app | Section 7: add the account as an Instagram tester and have it accept (Section 9.1). For accounts you do not control, you need App Review (Section 8). |
| DM button tap fails: "not the thread owner" `code=100 sub=2534037` | Another DM tool still owns the conversation | Section 9.3: remove the old tool in Business Suite → Settings → Integrations → Conversation routing → Partner apps, then enable **Access all conversations** and **Take control of conversations** for OpenReply. |
| DM toggle ("also reply when someone DMs these words") never fires | Subscribed to `comments` only | Section 6: subscribe to the `messages` webhook field as well. |
| Connect button does nothing / `instagram=misconfigured` | A Meta env var is missing on the server | Section 4: set `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, and `WEBHOOK_VERIFY_TOKEN`, then redeploy/restart. The `missing=` parameter names the missing one. |
| "App is still in Development mode" / strangers cannot connect | App not published, or no Advanced Access | Publish the app (Section 7) for your own tester accounts. Strangers need App Review granting Advanced Access (Section 8) — publishing alone does not widen who the permissions apply to. |
| "Invalid Request: Request parameters are invalid: Invalid platform app" when connecting | The app has no Instagram App ID — it is a newer app that only offers Unified Login, and the Instagram Login authorize URL cannot work for it | Section 13: use the Unified Login path (configuration + system-user token pasted into Settings). Do not try to fix the authorize URL. |
| Public reply posts but the DM never arrives, or vice versa | The two sends fail independently | Check DM Logs: public replies and private DMs track their outcomes separately. Fix the failing one from its error text; the other working does not prove the webhook or token is fine. |

Still stuck? Open an issue with the symptom, the exact error text from DM
Logs or Diagnostics, and which row of this table you already tried — that is
where everyone loses time, and a documented quirk is worth as much as a code
fix.

## 13. Unified Login (newer Meta apps)

Meta stopped issuing Instagram App IDs to newer apps. If your app's
Instagram product only offers **"API setup with Unified login"** and there
is no Instagram App ID anywhere in the console (not under the Instagram
product, not on App Settings → Basic), the Instagram Login flow in
Sections 3–5 and 9.2 cannot work for it: the authorize URL fails with
"Invalid platform app", because there is no Instagram app to authorize
against. Use this section instead. Everything else in this guide still
applies: the webhook in Section 6, publishing in Section 7, testers in
Section 9.1, and the campaign test in Section 10.

How it differs, in one paragraph: instead of an OAuth redirect that
exchanges a code for a 60-day user token, Meta's Unified Login
configuration issues a **system-user access token** for the Instagram
account — it never expires, so OpenReply never refreshes it. You paste
that token into Settings, OpenReply verifies it against
`graph.facebook.com`, and all API calls for that account go to
`graph.facebook.com` instead of `graph.instagram.com`. OpenReply never
publishes media, so the configuration's publishing permission is not
needed.

### 13.1 Create the Unified Login configuration

1. In your app's dashboard, open the Instagram product (Use Cases →
   Customize) and find **API setup with Unified login**.
2. Under **1. Configure your app**, click **Create new configuration**.
   Meta creates a Facebook Login for Business configuration named
   "Instagram API (Unified Login)". This is the fixed template — you
   cannot change its name or type, but you **can** edit its permissions
   afterwards (next step).
3. The configuration needs a business portfolio. Pick one of your existing
   portfolios, or create a new one. A portfolio does not have to be
   verified to connect your own accounts; verification is only required
   before App Review (Section 8).

### 13.2 Fix the configuration's permissions

The template ships with permissions OpenReply does not need, and misses
one it does use. After creating the configuration, open it and edit the
permissions to this final set:

| Permission | Why |
| --- | --- |
| `instagram_basic` | Read the account profile and media (locked — cannot be removed) |
| `instagram_manage_messages` | Send and read DMs (locked — cannot be removed) |
| `instagram_manage_comments` | Read comments and post public replies |
| `instagram_manage_insights` | Follower counts and per-media insights for the dashboard |

Remove `ads_management` and `ads_read` (they come with the template;
OpenReply runs no ads). Do **not** add `instagram_content_publish` —
OpenReply never publishes media, so it is not requested. If
`instagram_manage_insights` is missing, the dashboard still works:
insights show as unavailable instead of breaking the page.

### 13.3 Generate the token

Under **2. Generate access tokens** on the same page, find your Instagram
account and click **Generate token**. This issues the system-user token
for that account. Copy it immediately — Meta shows it once.

Treat it like a password: it never expires, so anyone holding it can act
as the account until it is revoked in Meta's console. Never paste it into
a chat, a screenshot, or a support ticket. OpenReply stores it encrypted
and never shows it back.

### 13.4 Paste the token into OpenReply

1. Sign in to OpenReply as a workspace owner or admin.
2. Go to **Settings**. Under the Instagram accounts section, find
   **Connect with Unified Login**.
3. Paste the token into the **System-user token** field and click
   **Connect account**. The field clears as soon as you submit — the
   token is write-only and is never displayed again.

Before anything is stored, OpenReply verifies the token on
`graph.facebook.com`: it lists the Instagram accounts the token covers,
resolves the account (username, account type), and rejects personal
accounts with the same rule as the Instagram Login callback — switch the
account to Business or Creator first, then reconnect. It also subscribes
the account to the `comments` and `messages` webhooks. On success the
account appears in Settings marked **Connected via Unified Login** with
**Token never expires**.

If the token covers more than one Instagram account, the form asks you to
pick one from a dropdown and submit again — one token can cover several
accounts, but OpenReply connects them one at a time.

### 13.5 Switch on webhook delivery for the account

On the same Unified Login page, under **2. Generate access tokens**, turn
on the **Webhook Subscription** switch for the account. This is the
Meta-side half of webhook delivery; OpenReply's `subscribed_apps` call
during connect is the other half. If comments arrive in Meta's console
test send but never reach OpenReply, check this switch first.

### 13.6 What changes inside OpenReply

- Accounts connected this way are marked `isUnifiedLogin` and call
  `graph.facebook.com`; Instagram Login accounts keep calling
  `graph.instagram.com`. The two paths coexist — a workspace can hold one
  of each.
- The stored token has no expiry date, and the daily token-refresh job
  skips it. If the token is ever revoked in Meta, reconnect with a fresh
  one from Section 13.3.
- The Instagram account ID stored for the account is the professional
  account ID (the number Meta's dashboard shows for the account, and the
  value webhooks carry as `entry.id`). The Instagram internal ID
  (`user_igid`) is a different number and is never used.
- Webhook signature verification is unchanged: OpenReply still verifies
  against `FACEBOOK_APP_SECRET` (and `INSTAGRAM_APP_SECRET` if set).
- The tester rule still applies: in Development mode, and for Standard
  Access after publishing, only accounts with a role on the app can
  connect (Section 9.1). A system-user token does not bypass it.

### 13.7 If it fails

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Meta rejected the token" in Settings | Token was generated for a different app, revoked, or copied with a typo | Generate a fresh token from Section 13.3 for this app and paste it again. Check for a leading/trailing space. |
| "This Instagram account is a personal account" | The account is still personal | Switch it to Business or Creator in Instagram → Settings → Account type, then reconnect. |
| "This token is not linked to any Instagram account" | The token was generated before the account was shared with the configuration's business portfolio | In Meta Business Suite, share the Instagram account with the portfolio, then generate a fresh token. |
| Token accepted, but no comment ever arrives | Webhook Subscription switch off, or webhook fields unsubscribed | Section 13.5, then Section 6: subscribe to `comments` and `messages`. Use the console Test → Send to My Server to confirm delivery. |
| "Invalid platform app" | You are on the Instagram Login authorize flow, which this app cannot use | You are in the wrong section: connect with the token-paste flow in Section 13.4, not the "Connect using your own Meta app" button. |
