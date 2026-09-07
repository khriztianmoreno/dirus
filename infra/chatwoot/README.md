# Chatwoot (local dev)

Chatwoot is not part of this monorepo — it's a separate open-source app that owns the WhatsApp channel connection, contact records, and the human-agent inbox. DIRUS only talks to it over HTTP (see `docs/ARCHITECTURE.md` §4/§10): incoming webhooks land on `apps/api`'s `/webhooks/chatwoot` route, outgoing replies go through `packages/integrations/src/chatwoot.ts`'s REST client.

`docker-compose.yaml` here is Chatwoot's own official self-hosted compose file (`chatwoot/chatwoot`'s `docker-compose.production.yaml`), copied verbatim except for one change: `rails`'s host port is remapped from `3000` to `3001` because DIRUS's own `apps/api` already owns `localhost:3000` (see root `README.md`). Everything else — the four services, the images, the entrypoints — is untouched, per `docs/ARCHITECTURE.md` §10 ("Chatwoot lo exige: su Docker Compose oficial, intocado").

## Setup

1. Copy the env template and fill in the two values that must be real:

   ```bash
   cp env.example .env
   ```

   - `SECRET_KEY_BASE` — generate one: `openssl rand -hex 64`
   - `POSTGRES_PASSWORD` — any password; this Postgres is Chatwoot's own operational database (contacts, conversations, inbox state), separate from DIRUS's Neon database, and lives only in a local Docker volume.
   - `REDIS_PASSWORD` — optional locally; leave blank for dev.

   `env.example` here is a trimmed, essential-only subset (SMTP, storage, logging, the DB/Redis wiring). For the full reference of every variable Chatwoot supports (social channels, S3, APM, etc.), see [Chatwoot's own environment variables doc](https://www.chatwoot.com/docs/self-hosted/configuration/environment-variables/) or `docker-compose.production.yaml` on [chatwoot/chatwoot](https://github.com/chatwoot/chatwoot).

2. Start it:

   ```bash
   docker compose up -d
   ```

3. First run only — prepare the database (creates schema, seeds Chatwoot's own default data):

   ```bash
   docker compose run --rm rails bundle exec rails db:chatwoot_prepare
   ```

4. Open `http://localhost:3001`, create the first admin account (this is Chatwoot's own login, unrelated to DIRUS's broker-dashboard login), and create an account/inbox.

## Connecting it to DIRUS locally

Meta's WhatsApp Cloud API needs a public HTTPS URL to deliver webhooks to Chatwoot, and DIRUS's `apps/api` needs a public URL too if you want Chatwoot to reach it back — `docs/ARCHITECTURE.md` §10 calls for a `cloudflared` tunnel in dev for exactly this. Without a real WhatsApp Business number, you can still exercise the DIRUS side of the integration by sending a Chatwoot webhook payload directly at `apps/api`'s `/webhooks/chatwoot` route with `curl` (see `apps/api/src/routes/webhooks/chatwoot.ts` and its tests for the expected payload shape) — that's what `whatsapp-webhook-ingress`'s own test suite does, offline, without a running Chatwoot at all.

To wire a real Chatwoot instance in, fill `CHATWOOT_BASE_URL` (`http://localhost:3001` locally), `CHATWOOT_API_ACCESS_TOKEN` (Chatwoot → profile settings → access token), and `CHATWOOT_ACCOUNT_ID` in the root `.env`.

## Stopping / resetting

```bash
docker compose down          # stop, keep data (postgres_data/redis_data/storage_data volumes)
docker compose down -v       # stop and wipe Chatwoot's own data — DIRUS's Neon data is untouched either way
```
