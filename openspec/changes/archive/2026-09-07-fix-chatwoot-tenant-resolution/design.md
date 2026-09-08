# Design: Fix Chatwoot tenant resolution

## Technical Approach

One resolution key, moved end-to-end, integer-typed, in one slice: real captured payload →
schema → `extractResolutionKey()` → `ResolveBrokerId` → `@dirus/db` export → SQL function
+ column grant. Nothing about the F2 security envelope moves. The `dirus_tenant_resolver`
role, the `TO`-scoped `tenant_resolver_lookup` policy, `SECURITY DEFINER`, owner =
resolver role, `SET search_path = ''`, schema-qualified `public.brokers`, bare `uuid`
return, no `status` predicate, `EXECUTE` revoked from `PUBLIC` — all preserved verbatim.
Exactly two things change inside that envelope: **the predicate column** and **the
parameter type**, and one thing changes around it: **which column the resolver role can
read**.

Ordering, and why it is not negotiable: the column-scoped `GRANT` and the function body
must land in the *same* migration. A function that can read the row but not the column it
filters on raises a permissions error that `resolveBrokerId` surfaces as `null` — a
security-relevant failure wearing the costume of a routine unknown-key miss (proposal
Risks, row 1).

This design is written from Postgres semantics plus the catalog behaviour F2 already
proved live. Two of its statements are **NEEDS EMPIRICAL PROOF** and are marked as such at
the point they are made (D-C's `SET ROLE`-to-drop, and the whole of D-G's re-proof set).

## Architecture Decisions

### D-A: The resolution key is `payload.account.id`, and the payload schema is narrowed to what a real payload actually contains

The captured payload (self-hosted Chatwoot, `message_created`, `Channel::Whatsapp`,
captured 2026-09-07) settles F2's O4 empirically:

```jsonc
{
  "account":  { "id": 1, "name": "DIRUS Dev" },     // <- the resolution key lives here
  "inbox":    { "id": 1, "name": "WhatsApp Dev (test)" },  // no phone_number. ever.
  "sender":   { "id": 1, "phone_number": "+573000000000", "name": "Cliente Dev", ... },
  // no top-level "contact" key at all
  "event": "message_created", "message_type": "incoming", "id": 3,
  "content": "...", "content_type": "text", "source_id": null,
  "conversation": { "id": 1, ... }
}
```

Schema changes in `packages/schemas/src/webhooks/chatwoot.ts`:

| Change | Reason |
|---|---|
| `chatwootInboxSchema` becomes `{ id: z.number(), name: z.string().optional() }` | `phone_number` does not exist in a real `inbox`. Keeping it optional would be worse than deleting it: an optional field nobody reads is a field a future reader will assume can be read. |
| Top-level `contact: chatwootContactSchema` is **removed** from `chatwootMessageCreatedPayloadSchema` | Real payloads carry only `sender`. `chatwootContactSchema` itself is deleted — it has no remaining referent. |
| `chatwootAccountSchema` keeps `id: z.number()` (NOT narrowed to `.int().positive().max(...)`) | See D-B: the range guard lives in one place, and that place is `extractResolutionKey`, not the parse. |
| `extractResolutionKey()` returns `number \| null` | Proposal P2 / Success Criteria item 3. |
| Every `@provisional` / "NEEDS CONFIRMATION" marker is removed **only for fields now confirmed against the captured payload** | The module docstring is rewritten to record the capture (instance, event, channel, date) instead of citing the public docs. |

**Consequence the proposal's Affected Areas table misses — flagged here, not discovered
during apply:** `apps/api/src/services/ingest-message.ts:54` reads
`payload.contact.phone_number`. Removing `contact` makes that a compile error. It must
read `payload.sender.phone_number` (same value in the real payload: `+573000000000`), and
its error message ("Chatwoot payload's contact.phone_number is missing…") must be
re-worded to name `sender`. `apps/api/src/services/ingest-message.ts` is therefore **added
to the change's file set**. `pnpm -r typecheck` catches this, which is exactly the
detection class proposal Risk row 5 counted on — this design just names the site in
advance.

Also in the doc-only category: `packages/db/src/tenant.ts`'s `TenantDb`/narrow-access-class
docstring names "a `wa_phone_number_id`" as one of the four things the resolution class
learns a `broker_id` from. It must say `chatwoot_account_id`.

