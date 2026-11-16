# Fuel & Lift

Personal calorie + workout tracker with AI quick-logging. Runs on Cloudflare Workers + D1.

- `public/` – the app (single page, add to iPhone home screen)
- `src/worker.js` – API: login, meals, plan/exercises, check-offs, lifts, AI parse + weekly recap
- `migrations/` – D1 schema (already applied to the `fuel-lift` database)

## Accounts (Clerk)
Users sign up / sign in with Clerk (email + Google). The Worker verifies each request's Clerk session
token with Clerk's public key (`CLERK_JWT_KEY` in wrangler.jsonc vars) and scopes every query to that user ID.
- `OWNER_USER_ID` (vars): Ethan's Clerk user ID. Pre-accounts data is attached to this user on first login; exempt from the AI cap.
- `AI_DAILY_LIMIT` (vars): AI quick-logs/check-ins per user per day (default 30).

## Secrets (Cloudflare → Worker → Settings → Variables and Secrets)
- `ANTHROPIC_API_KEY` – from console.anthropic.com (set a monthly spend limit there)

## Security tests
Local: generate an RSA keypair into `test-keys/` (priv.pem, pub.pem, evil.pem), put pub.pem in `.dev.vars`
as CLERK_JWT_KEY with OWNER_USER_ID=user_ethan and AI_DAILY_LIMIT=2, run `npx wrangler dev --port 8788`, then
`node tests/security.test.mjs`.

## Deploy
Connected to Cloudflare Workers Builds: every push to `main` deploys automatically.
Manual: `npm i && npx wrangler deploy`

## Local dev
Create `.dev.vars` with the two secrets, then:
`npx wrangler d1 migrations apply DB --local && npx wrangler dev`
