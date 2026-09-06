# Design: Admin dashboard

## Technical Approach

The whole change hangs off one problem F2 already solved once: **three lookups in this
flow happen before `broker_id` is known** — email → user (link request), token hash → user
(callback), session id → user (every request). `0002_rls_policies.sql` makes all three
return zero rows without `app.broker_id`, and `withBrokerContext` cannot be opened without
it. So **D-A extends `0004_tenant_resolver.sql`'s `dirus_tenant_resolver` /
`SECURITY DEFINER` mechanism** to three new key→`uuid` functions rather than inventing a
second pattern. Everything else — session shape, CSRF, middleware, metrics, SPA — is
ordinary work layered on top of that spine.

Ordering is fail-closed throughout: resolve → open tenant context → validate inside the
transaction → act. No step is reachable by skipping the one before it.

This is the first `design.md` for a change that was `(ff)`-tagged and then promoted, so
there is no in-repo precedent for the situation. Format and depth follow
`archive/2026-09-04-whatsapp-webhook-ingress/design.md`.

## Architecture Decisions

### D-A: Pre-tenant lookups reuse `dirus_tenant_resolver`; the functions return a bare `uuid` and decide nothing

**Status: NEEDS EMPIRICAL PROOF** (assertions at the end of this decision). The *mechanism*
was proven live in CI run 33899572167 for `brokers`; what is unproven is that the same
mechanism applied to three **new** tables does not widen `dirus_app`'s own access. New
policies are new objects; precedent is not proof.

| Option | Verdict |
|---|---|
| Drop `broker_id` from the auth tables and leave them un-RLS'd | **Rejected.** Contradicts P3 and §7.1's uniform "every table carries `broker_id`" rule. It would also make a leaked `dirus_app` credential read *every* tenant's pending sessions — strictly worse than what RLS gives us |
| Permissive `USING (true)` policy granted to `dirus_app` on the auth tables | **Rejected for the same reason 0004 rejected it.** Permissive policies OR-combine, so this makes every row of `broker_users` readable to `dirus_app` on every query |
| `unsafeAdminDb` / a second pooled connection for auth reads | **Rejected.** Unexported by design, documented DDL-only, needs a non-PgBouncer connection unsuited to a hot path that now runs on *every* dashboard request |
| Look the session up from a stateless signed cookie payload, avoiding the read entirely | **Rejected** — see D-B |
| **Three new `SECURITY DEFINER` functions owned by the existing `dirus_tenant_resolver` role, each returning a bare `uuid`** | **Chosen**, pending live proof |

```sql
-- 0006_broker_auth.sql (sketch). NO `CREATE ROLE` — 0004 already created it.
GRANT SELECT (id, broker_id, email)                   ON public.broker_users      TO dirus_tenant_resolver;
GRANT SELECT (broker_id, token_hash)                  ON public.magic_link_tokens TO dirus_tenant_resolver;
GRANT SELECT (broker_id, session_token_hash)          ON public.sessions          TO dirus_tenant_resolver;

CREATE POLICY tenant_resolver_lookup ON public.broker_users
  FOR SELECT TO dirus_tenant_resolver USING (true);   -- same for the two new tables

CREATE FUNCTION public.dirus_resolve_broker_id_by_email(p_email text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT broker_id FROM public.broker_users WHERE email = p_email $$;
-- + dirus_resolve_broker_id_by_magic_link(p_token_hash text) RETURNS uuid
-- + dirus_resolve_broker_id_by_session(p_session_hash text) RETURNS uuid
```

**The functions decide nothing.** They filter on the key and nothing else — no
`expires_at`, no `used_at`, no `revoked_at`. Expiry, single-use consumption and idle
timeout are all evaluated **inside** `withBrokerContext`, under RLS, in the same
transaction that mutates the row. Two reasons: it keeps the "bare `uuid`, no row data"
invariant that D-1 rule #2 established, and it keeps the atomic
`UPDATE ... WHERE used_at IS NULL` consumption where it belongs — in a transaction — rather
than splitting a check across two connections. This mirrors 0004's deliberate refusal to
put a `status` predicate in the resolver.

**Accepted, bounded blast radius, stated rather than discovered later.** `dirus_app` gains
a *database-level* existence oracle: it can call `dirus_resolve_broker_id_by_email` and
learn whether an address is registered, and which opaque broker `uuid` it belongs to. It
learns no name, phone, role, or token. `dirus_app` is our own API process, and D-C is where
the enumeration question is actually answered — at the HTTP boundary. This is strictly less
exposure than the rejected permissive-policy option.

