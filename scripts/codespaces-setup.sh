#!/usr/bin/env bash
# OpenReply Codespaces setup. Idempotent: safe to re-run after a rebuild or
# when .env already exists. Only fills in values that are missing or still
# placeholders, so a deployer's own edits are never clobbered.
set -euo pipefail

# Prisma 7 / Next.js 16 need Node 20.19+ / 22.12+ / 24+. Fail fast with a
# clear message instead of a cryptic build error halfway through.
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
const ok = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19) || major >= 24;
if (!ok) { console.error("Node " + process.versions.node + " is too old for this repo (need 20.19+, 22.12+, or 24+)."); process.exit(1); }
'

npm ci

# --- .env ---------------------------------------------------------------
# Create it from the example on first run, then top up the local-dev keys on
# every run (append-if-missing, never overwrite a real value).
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi

node - <<'NODE'
const fs = require('fs'), crypto = require('crypto');
const path = '.env';
let lines = fs.readFileSync(path, 'utf8').split('\n');
const values = {};
for (const line of lines) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) values[m[1]] = m[2];
}
const isPlaceholder = (k, v) =>
  v === undefined || v === '' || /replace-with-|your-|re_\.\.\.|0123456789abcdef/i.test(v);
function setKey(key, value) {
  const idx = lines.findIndex((l) => l.startsWith(key + '='));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
}
function ensureSecret(key, bytes = 32) {
  if (isPlaceholder(key, values[key])) setKey(key, crypto.randomBytes(bytes).toString('hex'));
}
ensureSecret('NEXTAUTH_SECRET');
ensureSecret('CRON_SECRET');
ensureSecret('ENCRYPTION_KEY');
ensureSecret('WEBHOOK_VERIFY_TOKEN', 24);
// Local mail capture (Mailpit). Always present so a re-run never leaves the
// Resend placeholder behind, which would break magic-link sign-in.
setKey('EMAIL_SERVER', 'smtp://localhost:1025');
setKey('EMAIL_FROM', 'OpenReply <login@example.test>');
setKey('ALLOWED_EMAILS', 'developer@example.test');
if (values['RESEND_API_KEY'] && !/^#/.test(lines.find((l) => l.startsWith('RESEND_API_KEY')) || '')) {
  const idx = lines.findIndex((l) => l.startsWith('RESEND_API_KEY='));
  if (idx >= 0) lines[idx] = '# RESEND_API_KEY is not needed for local Mailpit';
}
// NEXTAUTH_URL: prefer the forwarded Codespaces domain when available so the
// emailed magic link points at the URL the user actually opened; fall back to
// localhost forwarding (VS Code maps localhost:3000 back into the codespace).
if (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
  setKey('NEXTAUTH_URL', `https://${process.env.CODESPACE_NAME}-3000.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`);
} else if (isPlaceholder('NEXTAUTH_URL', values['NEXTAUTH_URL'])) {
  setKey('NEXTAUTH_URL', 'http://localhost:3000');
}
fs.writeFileSync(path, lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n$/, '') + '\n');
NODE
chmod 600 .env

# --- Services -----------------------------------------------------------
# docker-in-docker can still be starting when postCreateCommand runs; wait
# for the daemon instead of failing under `set -e` with no hint.
for i in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 30 ]; then
    echo 'Docker daemon did not become ready. Re-run: bash scripts/codespaces-setup.sh'
    exit 1
  fi
  sleep 2
done

docker compose -f docker-compose.yml -f docker-compose.codespaces.yml up -d --wait

# Prisma engine download (binaries.prisma.sh) is a plain HTTPS fetch and can
# fail transiently; retry before giving up. (Behind a proxy that resets Node
# TLS connections this can fail repeatedly; Codespaces has direct internet
# and is not affected. PRISMA_ENGINES_MIRROR can point at a local mirror.)
for i in 1 2 3; do
  if npm run db:generate; then break; fi
  if [ "$i" -eq 3 ]; then
    echo 'Prisma generate failed 3 times. Check network access to binaries.prisma.sh and re-run this script.'
    exit 1
  fi
  sleep 5
done
npm run db:migrate

echo 'Setup ready. Run npm run dev in one terminal and npm run worker in another.'
echo 'The worker must keep running: the web app receives webhooks, the worker is what sends the DMs.'
echo 'Sign in as developer@example.test; open port 8025 for the email link.'
