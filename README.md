# DIRUS

Multi-tenant WhatsApp-first platform for insurance brokers (Colombian market). pnpm monorepo, Neon Postgres, Chatwoot as the WhatsApp mirror. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and [`openspec/`](openspec/) for the spec-driven development trail (proposals, specs, tasks, archived changes).

## Prerequisites

- Node.js >= 22
- pnpm 10.34.5 (pinned via `packageManager` in `package.json` — `corepack enable` will pick it up automatically)
- A Postgres 17 database with the `pgvector` extension available. Locally this is either:
  - A [Neon](https://neon.tech) project (the production target — gives you the pooled/unpooled two-URL split for free), or
  - A local `pgvector/pgvector:pg17` container (see `.github/workflows/ci.yml` for the exact image CI uses)

## 1. Install

```bash
pnpm install
```

## 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env` — every variable is documented inline in `.env.example`. The essentials to get the API running locally:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | **Pooled** endpoint (hostname contains `-pooler` on Neon). Used by the app runtime. |
| `DATABASE_URL_UNPOOLED` | **Direct** endpoint (no `-pooler`). Used only by `db:generate` / `db:migrate` / `db:check` — DDL must never cross a transaction pooler. |
| `PORT` | Port `apps/api` listens on (`3000` matches `apps/dashboard`'s dev proxy target — see below). |
| `ADMIN_API_TOKEN`, `CHATWOOT_WEBHOOK_TOKEN` | ≥32 bytes of random entropy each, e.g. `openssl rand -hex 32`. |
| `CHATWOOT_BASE_URL`, `CHATWOOT_API_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID` | Only required to exercise the real WhatsApp ingress; the app fails fast at import time if unset. |
| `EMAIL_API_KEY`, `EMAIL_FROM_ADDRESS`, `DASHBOARD_BASE_URL` | Resend credentials + callback base URL for the broker-dashboard magic-link login (`DASHBOARD_BASE_URL=http://localhost:5173` for local dev). |

Running against a **local Postgres container** instead of Neon:

```bash
docker run --rm -d --name dirus-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dirus \
  pgvector/pgvector:pg17

# both URLs can point at the same local instance — there's no real pooler to separate them from
DATABASE_URL=postgres://postgres:postgres@localhost:5432/dirus
DATABASE_URL_UNPOOLED=postgres://postgres:postgres@localhost:5432/dirus
```

## 3. Apply database migrations

```bash
pnpm db:migrate
```

Runs `packages/db/scripts/migrate.ts` against `DATABASE_URL_UNPOOLED`, applying every file under `packages/db/migrations/` in order. Safe to re-run (idempotent).

Other database commands:

```bash
pnpm db:generate   # drizzle-kit generate — new migration from a schema change
pnpm db:check      # drizzle-kit check — detect schema/migration drift
```

## 4. Run the apps

**API** (`apps/api`, Hono on `@hono/node-server`):

```bash
pnpm --filter @dirus/api run dev
```

Starts on `http://localhost:$PORT` with hot reload (`tsx watch`).

**Dashboard** (`apps/dashboard`, Vite + React):

```bash
pnpm --filter @dirus/dashboard run dev
```

Starts on `http://localhost:5173`. Its dev server proxies `/api/*` (stripped) to `http://localhost:3000` — the same same-origin, no-CORS shape Caddy provides in production (see `infra/Caddyfile` and `docs/ARCHITECTURE.md` §10), so run the API on `PORT=3000` for the proxy to line up.

Run both in separate terminals to use the dashboard end-to-end against a real API.

## 5. Verify everything works

```bash
pnpm -r run typecheck   # every workspace project
pnpm -r run test        # offline unit/integration suites; live suites self-skip without a reachable Postgres
pnpm run lint            # eslint .
pnpm run lint:deps       # dependency-cruiser — enforces the monorepo's layering rules
```

CI (`.github/workflows/ci.yml`) runs all four against a real `pgvector/pgvector:pg17` service container plus several dedicated throwaway databases, so the `*_TEST_DATABASE_URL` live suites that skip locally run for real there.

## Project layout

```
apps/
  api/        Hono HTTP API — webhooks, admin endpoints, broker-dashboard routes
  dashboard/  Vite + React SPA — broker-facing login, extraction review queue, product metrics
  jobs/       Scheduled/background job runners
packages/
  db/         Drizzle schema, migrations, tenant-scoped query helpers (withBrokerContext)
  schemas/    Shared Zod schemas (webhooks, extraction envelopes, dashboard requests)
  integrations/  Third-party service clients (Chatwoot, Resend)
  agents/     AI agent logic (renewal agent, copilot, ingestion)
  config/     Shared tsconfig/vitest/eslint base configs
infra/        Caddyfile (reverse proxy) and deployment config
openspec/     Spec-driven development artifacts — active changes, archived changes, composite specs
```

## Multi-tenancy note

Every tenant-scoped query goes through `withBrokerContext(brokerId, fn)` (`packages/db/src/tenant.ts`), which sets the Postgres session's `app.broker_id` inside an explicit transaction so Row-Level Security enforces isolation at the database layer — never a raw pooled query filtered only in application code. See `docs/ARCHITECTURE.md` §11 for the full security model.