**Live assertions that must pass before implementation is accepted** (extend
`live-rls-verification.test.ts`'s conventions — throwaway schema, disposable fixture roles,
`assertThrowawayDatabase`, `describe.skipIf`; do not invent a second harness):

1. **Positive**: as the app fixture role with **no** `app.broker_id` set, each of the three
   functions returns the expected `broker_id`.
2. **Negative control (the whole point)**: in the *same session*,
   `SELECT count(*) FROM broker_users`, `... FROM sessions`, `... FROM magic_link_tokens`
   each return `0`. Non-zero → the design is wrong and must not ship.
3. **Miss**: an unknown key returns `NULL`, not an error.
4. **Catalog guard** (extend `rls-catalog-guard.test.ts`): each new policy's `TO` names only
   `dirus_tenant_resolver`; each function is `SECURITY DEFINER`, owned by that role, with a
   non-null pinned `proconfig` search_path; `EXECUTE` revoked from `PUBLIC`; `dirus_app`
   holds no membership in the resolver role (`pg_auth_members`).
5. **Cross-tenant, end-to-end** (the non-negotiable success criterion): an authenticated
   broker-A session reads zero of broker B's `extractions`/`renewals`/metrics, with a
   positive control proving the assertion is not vacuous.

### D-B: Opaque 256-bit session id resolved server-side. "Signed" is dropped as redundant, and it is not a CSRF answer

| Option | Tradeoff | Verdict |
|---|---|---|
| Stateless HMAC-signed payload (`brokerUserId.brokerId.exp.sig`) | No DB read. But logout and revocation become impossible without a denylist — i.e. state anyway — and O6's *sliding* 7-day window requires re-issuing the cookie on every request, so "stateless" buys nothing it doesn't immediately give back | Rejected |
| Encrypted self-contained payload (JWE / `iron-session`) | Same revocation problem, plus a second secret to rotate and a crypto dependency | Rejected |
| Opaque id **plus** an HMAC signature over it | The signature's only job is rejecting forgeries without a DB hit. 256 bits of CSPRNG is already unguessable, and a cheap shape check (length + base64url charset) rejects garbage before any DB call — recovering most of the benefit for none of the second-secret cost | Rejected |
| **Opaque 32-byte CSPRNG id, SHA-256 hashed at rest, resolved via D-A** | One indexed lookup per request — which we were paying anyway to learn `broker_id` | **Chosen** |

This deliberately reads P4's word "signed" as *tamper-proof*, and satisfies it with
unforgeable-by-entropy rather than unforgeable-by-MAC. It is also the option consistent
with this project's standing rule: **never trust a client-supplied identity, resolve it
server-side.**

**Cookie attributes**, exact:

```
Set-Cookie: dirus_session=<32B base64url>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800
Set-Cookie: dirus_csrf=<32B base64url>;                Secure; SameSite=Lax; Path=/; Max-Age=604800
```

- **No `Domain` attribute** → host-only. D-G makes the API same-origin with the SPA, so a
  host-only cookie is sufficient and is the narrowest thing that works.
- **`SameSite=Lax`, not `Strict`** — P4 already gave the reason: the magic-link click is a
  top-level cross-site navigation from a mail client, and `Strict` would drop the cookie on
  the very request that establishes the session.
- **`Max-Age` re-sent on every refresh** so the browser's expiry tracks the server's. The
  server is authoritative: `sessions.idle_expires_at` is the real check.
- **Sliding window (O6)**: refresh `idle_expires_at = now() + 7 days` at most once per
  ~15 minutes of activity, not on literally every request — a write on every GET turns a
  read-only dashboard into a write-heavy one for no behavioural difference.

**CSRF — required, and `SameSite=Lax` alone does NOT close it.** Lax stops
`attacker.com → api`, but `docs/ARCHITECTURE.md` puts **Chatwoot on `inbox.dirus.io`** — a
third-party Rails application on the *same site* as the dashboard. An XSS or a
subdomain-takeover there is same-site, and Lax would happily attach the session cookie.
That is not hypothetical enough to wave away.

Mechanism: **session-bound double-submit.**

1. At login, generate a second independent 32-byte value. Store **`sha256(csrf)` in the
   `sessions` row**; return the raw value in the non-`HttpOnly` `dirus_csrf` cookie.
