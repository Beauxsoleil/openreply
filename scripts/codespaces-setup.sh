#!/usr/bin/env bash
set -euo pipefail
npm ci
if [ ! -f .env ]; then
  cp .env.example .env
  node - <<'NODE'
const fs=require('fs'),crypto=require('crypto');
let s=fs.readFileSync('.env','utf8');
const replacements={
 NEXTAUTH_SECRET:crypto.randomBytes(32).toString('hex'),
 CRON_SECRET:crypto.randomBytes(32).toString('hex'),
 ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),
 WEBHOOK_VERIFY_TOKEN:crypto.randomBytes(24).toString('hex')
};
for(const [k,v] of Object.entries(replacements))s=s.replace(new RegExp('^'+k+'=.*$','m'),k+'='+v);
s=s.replace(/^RESEND_API_KEY=.*$/m,'# RESEND_API_KEY is not needed for local Mailpit');
s=s.replace(/^EMAIL_FROM=.*$/m,'EMAIL_FROM=OpenReply <login@example.test>');
s += '\nEMAIL_SERVER=smtp://localhost:1025\nALLOWED_EMAILS=developer@example.test\n';
fs.writeFileSync('.env',s,{mode:0o600});
NODE
fi
docker compose -f docker-compose.yml -f docker-compose.codespaces.yml up -d --wait
npm run db:generate
npm run db:migrate
echo 'Setup ready. Run npm run dev in one terminal and npm run worker in another.'
echo 'Sign in as developer@example.test; open port 8025 for the email link.'