**Fixture.** The captured payload is committed verbatim as
`packages/schemas/test/fixtures/chatwoot-message-created.json`, replacing the
docs-derived invention. **This closes F2 task 4.8** (deferred pending O4) and resolves
O4. Two constraints on the commit: (a) it is committed *unmodified* except for whatever
`pubsub_token` / identifier scrubbing review requires — the value of a real fixture is
that it was not authored; (b) the captured Chatwoot version and capture date go in the
change's task/verify record and in the schema module docstring, so the next shape drift
has a baseline to diff against (proposal Risk row 4).

### D-B: The int4 boundary guard lives in `extractResolutionKey()` — one place, and it returns `null` rather than throwing

Proposal Success Criterion 4 requires that a non-integer, negative, or
out-of-`int4`-range `account.id` be *refused before any query runs*, with no 500. Three
candidate homes:

| Where | Verdict |
|---|---|
| `chatwootAccountSchema`: `z.number().int().positive().max(2147483647)` | **Rejected.** It works, but it makes an out-of-range account id a **stage-2 parse failure** — indistinguishable, at the route, from a malformed payload. It also splits "which field is the key, and what makes it valid" across two places: the schema constraint and `extractResolutionKey`. F2's D-6 bought exactly one thing with `extractResolutionKey` — a *single* isolated point of contact with the key — and this would spend it. |
| A guard inside `resolveBrokerIdByChatwootAccountId` (the `@dirus/db` export) as the *only* home | **Rejected as the primary home.** By the time the value reaches `@dirus/db` it has crossed a package boundary; the db package's only honest failure mode there is to throw, and a throw becomes a 500 unless the route catches it — which is precisely what the criterion forbids. |
| **`extractResolutionKey()`, returning `number \| null`** | **Chosen.** |

```ts
const MAX_INT4 = 2_147_483_647;

/**
 * The single, deliberately isolated point of contact with "which field
 * carries the resolution key" (F2 design D-6, corrected by F2.1 D-A/D-B).
 * Returns `null` — never throws, never a sentinel number — when the key is
 * absent or is not a value `chatwoot_account_id` (a Postgres `integer`)
 * could ever hold.
 */
export function extractResolutionKey(payload: ChatwootMessageCreatedPayload): number | null {
  const id = payload.account?.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > MAX_INT4) {
    return null;
  }
  return id;
}
```

`Number.isInteger` covers `NaN`, `Infinity`, and fractional values in one predicate;
`id < 1` covers zero and negatives (`chatwoot_account_id` is a Postgres identity-style
account id — zero is not a real account); `id > MAX_INT4` is the guard that prevents
Postgres's numeric-overflow error, which without it surfaces as a 500 rather than the
clean refusal the spec requires.

**Route consequence.** `parseAndExtractResolutionKey` in
`apps/api/src/routes/webhooks/chatwoot.ts` gains a `null` branch:

```ts
const resolutionKey = extractResolutionKey(payloadResult.data);
if (resolutionKey === null) {
  return c.json({ error: "invalid payload" }, 400);   // no query issued, no 500
}
c.set("payload", payloadResult.data);
c.set("resolutionKey", resolutionKey);
```

400, not 404: a payload whose `account.id` is not an integer is a malformed payload, not
an unknown tenant. The 404 + `tenant_resolution_miss` log path stays reserved for a
well-formed key that resolves to nothing — the distinction proposal P4 (F2) built that log
line for.

**On the second guard in `@dirus/db` (the redundancy question, answered explicitly).**
`resolveBrokerIdByChatwootAccountId` keeps an integer-range check that **throws**, and
that check is unreachable through the webhook path because D-B already refused those
values. This is deliberate, and the line this project draws is: *a package's public export
validates its own preconditions; a request pipeline validates the request.* `MAX_KEY_LENGTH`
existed for exactly that reason (F2 D-7: "before it is ever sent to Postgres"), and
`@dirus/db` has no idea who imports it — `apps/api` today, a backfill script or an admin
path tomorrow. This is not belt-and-suspenders duplication of a *policy decision* (the two
guards do not encode the same rule: one decides the HTTP response, one protects a package
invariant); it is a two-line precondition on an independently importable boundary. The
cost is one `Number.isInteger` comparison on a path that already makes a network round
trip. Accepted.