2. The SPA reads it and echoes it in `X-Dirus-CSRF` on every `POST`/`PATCH`/`PUT`/`DELETE`.
3. The server compares `sha256(header)` against `sessions.csrf_token_hash` with
   `timingSafeEqual`, mirroring `admin-auth.ts`'s `constantTimeEquals` helper.

Storing the hash server-side rather than comparing cookie-to-header is what defeats
**cookie tossing** — a same-site attacker who can write a `.dirus.io` cookie could otherwise
supply both halves of a plain double-submit. Requiring a **custom header** is the second,
independent layer: a custom header forces a CORS preflight, and D-G's origin allowlist
answers it for exactly one origin. Both layers are stated because either alone has a known
bypass.

Safe methods (`GET`/`HEAD`) are exempt — and consequently no `GET` endpoint in this change
may mutate.

### D-C: Anti-enumeration is byte-identical responses; timing is acknowledged and explicitly deferred

`POST /auth/magic-link` returns, for a known address, an unknown address, and a
well-formed address belonging to a user with `email IS NULL`:

- **`202 Accepted`**, always.
- Body `{"status":"accepted"}` — a fixed literal, **byte-identical**, no id, no echo of the
  input, no `retryAfter`.
- Identical headers. No `Set-Cookie`, no correlation id that differs in shape.
- `400` is returned **only** when the Zod body schema fails (the value is not an email at
  all). That distinguishes "malformed" from "email-shaped", never "known" from "unknown",
  so it is not an oracle.

**The email send is off the response path.** Order is load-bearing, and it interacts with
`withBrokerContext`'s documented reentrancy limitation: fire-and-forget work spawned
*inside* the callback inherits the async context and would be wrongly rejected as
reentrant. So:

```
resolve broker_id (D-A) ──null──▶ return 202          ← no DB write, no email
        │ found
        ▼
await withBrokerContext(brokerId, tx => insert magic_link_tokens)   ← COMMIT
        │
        ├─ dispatch sendMagicLink(...) detached, .catch(log)        ← AFTER the await
        └─ return 202                                               ← does not await it
```

The Node adapter has no `c.executionCtx.waitUntil`, so this is a detached promise with a
mandatory `.catch` — an unhandled rejection here would crash the process.

**Position on timing, stated rather than left vague: out of scope for v1, knowingly.** The
unknown-address path skips one `INSERT` (~1–5 ms) — measurable in principle under
statistical sampling, invisible under real network jitter. Closing it properly means always
performing a dummy insert-and-rollback, which adds write load, is easy to get subtly wrong,
and *still* leaks under enough samples. Against a closed pilot whose accounts are created
by an operator (proposal: no self-signup), the attacker's payoff — learning that an address
belongs to a pilot broker — does not justify it. **Revisit the moment self-signup ships**,
because that changes both the population size and the payoff. Recorded here so the deferral
is a decision, not an omission.

### D-D: `session-auth.ts` — injected dependency, mirrors `tenant-resolver.ts`, reuses `brokerId`

```ts
// apps/api/src/middleware/session-auth.ts
export type ResolvedSession = {
  brokerId: string;
  brokerUserId: string;
  role: string;          // O7: read, never enforced in v1
  csrfTokenHash: string; // D-B
};
/** Injected exactly like `ResolveBrokerId` — never imports `@dirus/db`. */
export type ResolveSession = (sessionTokenHash: string) => Promise<ResolvedSession | null>;

export type SessionAuthVariables = {
  brokerId: string;   // SAME key as TenantResolverVariables — see below
  session: ResolvedSession;
};

export function createSessionAuthMiddleware(
  resolveSession: ResolveSession,
): MiddlewareHandler<{ Variables: SessionAuthVariables }>;
```

`AppVariables` in `apps/api/src/app.ts` becomes:

```ts
export type AppVariables = TenantResolverVariables &
  WebhookAuthVariables &
  SessionAuthVariables & { ingest: Ingest; payload: ChatwootMessageCreatedPayload };
```

**`brokerId` is deliberately the same context key, not `sessionBrokerId`.** Hono types
context variables once per app instance, so both middlewares already share one map; and the
key means exactly the same thing in both — *the server-resolved tenant for this request,
never client input*. Two keys would invite a handler to read the wrong one. No route mounts
both middlewares.

