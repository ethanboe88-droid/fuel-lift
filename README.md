# Fuel & Lift

Personal calorie + workout tracker with AI quick-logging. Runs on Cloudflare Workers + D1.

- `public/` – the app (single page, add to iPhone home screen)
- `src/worker.js` – API: login, meals, plan/exercises, check-offs, lifts, AI parse + weekly recap
- `migrations/` – D1 schema (already applied to the `fuel-lift` database)

## Secrets (Cloudflare → Worker → Settings → Variables and Secrets)
- `APP_PASSWORD` – password to log in
- `ANTHROPIC_API_KEY` – from console.anthropic.com (set a monthly spend limit there)

## Deploy
Connected to Cloudflare Workers Builds: every push to `main` deploys automatically.
Manual: `npm i && npx wrangler deploy`

## Local dev
Create `.dev.vars` with the two secrets, then:
`npx wrangler d1 migrations apply DB --local && npx wrangler dev`
