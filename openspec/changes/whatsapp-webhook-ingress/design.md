# Design: WhatsApp webhook ingress

## Technical Approach

One synchronous Hono route, one `withBrokerContext` transaction, one echo after commit.
The whole change hangs off **D-1**: nothing else can run until a request holding only a
`wa_phone_number_id` can learn its `broker_id` without weakening `brokers` RLS for
`dirus_app`. D-1 requires a migration, so **O2 resolves YES: a `data-model` delta spec is
required** (scope in D-1's "Delta" block below).

Everything downstream is ordered to fail closed: authenticate → parse → resolve tenant →
transaction → commit → echo. No step can be reached by skipping the one before it.

## Architecture Decisions

### D-1: Tenant resolution — a dedicated NOLOGIN role owns a `SECURITY DEFINER` function; the permissive policy is `TO` that role only

**Status: NEEDS EMPIRICAL PROOF.** No Postgres was reachable from this design session (no
shell available), so nothing below was executed. The reasoning is from Postgres semantics;
the exact live test that must pass before implementation is accepted is specified at the
end of this decision. Do not treat this as verified.

| Option | Verdict |
|---|---|
| `CREATE POLICY ... FOR SELECT USING (true)` granted to `dirus_app` | **Rejected.** Permissive policies for the same command combine with `OR`, so this makes every `brokers` row readable to `dirus_app` on every query. Column-level `GRANT`s narrow columns, never rows. Directly violates spec scenario "The tenant-resolution mechanism does not expose arbitrary brokers rows" |
| `SECURITY DEFINER` function owned by the **table owner** | **Rejected.** `FORCE ROW LEVEL SECURITY` binds the owner — proven by the negative control in `live-rls-verification.test.ts` ("proves FORCE (not ENABLE alone) binds the table-owning role"). Returns zero rows |
| Non-`security_invoker` view owned by the table owner | **Rejected.** Same mechanism, same zero rows |
| Sentinel context, e.g. policy `OR current_setting('app.broker_id', true) = 'resolver'` | **Rejected — plausible and wrong.** `dirus_app` can set that value itself. A bypass the attacker can self-grant is not a control |
| `unsafeAdminDb` / a direct admin connection | **Rejected.** Unexported by design, documented migrations/DDL only, and requires a direct non-PgBouncer connection unsuited to hot-path traffic |
| Static `wa_phone_number_id → broker_id` map in env/config | **Rejected.** Creates a second source of truth that drifts silently at broker onboarding — exactly the failure P4 exists to make visible |
| **Dedicated `NOLOGIN` role + `TO`-scoped permissive `SELECT` policy + `SECURITY DEFINER` function owned by that role, returning a bare `uuid`, `EXECUTE` granted to `dirus_app`** | **Chosen**, pending the live proof below |

```sql
-- 0004_tenant_resolver.sql (sketch; NOLOGIN, so unlike dirus_app it carries no secret
-- and belongs in a committed migration rather than a provisioning script)
CREATE ROLE dirus_tenant_resolver NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO dirus_tenant_resolver;
GRANT SELECT (id, wa_phone_number_id) ON public.brokers TO dirus_tenant_resolver;

CREATE POLICY tenant_resolver_lookup ON public.brokers
  FOR SELECT TO dirus_tenant_resolver USING (true);

CREATE FUNCTION public.dirus_resolve_broker_id(p_key text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''                       -- see "search_path" below
AS $$ SELECT id FROM public.brokers WHERE wa_phone_number_id = p_key $$;

ALTER FUNCTION public.dirus_resolve_broker_id(text) OWNER TO dirus_tenant_resolver;
REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id(text) TO dirus_app;
```

**Why this is expected to work.** Postgres decides which policies apply from
`GetUserId()` — the *current effective* user — and `SECURITY DEFINER` sets that to the
function owner for the duration of the body. Inside the body `current_user` is
`dirus_tenant_resolver` (`session_user` stays `dirus_app`), so `tenant_resolver_lookup`
applies and ORs with `tenant_isolation` to yield `true`. Outside the body `current_user`
is `dirus_app`, the `TO` clause excludes it, and only `tenant_isolation` remains — the row
filter is intact. `FORCE` is irrelevant here because the resolver role is not the table
owner; ordinary RLS applies to it.

**Three ways this can be built wrong, all of which the live test must catch:**

1. **Role membership defeats the `TO` clause.** Policy role matching uses
   `has_privs_of_role`, which follows `INHERIT`. If `dirus_app` — or the table owner —
   ends up an *inheriting* member of `dirus_tenant_resolver`, the permissive policy
   applies to it directly and the hole is fully reopened. `ALTER FUNCTION ... OWNER TO`
   requires the migration role to hold that membership, so grant it `WITH INHERIT FALSE`
   (PostgreSQL ≥ 16; CI is pg17, Neon is 16/17) and never grant it to `dirus_app`. A
   catalog-derived guard test, in the style of `rls-catalog-guard.test.ts`, must assert
   both facts from `pg_auth_members`.
2. **`search_path` hijack.** A `SECURITY DEFINER` function with an unpinned `search_path`
   can be redirected by anything the caller can create — including a `pg_temp` relation,
   which is implicitly searched first. Pin `SET search_path = ''` *and* schema-qualify
   `public.brokers`; the qualification is the real defense, since `pg_temp_N.brokers`
   can never shadow `public.brokers`.
3. **Default `EXECUTE` to `PUBLIC`.** Functions grant `EXECUTE` to `PUBLIC` by default.
   The `REVOKE` line is load-bearing, not decoration.

**Accepted, bounded blast radius.** `dirus_app` gains an oracle: it can call the function
with arbitrary keys and learn whether a broker exists and its opaque `uuid`. It cannot
learn `name`, `waba_id`, `plan`, `status`, or any other row. That is strictly less than
the rejected permissive-policy option, and it is stated here rather than discovered later.

**Delta (O2 = YES).** `specs/data-model/` gains scenarios asserting, from the catalog:
the resolver role exists and is `NOLOGIN`/`NOBYPASSRLS`; the permissive `brokers` policy
names only `dirus_tenant_resolver` in `TO`; the function is `SECURITY DEFINER`, owned by
that role, has a non-null pinned `proconfig` search_path; `EXECUTE` is revoked from
`PUBLIC` and granted only to `dirus_app`; `dirus_app` holds no membership in the resolver
role.

**The live test that must pass before implementation is accepted** (extend
`live-rls-verification.test.ts`'s conventions — throwaway schema, disposable fixture
roles, `assertThrowawayDatabase`, `describe.skipIf`; do not invent a second convention):

1. **Positive**: connected as the app fixture role with **no** `app.broker_id` set,
   `SELECT dirus_resolve_broker_id('phoneA')` returns broker A's `id`.
2. **Negative control (the whole point)**: in the *same session*,
   `SELECT count(*) FROM brokers` returns `0`, and `SELECT * FROM brokers` returns zero
   rows. If this returns anything non-zero, the design is wrong and must not ship.
3. **Miss**: `dirus_resolve_broker_id('unknown')` returns `NULL`, not an error.
4. **Owner control**: the same call made through an owner-owned `SECURITY DEFINER`
   function returns `NULL` — re-proving FORCE binds the owner, so the resolver role is
   demonstrably why this works.
5. **Membership guard**: `pg_auth_members` shows no inheriting membership of the app role
   in the resolver role.

### D-2: Conversation find-or-create — transactional serialization on the contact row, no new constraint

| Option | Tradeoff | Verdict |
|---|---|---|
| Partial `UNIQUE (broker_id, contact_id) WHERE contact_id IS NOT NULL` + `ON CONFLICT` | Hard guarantee, but permanently encodes "one conversation per contact, forever" — a product invariant the F1 schema deliberately did **not** encode (`status`, `window_expires_at`, `escalation_reason` all model a reopenable thread). Also a migration + a second `data-model` delta | Rejected |
| `pg_advisory_xact_lock(hash(broker_id, contact_id))` | Works, but adds a cluster-wide hash namespace and a lock acquisition on every inbound message | Rejected — the contact upsert already provides a narrower lock for free |
| **Order the statements so the contacts upsert serializes the transaction** | No schema change, no product invariant invented; correctness depends on READ COMMITTED semantics, so it must be proven by the concurrency test | **Chosen** |

The statement order is **load-bearing, not stylistic**:

```
1. INSERT INTO contacts (...) VALUES (...)
     ON CONFLICT (broker_id, phone) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING id;                                    ← serialization point
2. SELECT id FROM conversations
     WHERE broker_id = $b AND contact_id = $c AND kind = 'customer'
     ORDER BY created_at DESC LIMIT 1;
3. if none → INSERT INTO conversations (broker_id, contact_id, kind) ... RETURNING id;
4. INSERT INTO messages (...) ON CONFLICT (wa_message_id) DO NOTHING RETURNING id;
```

`DO UPDATE` — not `DO NOTHING` — is required. `DO UPDATE` takes a row-level exclusive
lock on the conflicting contact, so a second concurrent transaction for the same sender
blocks at step 1 until the first commits; under READ COMMITTED its step 2 then runs on a
fresh snapshot and *sees* the committed conversation. `DO NOTHING` takes no such lock,
returns no row, and reintroduces exactly the race the spec forbids. The cost is one dead
tuple per inbound message, which autovacuum absorbs at pilot volume. `kind` is `NOT NULL`
with no default and must be supplied (`'customer'`).

RLS interaction: `ON CONFLICT DO UPDATE` fails with a bare unique violation when the
conflicting row is invisible under `USING`. Here `broker_id` is part of the conflict key
and always equals the current tenant, so the conflicting row is always visible. This is
safe *because* of the key's shape, not by luck.

### D-3: Deduplication — the `wa_message_id UNIQUE` constraint, inside the same transaction

Dedup is step 4 above: `ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`. Never a
read-then-insert; two concurrent retries both pass that check.

- **Transaction boundary**: steps 1–4 are one `withBrokerContext` transaction. The echo is
  sent **after commit, outside the transaction** — both because an HTTP call must not hold
  a transaction open, and because `withBrokerContext` throws on reentrancy.
- **Losing side**: `RETURNING` yields no row → the transaction still **commits** (steps 1–3
  are idempotent; on a genuine duplicate the conversation already exists) → the endpoint
  returns **200** with `{ deduplicated: true }` → **no echo is sent**. A second
  acknowledgement for one customer message is a visible bug, and the spec's echo
  requirement is scoped to a successfully *persisted* message. 2xx is mandatory so
  Chatwoot stops retrying.
- **Surfaced, not patched**: `wa_message_id UNIQUE` is *global*, not per-broker. If broker
  A ever presents a `wa_message_id` already owned by broker B, A's insert is silently
  suppressed and A returns 2xx having written nothing. Meta's wamids are globally unique so
  this is not expected in practice, and it is a blind write-suppression side channel rather
  than a read leak — but making it per-tenant would contradict `docs/ARCHITECTURE.md` §7.1
  and is out of scope here. Recorded as accepted risk.

### D-4: Inbound authentication — a rotating shared-secret bearer credential (a compensating control, **not** a signature)

**NEEDS CONFIRMATION**: Chatwoot's account/agent-bot webhooks are not known to HMAC-sign
their payloads; the configurable surface is a URL. Until confirmed:

- `CHATWOOT_WEBHOOK_TOKEN`, ≥ 32 bytes of entropy, compared with
  `crypto.timingSafeEqual` after a length check. Accepted from the
  `X-Dirus-Webhook-Token` header when present, otherwise from a URL path segment
  (`/webhooks/chatwoot/:token`), because Chatwoot may only permit a URL.
- **Say it plainly: this is a bearer credential, not a signature.** It authenticates the
  caller, never the payload. It is replayable by anyone who observes it, and in the URL
  form it lands in reverse-proxy access logs. Compensating controls: TLS-only; the
  reverse proxy must not log the path/query for this route; a documented rotation
  procedure; and D-3's constraint bounds replay damage to zero new rows.
- The handler reads the **raw body** (`c.req.text()`, then `JSON.parse`) rather than
  `c.req.json()`, so that if confirmation shows HMAC support the upgrade is a local change
  inside one middleware with no route rewrite.
- Failure → `401`, no detail in the body, and the auth middleware is mounted **before** the
  tenant resolver, so a rejected request performs no lookup (spec requires this explicitly).

### D-5: `apps/api` — Hono, the layout `docs/ARCHITECTURE.md` §10 already specifies

```
apps/api/src/
  index.ts                      # bootstrap: import ./env.js, then serve(createApp())
  env.ts                        # fail-loud at import, mirrors packages/db/src/internal/client.ts
  app.ts                        # createApp({ ingest }) — a factory, see below
  routes/health.ts
  routes/webhooks/chatwoot.ts
  middleware/webhook-auth.ts
  middleware/tenant-resolver.ts # sets c.var.brokerId; never guesses
  services/ingest-message.ts    # the D-2/D-3 transaction; no HTTP types cross this line
```

`env.ts` mirrors the house pattern exactly — hand-rolled `readRequired(name)` that throws
at **import time** naming the missing variable, not a lazy getter and not a new Zod
dependency. `DATABASE_URL` is deliberately **not** re-validated here; `@dirus/db` already
fails loud on it at import, and duplicating the check invites the two copies to drift.

**Consequence that must not be discovered during implementation**: because `@dirus/db`
throws at import, anything that transitively imports it cannot be loaded in a test without
a database. `createApp` therefore takes the ingest function as a parameter, so auth,
payload-parsing, and status-code tests run fully offline; only the live suite wires in the
real `services/ingest-message.ts`.

New dependencies: `hono`, `@hono/node-server`, `@dirus/db`, `@dirus/schemas`,
`@dirus/integrations`.

### D-6: Payload schema in `packages/schemas`, two-stage parse, unknown events acknowledged

`packages/schemas/src/webhooks/chatwoot.ts`, re-exported from the barrel. Zod only — the
zero-workspace-dependency rule holds and `apps/jobs` can reuse it.

- **Stage 1 — envelope**: `z.object({ event: z.string() })`, non-strict. Anything whose
  `event` is not `message_created`, or whose `message_type` is not `incoming`, returns
  **200 `{ ignored: true }`** with no database access. 200, not 4xx: Chatwoot retries
  non-2xx, and an event we deliberately ignore is not an error.
- **Stage 2 — message payload**: strict-by-omission. Zod **strips** unknown keys by
  default and `.passthrough()` is forbidden here — that stripping is what mechanically
  satisfies the "Raw Payload Is Not Retained Verbatim" requirement and P2. A malformed
  `message_created` returns 400.
- Marked `@provisional` in its docstring, backed by a committed fixture
  (`packages/schemas/test/fixtures/chatwoot-message-created.json`) derived from Chatwoot's
  documentation, plus a test asserting the fixture parses and that an unknown key does not
  survive parsing. **NEEDS CONFIRMATION** until a real payload is captured.
- **Open and material**: Chatwoot's payload exposes `account`/`inbox`, and it is
  unconfirmed which field carries Meta's `wa_phone_number_id`. The design isolates this:
  a single `extractResolutionKey(payload): string` function is the only place that knows.
  If confirmation shows Chatwoot surfaces only `account.id`, the fallback is
  `brokers.chatwoot_account_id` — already present and already `UNIQUE` — and the change is
  one predicate inside `dirus_resolve_broker_id` plus that one extractor. Nothing in the
  middleware or the route moves.

### D-7: `packages/db` gains exactly one new export, and two docstrings stop being true

```ts
// packages/db/src/tenant-resolution.ts
export async function resolveBrokerIdByWaPhoneNumberId(key: string): Promise<string | null>;
```

Single statement (`select public.dirus_resolve_broker_id($1)`) on the pooled client, no
transaction — there is no tenant context to scope. It returns an opaque `uuid` string or
`null`. It returns no row, no broker column other than `id`, and **no table handle**.
Input is a bound parameter; cap its length to reject pathological input.

Two docstrings currently assert something this export falsifies, and both must be
corrected rather than left stale:

- `src/tenant.ts` — "`TenantDb` … the only tenant-scoped handle callers ever receive"
  becomes: `TenantDb` remains the only handle through which **table** access is possible.
  `resolveBrokerIdByWaPhoneNumberId` is a second, deliberately narrower access class that
  returns an opaque identifier and nothing else. State explicitly that it exists only
  because tenant resolution logically precedes tenant context, and that the pattern must
  not be extended to any call returning row or column data.
- `src/index.ts` — "every query a caller issues goes through the transaction-scoped tenant
  context" is now false as written and must be amended.

The existing barrel-export allowlist test must be updated to expect this export — updated
deliberately, so the addition is a reviewed decision rather than a silent test edit.

## Data Flow

```
Chatwoot ──POST──▶ webhook-auth (D-4)  ──401──▶ ✗ no lookup, no write
                        │ ok
                        ▼
                   envelope parse (D-6) ──not message_created──▶ 200 {ignored}
                        │ incoming message
                        ▼
                   extractResolutionKey ──▶ resolveBrokerIdByWaPhoneNumberId (D-1)
                        │                        │ null
                        │ brokerId               └──▶ 4xx + log(key only, no body) [P4]
                        ▼
       withBrokerContext(brokerId, tx => {          ← one transaction
           contacts   upsert  ON CONFLICT DO UPDATE  RETURNING id   (D-2, serializes)
           conversations find-or-create
           messages   insert  ON CONFLICT DO NOTHING RETURNING id   (D-3)
       })                                            ← COMMIT
                        │
              inserted? ├── no  ──▶ 200 {deduplicated:true}, NO echo
                        └── yes ──▶ Chatwoot echo (fixed ES copy, P1) ──▶ 200
```

## File Changes

| Path | Action | Description |
|---|---|---|
| `packages/db/migrations/0004_tenant_resolver.sql` | Create | D-1: role, `TO`-scoped policy, `SECURITY DEFINER` function, grants. `drizzle-kit generate --custom` |
| `packages/db/src/tenant-resolution.ts` | Create | D-7 lookup |
| `packages/db/src/{index,tenant}.ts` | Modify | New export + the two docstring corrections |
| `packages/db/test/migrations/live-tenant-resolution.test.ts` | Create | D-1's five live assertions |
| `packages/db/test/migrations/rls-catalog-guard.test.ts` | Modify | Membership + `proconfig` + `EXECUTE`-grant guards |
| `packages/schemas/src/webhooks/chatwoot.ts`, `src/index.ts` | Create/Modify | D-6 schema + barrel |
| `packages/schemas/test/fixtures/chatwoot-message-created.json` | Create | Provisional fixture |
| `apps/api/src/**` | Create | D-5 layout |
| `apps/api/package.json` | Modify | `hono`, `@hono/node-server`, workspace deps |
| `packages/integrations/src/chatwoot.ts` | Create | Minimal typed client: send one text reply |
| `.env.example` | Modify | `CHATWOOT_WEBHOOK_TOKEN`, `CHATWOOT_BASE_URL`, `CHATWOOT_API_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID`, `PORT` |
| `openspec/changes/whatsapp-webhook-ingress/specs/data-model/spec.md` | Create | The O2 delta (D-1) |
| `openspec/ROADMAP.md` | Modify | Correct the F2 scope line |

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit (offline) | Auth reject/accept; envelope ignores non-`message_created` with 200; unknown keys stripped; fixture parses | Vitest against `createApp({ ingest: fake })` — no database |
| Structural | Migration 0004 declares `TO dirus_tenant_resolver`, `SECURITY DEFINER`, pinned search_path, `REVOKE ... FROM PUBLIC` | SQL-text assertions, mirroring `rls-policies.test.ts` |
| Catalog | Function owner, `proconfig`, `EXECUTE` grantees, role membership/`INHERIT` | `pg_proc`/`pg_auth_members`/`pg_policy`, extending `rls-catalog-guard.test.ts` |
| **Live — D-1 (gate)** | The five assertions in D-1, negative control included | `LIVE_TEST_DATABASE_URL`, throwaway schema, disposable roles, `assertThrowawayDatabase` |
| Live — idempotency | Sequential replay; **concurrent** replay dispatched without awaiting | Two `pg` clients, both 2xx, exactly one row |
| Live — D-2 concurrency | Two concurrent first messages from one new sender → one `conversations` row | Same harness; this is what makes D-2 legitimate rather than merely plausible |
| Live — isolation (non-negotiable) | Broker X reads none of Y's `messages`/`conversations`/`contacts`, rows created via the ingress path | Two-broker fixture, extending the existing one to `messages`/`conversations` |

## Migration / Rollout

Additive and droppable. Down path must be **scripted, not improvised**, in this order:
`REVOKE EXECUTE` → `DROP FUNCTION` → `DROP POLICY tenant_resolver_lookup ON brokers` →
`REVOKE` the column/schema grants → `REVOKE` the owner's membership → `DROP ROLE`. Dropping
the role before the function it owns will fail. `apps/api` reverts to an empty shell;
Chatwoot POSTs into a 404, which is a stopped ingress, not corruption.

## Open Questions

- [ ] **D-1 is unproven.** No Postgres was reachable in this session; nothing was executed.
      The five live assertions above are the acceptance gate — implementation must not be
      accepted on the strength of this reasoning alone.
- [ ] **NEEDS CONFIRMATION** — which Chatwoot payload field carries `wa_phone_number_id`.
      If none does, the fallback is `brokers.chatwoot_account_id` (D-6). This is the second
      most likely thing to invalidate part of this design.
- [ ] **NEEDS CONFIRMATION** — whether Chatwoot HMAC-signs webhooks (D-4). Until then §11
      is met by a compensating control, stated as such.
- [ ] Should `dirus_resolve_broker_id` filter on `brokers.status = 'active'`? A suspended
      broker currently still resolves. Product call, deliberately not made here.
- [ ] Does the migration role hold `CREATEROLE`? If not, D-1's role creation moves to a
      provisioning script alongside `provision-app-role.sql`, guarded by the same
      `DO`-block existence pattern as `0003`.