The middleware, in order: shape-check the cookie (length + base64url charset, D-B) →
`sha256` → `resolveSession` → `null` ⇒ `401` empty body, mirroring `webhook-auth.ts` →
`c.set("brokerId", …)`, `c.set("session", …)`. **`brokerId` is never read from a path
param, query string, body, or header on any dashboard route** — enforceable by inspecting
every route's Zod input schema, which is the success criterion's stated verification.

`createApp` gains `resolveSession: ResolveSession`, `sendMagicLink: SendMagicLinkFn`,
`consumeMagicLink`, `createSession`, `revokeSession`, and the six metric query functions —
all injected, all faked in tests, so `@dirus/db` stays unreachable from every offline test's
import graph. This is not optional style: `@dirus/db` throws at import without
`DATABASE_URL`.

CSRF is a **separate** `csrf-guard.ts` middleware mounted *after* session-auth (it reads
`c.var.session.csrfTokenHash`) and only on mutating routes.

`admin-auth.ts` is untouched (O5).

### D-E: The envelope stub is a *joined view* of two columns, and the schema does not match the table

`packages/schemas/src/extraction-envelope.ts`, re-exported from the barrel. Zod only — the
zero-workspace-dependency rule holds.

```ts
/** @provisional — owned by B2 (`ingestion-agent`) on arrival. C1 only READS this. */
export const extractedField = z.object({
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
});
export const extractionEnvelope = z.record(z.string(), extractedField);
```

**Loose on `value`, strict on `confidence`.** `confidence` is the only member the review
queue *reasons* about — it drives the 0.85 threshold and the per-field highlight — so it is
required, numeric, and bounded. `value` is only rendered, so `unknown` costs nothing and
avoids guessing at field types B1's document schemas already model separately.

**Finding the proposal did not account for**: P9 describes
`Record<field, { value, confidence }>`, but `extractions` stores **`output` and `confidence`
as two separate `jsonb` columns**. No producer emits P9's merged shape and none is likely
to. So the envelope is a **read-side view that C1 assembles by zipping the two columns**,
not a description of either column. `output` is treated as `Record<field, unknown>`,
`confidence` as `Record<field, number>`; the zip is one function,
`toEnvelope(output, confidence)`, the single place that knows.

Parsing is `safeParse`, never `parse`. On failure the review queue **falls back to raw-JSON
display** rather than throwing — the proposal's stated mitigation, and the only honest
behaviour for a shape whose producer does not exist. **Say it plainly: this schema will
very likely need revision when B2 lands.** That is a normal spec delta, not a breakage.

### D-F: Six explicit metric queries. No metrics engine

| Option | Tradeoff | Verdict |
|---|---|---|
| One generic query builder / "metrics engine" (dimension + aggregate + filter DSL) | Would pay off at ~20 metrics with a shared shape. These six share almost nothing: three tables, two GROUP BYs, one date-diff, and one that isn't SQL at all (Langfuse HTTP). The DSL would need an escape hatch on day one | **Rejected** — this is exactly the speculative abstraction P7 rejects for build config |
| One handler per metric, colocated SQL | Six files, some visual repetition, each independently readable and independently deletable | **Chosen** |

```
apps/api/src/services/metrics/
  copilot-share.ts                 conversations.kind = 'copilot'        (H1, gap-disclosed)
  renewal-status.ts                renewals GROUP BY status              (H2)
  needs-review-rate.ts             extractions.needs_review partial idx  (H3)
  conversation-status-snapshot.ts  conversations.status, current-state   (P8)
  time-to-first-renewal.ts         brokers.created_at → first template   (Ops)
  cost.ts                          Langfuse HTTP — the droppable one     (P6)
```

Each exports `(tx: TenantDb) => Promise<MetricResult<T>>`; every one runs inside the caller's
`withBrokerContext`, never opening its own (the reentrancy guard forbids nesting).

```ts
type MetricResult<T> = {
  value: T;
  sampleSize: number;   // 0 vs. a real 0% — the distinction that matters right now
  empty: boolean;       // sampleSize === 0
  caveat?: string;      // P8's "current-state snapshot"; O8's uninstrumented denominator
};
```

`caveat` travels **as data from the query**, not as copy hardcoded in a React component, so
the P8/O8 disclosures cannot silently drift away from the query that requires them.

`cost.ts` is isolated behind a `LangfuseCostSource` interface and is droppable without
touching the other five (P6).

