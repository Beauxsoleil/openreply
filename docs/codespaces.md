# OpenReply on GitHub Codespaces

This guide is for **development only**, not permanent Instagram webhook hosting.

1. Open your fork on GitHub, choose **Code > Codespaces > Create codespace on main**.
2. Codespaces runs `scripts/codespaces-setup.sh`, installing dependencies, creating local secrets, starting PostgreSQL/Redis/Mailpit, and applying Prisma migrations.
3. In terminal one run `npm run dev`.
4. In terminal two run `npm run worker`.
5. Open forwarded port **3000** for the dashboard and **8025** for the Mailpit inbox.
6. Sign in with `developer@example.test` and click the magic link shown in Mailpit.

### Check the app

Run `npm test`, `npm run typecheck`, and `curl http://localhost:3000/api/health` after starting both processes. Report any failures before production deployment.

### Important limits

- This setup captures login email locally; it does not send email to real addresses.
- No Meta account is connected by default. Do not assume the dashboard can send real Instagram DMs.
- A forwarded Codespaces URL is temporary and should not be registered as a production webhook.
- Never commit `.env` or real Meta secrets.
- For real Instagram traffic, follow [setup.md](setup.md) to deploy HTTPS web hosting and an always-on worker, then configure Meta OAuth, webhook subscriptions, account roles, required permissions and App Review.
- Keep the upstream MIT license and original copyright notices.