Where this project has rejected redundant validation (A1's "one validation layer, at the
edge" stance) the duplicated checks were both *inside the same request pipeline*, where the
second one can only ever be dead code. That is not this case.

### D-C: `dirus_resolve_broker_id(p_account_id integer) RETURNS uuid` — new signature, old one dropped, not deprecated

Final shape (this is the exact function `0007` creates):

```sql
CREATE FUNCTION public.dirus_resolve_broker_id(p_account_id integer) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $$ SELECT id FROM public.brokers WHERE chatwoot_account_id = p_account_id $$;
```

Diff against `0004`'s function, in full: `p_key text` → `p_account_id integer`;
`wa_phone_number_id = p_key` → `chatwoot_account_id = p_account_id`. Nothing else. Same
name (callers, grants, and the catalog assertions all key on it), same `LANGUAGE sql
STABLE`, same `SECURITY DEFINER`, same pinned empty `search_path`, same schema-qualified
`public.brokers`, same bare `uuid`, same absence of any `status` predicate (F2 P5 stands:
a suspended broker still resolves).

**Why `integer` and not `text` with a cast** — settled in proposal P2; restated here only
for the part that is a *design* consequence: `chatwoot_account_id::text = p_key` cannot
use the existing `UNIQUE` index (`0000_init.sql:21`), turning a security-critical,
per-webhook lookup into a sequential scan over a table that grows with every broker
onboarded. The integer parameter matches the index directly.

**Why the old `(text)` function is dropped, and what could block the drop.** P1: no second
path. `CREATE OR REPLACE` is unavailable across a parameter-type change (Postgres treats
it as a distinct function, so `CREATE OR REPLACE` would *add an overload* rather than
replace anything) — leaving a still-`EXECUTE`-granted, permanently-broken resolution path
in the catalog. Dependency check before the drop:

- The `EXECUTE` grant to `dirus_app` is a privilege on the function, dropped with it. It
  does not block the drop.
- Nothing else references it: no view, no index, no default expression, no policy, no
  generated column, no other function body. The only caller is
  `packages/db/src/tenant-resolution.ts`, which is application code, not a catalog
  dependency.
- Therefore `DROP FUNCTION` is issued **without `CASCADE`** and **without `IF EXISTS`**,
  deliberately. No `CASCADE`: if some dependent object *does* exist that this analysis
  missed, the migration must fail loudly rather than silently drop it. No `IF EXISTS`: a
  catalog where `dirus_resolve_broker_id(text)` is absent before `0007` runs is a catalog
  that diverged from the migration history, and that deserves a failure, not a shrug.

**The ownership trap — NEEDS EMPIRICAL PROOF.** The function is owned by
`dirus_tenant_resolver`, and `DROP FUNCTION` requires ownership. Postgres's ownership
check is `has_privs_of_role(GetUserId(), proowner)`, which follows `INHERIT` — and `0004`
granted the membership `WITH INHERIT FALSE` precisely so it confers no standing privilege.
So a **non-superuser** migration role (every real Neon connection) cannot drop this
function directly, while a **superuser** (CI's ephemeral container) can. This is the same
asymmetry that hid `0004`'s `CREATE ON SCHEMA` gap until it hit a real Neon migration —
CI will not catch it. The fix, and the reason it is safe:

```sql
GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;
SET ROLE dirus_tenant_resolver;
DROP FUNCTION public.dirus_resolve_broker_id(text);
RESET ROLE;
```

`WITH INHERIT FALSE` still permits `SET ROLE` (the `SET` option defaults to `TRUE` in
PG16+), and `SET ROLE` to a `NOLOGIN` role is legal — `NOLOGIN` blocks connection, not
role assumption. The explicitly rejected alternative is re-granting the membership `WITH
INHERIT TRUE` for the duration: an inheriting membership makes `tenant_resolver_lookup`
apply to the migration role's own session (F2 D-1's failure mode 1), and a migration that
fails between the grant and the revoke leaves that hole behind permanently. `SET ROLE` is
scoped to the session and reverts on disconnect even if the migration aborts.

The membership `GRANT` is re-issued at the top of `0007` rather than assumed, because
`0007` may be applied by a different role than the one that applied `0004` (a fresh clone
applies the whole sequence as one role; a deployed database may not).

**This must be proven against a non-superuser role**, not only against CI. The live suite
(D-G) applies `0007` as `admin` (superuser), so it will pass regardless — the proof is a
real apply against the Neon dev project, recorded in the verify report.

### D-D: `0007_chatwoot_account_resolution.sql` — the exact statement sequence, and why this order

`0006_broker_auth.sql` is confirmed the highest migration number (proposal Risk row 6);
`0007` is next. `0004_tenant_resolver.sql` is **not touched** — it has been applied to a
real database and must stay byte-identical to its archived state (P3, Success Criteria
item 11). Style follows `0006` exactly: reasoning-dense comments above each block, the
`pg_roles` existence guard for the `dirus_app` grant, `--> statement-breakpoint` between
blocks, and a commented (not scripted) down path at the end.

**Order, with the reason each step is where it is:**

1. **Membership grant** — `GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;`
   First, because both step 2 (`SET ROLE` to drop) and step 4 (`ALTER FUNCTION … OWNER TO`)
   depend on it, and neither should discover it is missing halfway through.

2. **Drop the old `(text)` signature** — `SET ROLE` / `DROP FUNCTION` / `RESET ROLE` per
   D-C. Before the create, not after: the catalog is never in a state where two
   `dirus_resolve_broker_id` overloads exist. That matters beyond tidiness — with both
   present, an unadorned `SELECT dirus_resolve_broker_id('1')` (a quoted literal, as a
   psql session or an old test would write it) resolves to the `text` overload by
   preference and silently returns `NULL`, which is P1's "broken path still reachable"
   exactly.

3. **Create the new `(integer)` function** — the body from D-C, full envelope preserved.
   After the drop, before any grant, because every grant below names the signature.

4. **Transfer ownership** — `GRANT CREATE ON SCHEMA public TO dirus_tenant_resolver;` /
   `ALTER FUNCTION public.dirus_resolve_broker_id(integer) OWNER TO dirus_tenant_resolver;`
   / `REVOKE CREATE ON SCHEMA public FROM dirus_tenant_resolver;`. The temporary `CREATE`
   bracket is `0004`/`0006`'s documented workaround for Postgres requiring the *new* owner
   to hold `CREATE` on the schema at the moment of transfer; it is copied verbatim,
   including the immediate revoke that returns the role to its documented minimal
   privilege set (`USAGE` only).

5. **`EXECUTE` privileges** — `REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(integer)
   FROM PUBLIC;` then, inside the `DO $$ … IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname
   = 'dirus_app') …` guard, `GRANT EXECUTE … TO dirus_app;`. Revoke strictly before grant
   (functions grant `EXECUTE` to `PUBLIC` by default — the `REVOKE` is load-bearing), and
   the grant stays behind the `pg_roles` guard so a fresh clone where `dirus_app` is not
   yet provisioned still migrates cleanly (`0003`/`0004`/`0006`'s shared pattern).

6. **Move the column-scoped `SELECT` grant** — in this order:

   ```sql
   GRANT  SELECT (id, chatwoot_account_id) ON public.brokers TO   dirus_tenant_resolver;
   REVOKE SELECT (wa_phone_number_id)      ON public.brokers FROM dirus_tenant_resolver;
   ```

   **Same migration as the function change — mandatory, per P3 and proposal Risk row 1.**
   If the function ships without the grant, it filters on a column the resolver role cannot
   read; Postgres raises `permission denied for column chatwoot_account_id`, which
   `resolveBrokerIdByChatwootAccountId` cannot distinguish from an empty result and reports
   as `null`, which the middleware reports as a routine `tenant_resolution_miss`. A
   permissions defect wearing a miss's clothing is the worst possible failure shape for
   this component, and the only structural defense is atomicity.

   Grant-new-before-revoke-old, not the reverse: the migration runner's transaction
   boundary per statement chunk is not something this design will assume, so the sequence
   is written so that at no intermediate point can the resolver role read *neither*
   column. `GRANT SELECT (id, chatwoot_account_id)` is additive to the existing
   `(id, wa_phone_number_id)` grant, so the intermediate state is a strict superset;
   the `REVOKE` then narrows it to exactly what Success Criteria item 10 requires.
   `id` is re-granted rather than assumed — column grants are per-column and re-granting
   an already-held column privilege is a no-op, so this is stated explicitly rather than
   depending on the reader remembering `0004` line 25.

   `wa_phone_number_id` is revoked, not left in place: after `0007` the resolver role has
   no reason to see it, and Success Criteria item 10 asserts it is unreachable through
   that role. The **column** stays on `brokers` (proposal Out of Scope) — only the
   resolver role's reach into it is removed.

   Not touched: the `dirus_tenant_resolver` role itself, the `tenant_resolver_lookup`
   policy (`TO`-scoped, not column-scoped), `tenant_isolation`, and every table-level
   grant. No table structure changes; no new constraint — `chatwoot_account_id` is already
   `UNIQUE` and indexed.

7. **Down path, commented, not scripted** — matching `0004`/`0006`'s convention (this
   migration sequence has no down-migration runner). Order is load-bearing and mirrors the
   up path in reverse:

   ```
   --   GRANT  SELECT (id, wa_phone_number_id)   ON public.brokers TO   dirus_tenant_resolver;
   --   REVOKE SELECT (chatwoot_account_id)      ON public.brokers FROM dirus_tenant_resolver;
   --   REVOKE EXECUTE ON FUNCTION public.dirus_resolve_broker_id(integer) FROM dirus_app;
   --   SET ROLE dirus_tenant_resolver;
   --   DROP FUNCTION public.dirus_resolve_broker_id(integer);
   --   RESET ROLE;
   --   CREATE FUNCTION public.dirus_resolve_broker_id(p_key text) RETURNS uuid
   --     LANGUAGE sql STABLE SECURITY DEFINER
   --     SET search_path = ''
   --   AS $$ SELECT id FROM public.brokers WHERE wa_phone_number_id = p_key $$;
   --   GRANT CREATE ON SCHEMA public TO dirus_tenant_resolver;
   --   ALTER FUNCTION public.dirus_resolve_broker_id(text) OWNER TO dirus_tenant_resolver;
   --   REVOKE CREATE ON SCHEMA public FROM dirus_tenant_resolver;
   --   REVOKE ALL ON FUNCTION public.dirus_resolve_broker_id(text) FROM PUBLIC;
   --   GRANT EXECUTE ON FUNCTION public.dirus_resolve_broker_id(text) TO dirus_app;
   ```

   The comment block carries the caveat verbatim from the proposal's Rollback Plan, and
   `sdd-apply` must not soften it: **this down path restores a state that has never
   accepted a single real Chatwoot webhook.** It is a way to un-break something else this
   change touched, not a way to restore working ingress. `0007` writes and migrates no
   data, so there is nothing to un-migrate.

### D-E: TypeScript surface — one rename, one retype, one wiring line

`packages/db/src/tenant-resolution.ts`:

```ts
const MIN_ACCOUNT_ID = 1;
const MAX_ACCOUNT_ID = 2_147_483_647; // int4 upper bound — chatwoot_account_id is `integer`

export async function resolveBrokerIdByChatwootAccountId(accountId: number): Promise<string | null> {
  if (!Number.isInteger(accountId) || accountId < MIN_ACCOUNT_ID || accountId > MAX_ACCOUNT_ID) {
    throw new Error(
      `chatwoot_account_id must be an integer in [${MIN_ACCOUNT_ID}, ${MAX_ACCOUNT_ID}] ` +
        `(received ${accountId}). Refusing to query.`,
    );
  }

  const result = await db.execute<{ dirus_resolve_broker_id: string | null }>(
    sql`select public.dirus_resolve_broker_id(${accountId})`,
  );

  return result.rows[0]?.dirus_resolve_broker_id ?? null;
}
```

**The name.** `resolveBrokerIdByChatwootAccountId` — chosen over
`resolveBrokerIdByAccountId` (ambiguous: this codebase has broker accounts, Chatwoot
accounts, and Meta accounts) and over the channel-neutral `resolveBrokerIdForWebhook`
(P1 rejects speculative channel abstraction; a name that hides which key it uses is the
same mistake `resolveBrokerIdByWaPhoneNumberId` made, one level up). It matches the
sibling exports' `resolveBrokerIdBy<Key>` shape exactly
(`…ByEmail`, `…ByMagicLinkTokenHash`, `…BySession`). The old name is **deleted**, not
aliased — an alias is the "second path" P1 forbids, wearing a TypeScript costume.

`MAX_KEY_LENGTH` and its docstring are deleted, not adapted. An integer-range check is a
strictly stronger validation than a length cap, so nothing is lost (proposal P2).

Note for `sdd-apply`: `${accountId}` through Drizzle's `sql` tag is still a **bound
parameter**, not interpolation — the parameter is now sent with a numeric type, which is
what lets Postgres resolve the `(integer)` overload without a cast.

`apps/api/src/middleware/tenant-resolver.ts`:

```ts
export type ResolveBrokerId = (accountId: number) => Promise<string | null>;

export type TenantResolverVariables = {
  /** Chatwoot `account.id`, from `extractResolutionKey` (F2 design D-6, corrected by F2.1 D-A). */
  resolutionKey: number;
  /** Set by this middleware on success — never guessed or defaulted. */
  brokerId: string;
};
```

and the miss log's field name changes with the key it carries:

```ts
console.error("tenant_resolution_miss", { chatwoot_account_id: key });
```

The event name `tenant_resolution_miss` is **unchanged** — it is the operational contract
F2 P4 established, and any dashboard or alert keyed on it must keep working across this
fix. Only the structured field's name changes, and it still carries exactly one field:
never the message body, sender name, or any other payload content. That invariant is why
the field is written as a separate structured argument rather than concatenated, and it
survives this change untouched.

`apps/api/src/index.ts`: the import and the wiring line both change name; the shape does
not.

```ts
import { …, resolveBrokerIdByChatwootAccountId, … } from "@dirus/db";
…
const app = createApp({
  ingest: ingestMessage,
  resolveBrokerId: resolveBrokerIdByChatwootAccountId,
  …
});
```

Because `ResolveBrokerId` is `(accountId: number) => …` and `resolutionKey` is now
`number`, every fake resolver in `apps/api`'s tests becomes a compile error until updated
— the detection mechanism proposal Risk row 5 relies on. The barrel docstring in
`packages/db/src/index.ts` and the narrow-access-class docstring in
`packages/db/src/tenant.ts` both name the old function/key and must be updated with it.

### D-F: Data flow after the fix

```
Chatwoot (self-hosted, infra/chatwoot/)
  │  POST /webhooks/chatwoot[/:token]   {account:{id:1}, inbox:{id,name}, sender:{…}, …}
  ▼
webhook-auth middleware ───────────── 401 (short-circuit, nothing else runs)
  ▼
stage-1 envelope parse ────────────── 200 {ignored:true}  (not message_created/incoming)
  ▼
stage-2 payload parse ─────────────── 400 {error:"invalid payload"}  (malformed shape)
  ▼
extractResolutionKey(payload) → number | null
  │                              └──── 400 {error:"invalid payload"}   [D-B]
  │                                    NO query issued, NO 500
  ▼ accountId: number
tenant-resolver middleware
  └─ resolveBrokerIdByChatwootAccountId(accountId)
       └─ SELECT public.dirus_resolve_broker_id($1::integer)     [SECURITY DEFINER]
            └─ SELECT id FROM public.brokers WHERE chatwoot_account_id = $1
                 (runs as dirus_tenant_resolver; tenant_resolver_lookup applies;
                  reads only columns (id, chatwoot_account_id))
  │  null ──────────────────────────── 404 + console.error("tenant_resolution_miss",
  │                                            { chatwoot_account_id }) — no message content
  ▼ brokerId: uuid
ingest(brokerId, payload)  ─ withBrokerContext transaction (contacts→conversation→messages)
  │  reads payload.sender.phone_number  [D-A: was payload.contact.phone_number]
  ▼ commit
echo (only when deduplicated === false)
```

The failure ordering F2 established is intact: authenticate → parse → extract → resolve →
transact → commit → echo, and no step is reachable by skipping the one before it.

### D-G: Test rework — what is mechanical re-keying and what is genuinely structural

**`packages/db/test/migrations/live-tenant-resolution.test.ts` — mechanically re-keyable
in structure, but with three specific edits that are NOT search-and-replace.** Every
control keeps its identity, its ordering, and its discriminating power; the *seeds* and
*call literals* move columns. Read control-by-control (the count after MUST be ≥ the count
before — proposal Risk row 2):

| Control | Verdict |
|---|---|
| Fixture setup (`beforeAll`) | **Mechanical + one addition.** Apply `0007` after `0004` (`await admin.query(readMigration("0007_chatwoot_account_resolution.sql"))`). Seeds gain `chatwoot_account_id`: Broker A → `1001`, Broker S (suspended) → `1002`. `wa_phone_number_id` stays populated on both — it is still a real column, and leaving it set proves the resolver no longer *uses* it. |
| 1. positive | Mechanical. `dirus_resolve_broker_id('phoneA')` → `dirus_resolve_broker_id(1001)`. |
| 2. negative control | Mechanical (call literal only). The `count(*) = 0` / `SELECT *` assertions are untouched — they are about the policy, not the key. |
| 3. miss | Mechanical. `'unknown'` → `999999` (an unused, in-range account id). |
| 4. owner control | Mechanical. The inline `owner_owned_probe` body must be re-keyed to `(p_account_id integer)` / `chatwoot_account_id` so it stays a true mirror of the real function; a probe still keyed on `wa_phone_number_id` would test a different function than the one shipped. |
| 5. membership guard | **Untouched.** Key-independent. |
| suspended broker still resolves (P5) | Mechanical. `'phoneS'` → `1002`. |
| search_path hijack | Mechanical, and the comment must change: the temp `brokers (id uuid)` has no `chatwoot_account_id` column (previously: no `wa_phone_number_id`) — same mechanism, updated wording. |
| catalog: `proconfig` pinned | **Untouched.** |
| catalog: SECURITY DEFINER / owner / bare `uuid` | **Untouched.** |
| catalog: EXECUTE revoked from PUBLIC, granted to `dirus_app` | **Signature string changes** — `'dirus_resolve_broker_id(text)'` → `'dirus_resolve_broker_id(integer)'` in both `has_function_privilege` calls. Note this is exactly where a stale string fails silently-ish: `has_function_privilege` on a non-existent signature *errors*, so a missed edit fails loudly. Good. |
| catalog: `tenant_resolver_lookup` `TO` clause | **Untouched.** |
| catalog: `tenant_isolation` unchanged, exactly 2 policies | **Untouched.** |
| MUTATION: dropping the `TO` clause reopens `brokers` | **Untouched.** Key-independent — it never calls the function. |
| MUTATION: inheriting membership is caught | **Untouched.** |
| `2.7` block (the exported function itself) | **Structural, small.** Import name changes to `resolveBrokerIdByChatwootAccountId`; "resolves a known key" → `(1001)`; "unknown key returns null" → `(999999)`; and **"rejects a pathological (over-length) key"** is *replaced*, not re-keyed — there is no over-length integer. Its successor is a table-driven case asserting `2_147_483_648`, `-1`, `0`, and `1.5` each reject before any query reaches Postgres. That is the D-E guard's proof. |

**Two controls this design ADDS to that file** (so the after-count exceeds the
before-count, and so the grant risk has a live detector):

1. **Grant-miss detector** — assert a *known* account id resolves non-`NULL` after `0007`
   (this is control 1, and proposal Risk row 1 explicitly names it as the mitigation:
   with the column grant missing, this fails loudly with a permissions error instead of
   quietly returning `NULL`).
2. **Old signature is gone** — assert `SELECT count(*) FROM pg_proc WHERE proname =
   'dirus_resolve_broker_id'` is exactly `1`, and that its single argument type is
   `int4`. Success Criteria item 9. A `has_function_privilege('…(text)', …)` call would
   error rather than return `false`, so the assertion is written against `pg_proc`
   directly.

Also note: the existing catalog assertions query `pg_proc WHERE proname =
'dirus_resolve_broker_id'` and read `rows[0]` — correct only while exactly one function
carries that name. Addition 2 above is what keeps that assumption honest, and it is why
step 2 of D-D drops before it creates.

**`packages/db/test/migrations/tenant-resolver-migration.test.ts` — structural.** It is a
literal-SQL assertion suite bound to `0004`'s text, and `0004` is now immutable. Two
options were considered:

| Option | Verdict |
|---|---|
| Rewrite this file's assertions to read `0007` | **Rejected.** `0004` still exists, is still applied, and its role/policy/ownership declarations are still the live contract. Deleting its text assertions to make room for `0007`'s would lose coverage of statements that did not change. |
| **Keep this file asserting `0004` verbatim (it must not change — Success Criteria item 11 says `0004` is byte-identical, and this file is what proves it); add a sibling `chatwoot-account-resolution-migration.test.ts` asserting `0007`** | **Chosen.** |

The one edit the existing file *does* need: its assertions that the function's live shape
is `(p_key text)` / `wa_phone_number_id` are now assertions about a **superseded**
statement. They stay (they still correctly describe `0004`'s text), but the file's
docstring must say so explicitly — "this asserts what `0004` declares; `0007` supersedes
the function it creates, see `chatwoot-account-resolution-migration.test.ts`" — or the next
reader will conclude the resolver still keys on `wa_phone_number_id`. That is a docstring
change, not an assertion change, and `0004`'s bytes remain untouched.

The new sibling mirrors this file's shape for `0007`: drop-before-create ordering,
`(p_account_id integer) RETURNS uuid`, `SECURITY DEFINER` + `SET search_path = ''`,
schema-qualified `public.brokers` in the body, no `status` in the body, `RETURNS uuid` and
not `TABLE`/`SETOF`/`record`, `REVOKE` before `GRANT EXECUTE`, the `pg_roles` guard, the
`GRANT SELECT (id, chatwoot_account_id)` / `REVOKE SELECT (wa_phone_number_id)` pair
present in **this same file**, and the down-path comment ordering.

**`packages/schemas/test/chatwoot.test.ts` and
`chatwoot-resolution-key-isolation.test.ts` — structural.** The former's fixtures are all
built on the invented shape; it gains the negative case Success Criterion 2 requires (a
payload carrying `inbox.phone_number` + top-level `contact` must **not** parse as a valid
key source — the defect cannot silently return) and the D-B boundary cases
(`null` return for absent / fractional / negative / out-of-int4 `account.id`). The latter
exists to prove no module reads the key field directly; its *mechanism* is unchanged, but
the string it forbids becomes `account.id`-shaped rather than `inbox.phone_number`-shaped.

**`apps/api/test/routes/webhooks/chatwoot.test.ts` — structural**, because its payload
fixtures and its fake resolvers both change type. **`apps/api/test/live/webhook-ingress.live.test.ts`
— structural**, same reasons plus the real end-to-end key.

**Status: NEEDS EMPIRICAL PROOF.** No Postgres was reachable from this design session.
Nothing above about `SET ROLE`-as-owner (D-C), the `(integer)` overload resolution through
Drizzle's bound parameter (D-E), or the column-grant behaviour (D-D step 6) has been
executed. The acceptance gate is the re-run of every control in the table above, against a
live database, on the new column — plus one real webhook POST from the running
`infra/chatwoot/` instance resolving the correct broker and persisting exactly one
`messages` row. That last one is the evidence class F2 never had, and it is the whole
reason this change exists.

## File Changes

| File | Change |
|---|---|
| `packages/db/migrations/0007_chatwoot_account_resolution.sql` | **New.** D-D's seven-step sequence. |
| `packages/db/migrations/0004_tenant_resolver.sql` | **Untouched — byte-identical.** |
| `packages/db/src/tenant-resolution.ts` | Rename + integer parameter + integer-range guard; `MAX_KEY_LENGTH` deleted (D-E). |
| `packages/db/src/index.ts`, `packages/db/src/tenant.ts` | Docstrings naming the old export/key (D-A, D-E). |
| `packages/db/test/migrations/live-tenant-resolution.test.ts` | Re-keyed control-by-control + 2 added controls (D-G). |
| `packages/db/test/migrations/tenant-resolver-migration.test.ts` | Docstring only; assertions stay on `0004` (D-G). |
| `packages/db/test/migrations/chatwoot-account-resolution-migration.test.ts` | **New.** Literal-SQL assertions for `0007` (D-G). |
| `packages/schemas/src/webhooks/chatwoot.ts` | Schema narrowing + `extractResolutionKey` → `number \| null` (D-A, D-B). |
| `packages/schemas/test/fixtures/chatwoot-message-created.json` | **Replaced with the real captured payload** — closes F2 task 4.8 / O4 (D-A). |
| `packages/schemas/test/chatwoot.test.ts`, `…/chatwoot-resolution-key-isolation.test.ts` | Structural (D-G). |
| `apps/api/src/middleware/tenant-resolver.ts` | `ResolveBrokerId`, `resolutionKey: number`, log field (D-E). |
| `apps/api/src/routes/webhooks/chatwoot.ts` | `null`-key 400 branch + doc comments (D-B). |
| `apps/api/src/services/ingest-message.ts` | **Added to scope** — `payload.contact` → `payload.sender` (D-A). |
| `apps/api/src/index.ts` | Import + wiring rename (D-E). |
| `apps/api/test/routes/webhooks/chatwoot.test.ts`, `apps/api/test/live/webhook-ingress.live.test.ts` | Structural (D-G). |

## Migration / Rollout

Forward-only. Apply `0007` before deploying the `apps/api` change — the new function
exists alongside the old TS export for the duration of the deploy, and the old TS export
calling a dropped `(text)` signature would error rather than silently mis-resolve. That
ordering means a brief window where ingress is broken in a *new* way (function-not-found),
which is strictly no worse than the current state: ingress does not work at all today.
Confirm `brokers.chatwoot_account_id` is populated for the live pilot broker before
declaring the change done (proposal Risk row 3) — an unpopulated column produces the same
400/404 symptom for a different reason, and the `tenant_resolution_miss` log line is what
makes that visible.

## Open Questions

None blocking. The one unresolved empirical question — whether a non-superuser migration
role can drop the resolver-owned function via `SET ROLE` (D-C) — has a designed answer and
a designated proof; if it fails against Neon, the fallback is to perform the drop as the
Neon project's owner role in a documented one-off, and `0007` must then be re-shaped, not
worked around silently.