### D-G: Caddy reverse-proxies the API under the SPA's origin. **`apps/api` needs no CORS policy**

This reverses the brief's working assumption, on evidence. `docs/ARCHITECTURE.md` §10 routes
`app.dirus.io` → static bundle and `api.dirus.io` → API. Those are **same-site but
cross-origin**, so prod is *not* same-origin as assumed.

| Option | Tradeoff | Verdict |
|---|---|---|
| Keep `api.dirus.io`, add `hono/cors` with `credentials: true` + exact-origin allowlist | Works, but adds a preflight to every mutation, an origin allowlist that must track every environment, and a prod/dev asymmetry where dev proxies and prod does not | Rejected |
| Serve the SPA from `api.dirus.io` | Couples the static bundle's deploy to the API container; §10 explicitly keeps them separate (rsync vs. `compose pull`) | Rejected |
| **Caddy `handle_path /api/*` on `app.dirus.io` → API container** | One `Caddyfile` block. Prod becomes genuinely same-origin, so **zero CORS**, host-only cookies, no preflight, and dev/prod are structurally identical | **Chosen** |

`api.dirus.io` stays exactly as it is for machine callers — Chatwoot's webhook and A1's
import endpoint. Neither uses cookies, so neither is affected.

**Dev** uses Vite's `server.proxy` (`/api` → `http://localhost:3000`), which makes the dev
origin same-origin too. Chosen over CORS-in-dev specifically so the cookie behaves
identically in both environments; it also sidesteps `Secure`-on-`http://localhost`, which
works today only by browser special-case, not by spec.

Requires an `infra/Caddyfile` change — an explicit task, not incidental.

```
apps/dashboard/
  index.html   vite.config.ts   tsconfig.json
  src/main.tsx  src/App.tsx
  src/routes/{login,auth-callback,review-queue,metrics}.tsx
  src/components/RequireSession.tsx   # calls GET /api/auth/me once; 401 → /login
  src/api/client.ts                   # the ONLY place fetch() is called
```

`client.ts` centralises `credentials: "include"`, the `X-Dirus-CSRF` header on mutations,
and 401 → redirect. One file, so the auth contract cannot be re-implemented per screen.
Router: `react-router` declarative mode — no framework mode, no SSR (P7, §10). Per P7 the
build config is standalone; no `packages/config` preset.

### D-H: Migration `0006_broker_auth.sql`

`broker_users.email` — nullable `text`, plus a **plain unique index**:

```sql
ALTER TABLE broker_users ADD COLUMN email text;
CREATE UNIQUE INDEX broker_users_email_key ON public.broker_users (email);
```

Globally unique per O2, deliberately *not* `UNIQUE (broker_id, email)`. Postgres treats
`NULL`s as distinct in a unique index, so unlimited rows may keep `email IS NULL` — exactly
what P2 requires for existing WhatsApp-only users. **Do not add `NULLS NOT DISTINCT`**; it
would break every existing row on the second insert.

Two tables, not one. Merging them would need a discriminator plus columns that are
required-in-one-mode and meaningless in the other (`csrf_token_hash` on a magic link,
`used_at` on a session), which is a union type pretending to be a table.

```ts
// packages/db/src/schema/magic_link_tokens.ts  — style mirrors contacts.ts exactly
id, brokerId(uuid,notNull,→brokers.id), brokerUserId(uuid,notNull,→brokerUsers.id),
tokenHash(text,notNull), expiresAt(timestamptz,notNull), usedAt(timestamptz,null),
createdAt(timestamptz,notNull,defaultNow)
  → unique().on(tokenHash)

// packages/db/src/schema/sessions.ts
id, brokerId, brokerUserId, sessionTokenHash(text,notNull), csrfTokenHash(text,notNull),
idleExpiresAt(timestamptz,notNull), lastSeenAt(timestamptz,notNull,defaultNow),
revokedAt(timestamptz,null), createdAt(timestamptz,notNull,defaultNow)
  → unique().on(sessionTokenHash), index().on(brokerUserId)
```

`usedAt`/`revokedAt` follow `contacts.consent_at`'s nullable-timestamp convention —
presence means "this happened", which makes single-use and logout enforceable *and*
auditable rather than implicit in a `DELETE`.

