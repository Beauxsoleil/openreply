# OpenReply on GitHub Codespaces

This guide is for **development only**, not permanent Instagram webhook hosting.

1. Open your fork on GitHub, choose **Code > Codespaces > Create codespace on main**.
2. Codespaces runs `scripts/codespaces-setup.sh`, installing dependencies, creating local secrets, starting PostgreSQL/Redis/Mailpit, and applying Prisma migrations.
3. In terminal one run `npm run dev`.
4. In terminal two run `npm run worker`. **The worker must keep running:** the web app receives webhooks, the worker is what sends the DMs. If the worker stops, comments are logged but no DMs go out, and the health endpoint reports `worker: unhealthy`.
5. Open forwarded port **3000** for the dashboard and **8025** for the Mailpit inbox.
6. Sign in with `developer@example.test` and click the magic link shown in Mailpit.

> **Magic link points at the wrong host?** The setup script sets `NEXTAUTH_URL` from `CODESPACE_NAME` and `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN` when both are set, so the emailed link uses the forwarded `https://<codespace>-3000.<domain>` URL. If you open the dashboard through plain `localhost:3000` port-forwarding instead, set `NEXTAUTH_URL=http://localhost:3000` in `.env` and restart the dev server.

### Check the app

Run `npm test`, `npm run typecheck`, and `curl http://localhost:3000/api/health` after starting both processes. Report any failures before production deployment.

### Troubleshooting

- **Setup script failed on `docker compose up`:** the Docker daemon can still be starting when the setup runs. Wait a minute and re-run `bash scripts/codespaces-setup.sh` — it is idempotent and will not overwrite your `.env` secrets.
- **Setup script failed on `prisma generate`:** the Prisma engine download is retried 3 times. If it still fails, check network access to `binaries.prisma.sh` and re-run the script.
- **Magic link email never arrives:** check that `EMAIL_SERVER=smtp://localhost:1025` is in `.env` (the script sets it on every run). If you edited `.env` by hand and left the Resend placeholder, sign-in cannot work locally. Then open port **8025** (Mailpit) and look for the message.
- **Sign-in says the email is not allowed:** `ALLOWED_EMAILS` must contain the address you sign in with. The script sets it to `developer@example.test` on every run.
- **Worker logs `DATABASE_URL environment variable is required`:** the worker loads `.env` itself (via `dotenv`), so this means `.env` is missing or `DATABASE_URL` is unset. Re-run the setup script; it recreates `.env` from `.env.example` if absent.
- **Health endpoint reports `worker: unhealthy`:** the worker process is not running or its heartbeat expired. Start it with `npm run worker` in a second terminal and wait ~10 seconds.

### Important limits

- This setup captures login email locally; it does not send email to real addresses.
- No Meta account is connected by default. Do not assume the dashboard can send real Instagram DMs.
- A forwarded Codespaces URL is temporary and should not be registered as a production webhook.
- Never commit `.env` or real Meta secrets.
- For real Instagram traffic, follow [setup.md](setup.md) to deploy HTTPS web hosting and an always-on worker, then configure Meta OAuth, webhook subscriptions, account roles, required permissions and App Review.
- Keep the upstream MIT license and original copyright notices.