**Hashing is SHA-256** (`node:crypto`, hex), for both tables. Not bcrypt/argon2, and this is
not under-engineering: those exist to make *offline brute force of low-entropy,
human-chosen* secrets expensive. These are 256-bit CSPRNG values — there is no dictionary
to run, and no amount of KDF stretching improves on 2²⁵⁶. Argon2 would instead add ~100 ms
to **every authenticated request**, since D-B resolves the session by hash on each one.

RLS, identical to `0002_rls_policies.sql`'s established shape, for both new tables:

```sql
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions FOR ALL
  USING      (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid)
  WITH CHECK (broker_id = nullif(current_setting('app.broker_id', true), '')::uuid);
```

`FORCE` (not `ENABLE` alone), and both clauses with the identical predicate — a `USING`-only
policy would let a broker-A transaction insert a broker-B row.

`token_hash`/`session_token_hash` uniqueness is **global**, not per-tenant — the same
accepted trade-off as `messages.wa_message_id`, and required by D-A's lookup. A collision
across tenants is a 2⁻²⁵⁶ event; recorded, not patched.

Down path documented in migration comments, ordered as in 0004: revoke `EXECUTE` → drop
functions → drop policies → revoke column grants → drop tables → drop the `email` index and
column. The role itself is **not** dropped — 0004 owns it.

## Data Flow

```
LOGIN
  POST /api/auth/magic-link {email}
     └─ dirus_resolve_broker_id_by_email (D-A) ──null──▶ 202 (identical bytes, D-C)
              │ brokerId
              ▼
        withBrokerContext(insert magic_link_tokens{sha256(raw), +15min})  ← COMMIT
              ├─ detached sendMagicLink(email, url).catch(log)   ← after commit (D-C)
              └─ 202 (identical bytes)

CALLBACK
  GET /api/auth/callback?token=…
     └─ dirus_resolve_broker_id_by_magic_link(sha256(token)) ──null──▶ 302 /login?error
              ▼
        withBrokerContext(
            UPDATE magic_link_tokens SET used_at=now()
              WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING …
            └─ no row ⇒ replayed or expired ⇒ 302 /login?error
            INSERT sessions{session_hash, csrf_hash, idle_expires_at=+7d})   ← COMMIT
              ▼
        Set-Cookie dirus_session + dirus_csrf  ──302──▶ /  (token never in the landing URL)

EVERY DASHBOARD REQUEST
  Cookie ──shape check──▶ sha256 ──▶ dirus_resolve_broker_id_by_session ──null──▶ 401
              │ brokerId
              ▼
        session-auth (D-D) sets c.var.brokerId  ← NEVER from client input
              ▼
        csrf-guard (D-B, mutations only) ──mismatch──▶ 403
              ▼
        withBrokerContext(brokerId, tx => review-queue | metrics query)
```

## File Changes

| Path | Action | Description |
|---|---|---|
| `packages/db/migrations/0006_broker_auth.sql` | Create | D-H + D-A: column, index, 2 tables, RLS, 3 resolver functions. `drizzle-kit generate --custom` |
| `packages/db/src/schema/{magic_link_tokens,sessions}.ts` | Create | D-H |
| `packages/db/src/schema/broker_users.ts` | Modify | `email` column |
| `packages/db/src/auth-resolution.ts` | Create | D-A's three narrow lookups; extends `tenant-resolution.ts`'s pattern |
| `packages/db/src/{index,tenant}.ts` | Modify | Barrel exports (+ allowlist test) and the `TenantDb` docstring's "second access class" note |
| `packages/db/test/migrations/live-broker-auth.test.ts` | Create | D-A's five live assertions |
| `packages/db/test/migrations/rls-catalog-guard.test.ts` | Modify | Per-table `TO`-clause, owner, `proconfig`, `EXECUTE` guards |
| `apps/api/src/middleware/{session-auth,csrf-guard}.ts` | Create | D-D, D-B |
| `apps/api/src/routes/auth/{magic-link,callback,logout,me}.ts` | Create | D-C |
| `apps/api/src/routes/dashboard/{review-queue,metrics}.ts` | Create | Read + correct endpoints |
| `apps/api/src/services/metrics/*.ts` | Create | D-F, six files |
| `apps/api/src/services/auth/*.ts` | Create | Token/session issue + consume |
| `apps/api/src/app.ts` | Modify | D-D: `AppVariables`, new injected deps |
| `apps/api/src/{index,env}.ts` | Modify | Wire real impls; `EMAIL_*`, `DASHBOARD_BASE_URL`, `LANGFUSE_*` via `readRequired` |
| `apps/api/src/middleware/admin-auth.ts` | **Unchanged** | O5 |
| `packages/integrations/src/email/*.ts` | Create | `sendMagicLink(to, url)`; provider TBD (O3) |
| `packages/integrations/src/langfuse/*.ts` | Create | P6 cost source; droppable |
| `packages/schemas/src/extraction-envelope.ts` + auth request schemas + barrel | Create/Modify | D-E |
| `apps/dashboard/**` | Create | D-G; `src/index.ts` shell replaced |
| `infra/Caddyfile` | Modify | D-G `handle_path /api/*` |
| `.env.example` | Modify | New vars |
| `openspec/{ROADMAP.md,PHASES.md}` | Modify | Drop C1's `(ff)` |

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit (offline) | 401 without/with a bad cookie; CSRF 403 on missing/wrong header; `202` byte-identical for known/unknown/`NULL`-email; `400` only on non-email; single-use and expiry rejection; cookie attribute string | Vitest against `createApp({ …fakes })` — zero `@dirus/db` in the import graph |
| Unit | `toEnvelope` zip; `safeParse` failure → raw-JSON fallback, no throw | Fixtures, D-E |
| Structural | 0006 declares `FORCE`, both `USING`/`WITH CHECK`, `TO dirus_tenant_resolver`, pinned `search_path`, `REVOKE … FROM PUBLIC` | SQL-text assertions, mirroring `rls-policies.test.ts` |
| Catalog | Function owners, `proconfig`, `EXECUTE` grantees, no `dirus_app` membership | `pg_proc`/`pg_policy`/`pg_auth_members` |
| **Live — D-A (gate)** | The five assertions, negative control included | `LIVE_TEST_DATABASE_URL`, throwaway schema, `assertThrowawayDatabase` |
| Live | `magic_link_tokens` contains no raw token — asserted against the **stored column**, not the code path | Issue a link, then read the column |
| Live | Multiple `broker_users` rows with `email IS NULL` coexist; a duplicate non-null email is rejected | Direct inserts |
| **Live — isolation (non-negotiable)** | Broker-A session reads zero of B's extractions/renewals/metrics, **with a positive control** | Two-broker fixture |
| Live — metrics | All six against **seeded fixtures** (real numbers) **and** empty tables (`empty: true`) | Correctness must not wait on A2/B2 |
| E2E | `apps/dashboard/dist` served, full login → review → metrics against a live API | Manual for v1; no browser runner exists in this repo |

## Migration / Rollout

Additive. Down path is **scripted, not improvised**, in D-H's stated order — dropping the
resolver functions before revoking their grants, and never dropping `dirus_tenant_resolver`
(0004 owns it). Reverting loses only pending links and stored emails; no domain data.

`admin-auth.ts` and `ADMIN_API_TOKEN` are untouched (O5), which **removes the one
non-mechanical step the proposal's rollback plan warned about**. The rollback is now purely
mechanical.

The `caveat` disclosures (P8, O8) ship from day one; there is no phase in which the
dashboard shows an undisclosed at-close number.

## Open Questions

- [ ] **D-A is unproven for the three new tables.** The mechanism passed live in CI for
      `brokers`; these are new policies on new objects. The five assertions are the
      acceptance gate — do not accept implementation on this reasoning alone.
- [ ] **NEEDS EMPIRICAL PROOF** — that the sliding-window refresh (`UPDATE sessions`) under
      `withBrokerContext` on a `GET` does not deadlock or serialise under concurrent
      requests from one session. The ~15-minute throttle is the mitigation; a concurrency
      test must confirm it, in the style of D-2's concurrent-replay test.
- [ ] **O3 still open** — email provider. No architectural stakes; the interface is
      `sendMagicLink(to, url)` and the boundary is `packages/integrations`.
- [ ] `sdd-tasks` must forecast chained PRs. Natural slices, in dependency order:
      (1) migration + schema + D-A live proof, (2) email integration, (3) auth flow +
      middleware, (4) SPA shell + D-G Caddy/proxy, (5) review queue + envelope,
      (6) metrics. Each is independently deliverable; (6) can drop `cost.ts` alone.
      **400-line budget risk: High.**
- [ ] Expired/used `magic_link_tokens` and `sessions` rows accumulate with no reaper.
      Harmless at pilot volume, unbounded eventually. A Trigger.dev cleanup job is
      deliberately deferred, not forgotten.
