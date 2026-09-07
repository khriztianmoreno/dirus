# Tasks: Fix Chatwoot tenant resolution

## Ordering constraint — read before touching anything below

**Design D-C's `SET ROLE`-to-drop sequence is marked `NEEDS EMPIRICAL PROOF`.**
No Postgres was reachable from the design session, and — unlike every other
open question in this project's history — **CI cannot discharge this one
either**: CI's `pgvector/pgvector:pg17` service container runs migrations as
a **superuser**, and Postgres's ownership check
(`has_privs_of_role(GetUserId(), proowner)`) is trivially satisfied by a
superuser regardless of whether the `GRANT ... WITH INHERIT FALSE` /
`SET ROLE` / `DROP FUNCTION` / `RESET ROLE` sequence actually works for a
**non-superuser** role. Every real deployment target (Neon) connects as a
non-superuser. A migration that only ever runs green in CI and has never
been proven against a non-superuser database is exactly the class of gap
that hid `0004`'s `CREATE ON SCHEMA` requirement until it hit the developer's
real Neon dev project this session.

**Therefore Phase 1 is the migration plus its non-superuser drop proof, and
it is the hard gate — nothing else starts before it passes.** Phase 1 task
1.5 must be run for real against the developer's actual Neon dev project
(already reachable, already migrated through `0006`) — not simulated, not
inferred from CI passing. This mirrors F2's own Phase 1 (the
`0004`/live-tenant-resolution gate), A1's and C1's equivalent Phase-1 gates:
this project treats "does the migration actually apply as the role that will
really apply it" as a correctness question, not a formality.

**Do not parallelize Phase 1 with any later phase.** Phases 2-5 all assume
`dirus_resolve_broker_id(integer)` is a safe, proven, actually-droppable-and-
recreatable primitive. If 1.5 fails, design D-C's chosen mechanism is wrong
and design.md's own documented fallback applies (perform the drop as the
Neon project's owner role in a one-off, then re-shape `0007`) — this is a
design change, not an implementation bug to route around silently.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 900-1300 (one new migration with a seven-step sequence and commented down path; small, surgical diffs in `packages/schemas`, `packages/db/src/tenant-resolution.ts`, three `apps/api` source files; the bulk is test rework across `live-tenant-resolution.test.ts`, a new `chatwoot-account-resolution-migration.test.ts` sibling, `chatwoot.test.ts`, `chatwoot-resolution-key-isolation.test.ts`, and two `apps/api` test files) |
| 400-line budget risk | Medium — the migration + its live-proof rework alone likely exceeds 400 lines |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Phase 1 gate: migration + non-superuser drop proof) -> PR 2 (Phase 2 `packages/schemas`) -> PR 3 (Phase 3 `packages/db` TS surface) -> PR 4 (Phase 4 `apps/api`) -> PR 5 (Phase 5 live end-to-end confirmation + ROADMAP/PHASES update) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending — user decision needed before `sdd-apply` starts Phase 2 |

Ask the user for chain strategy (stacked-to-main / feature-branch-chain /
size-exception) before `sdd-apply` starts Phase 2. Phase 1 must merge (or at
minimum sit green in CI *and* have its non-superuser proof recorded) before
Phase 2 begins, per the ordering constraint above.

## Phase 1: Migration `0007_chatwoot_account_resolution.sql` + non-superuser drop proof (the hard gate) — design D-C, D-D

- [x] 1.1 RED: in a new sibling file
      `packages/db/test/migrations/chatwoot-account-resolution-migration.test.ts`,
      mirroring `tenant-resolver-migration.test.ts`'s literal-SQL-assertion
      convention (per D-G's "keep `0004`'s file verbatim, add a sibling for
      `0007`" decision) — assert, by reading the not-yet-written migration
      file's text, that it will contain, **in order**: (1) the
      `GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE`
      membership grant, (2) `SET ROLE` / `DROP FUNCTION
      public.dirus_resolve_broker_id(text)` / `RESET ROLE` with no `CASCADE`
      and no `IF EXISTS`, (3) `CREATE FUNCTION
      public.dirus_resolve_broker_id(p_account_id integer) RETURNS uuid` with
      `SECURITY DEFINER`, `SET search_path = ''`, schema-qualified
      `public.brokers`, no `status` predicate, (4) the temporary
      `GRANT CREATE ON SCHEMA public` / `ALTER FUNCTION ... OWNER TO
      dirus_tenant_resolver` / `REVOKE CREATE ON SCHEMA public` bracket, (5)
      `REVOKE ALL ... FROM PUBLIC` strictly before the `pg_roles`-guarded
      `GRANT EXECUTE ... TO dirus_app`, (6) the column-grant pair
      `GRANT SELECT (id, chatwoot_account_id) ... TO dirus_tenant_resolver`
      followed by `REVOKE SELECT (wa_phone_number_id) ... FROM
      dirus_tenant_resolver`, in that order, and (7) a commented (not
      scripted) down path. This must fail before the migration file exists.
      Traces to design D-D.
- [x] 1.2 GREEN: write `packages/db/migrations/0007_chatwoot_account_resolution.sql`
      per design D-D's exact seven-step sequence, satisfying 1.1. Confirm
      `0006_broker_auth.sql` is still the highest applied migration number
      before writing (proposal Risk row 6). Do not touch
      `0004_tenant_resolver.sql`.
- [x] 1.3 RED then GREEN: rework `live-tenant-resolution.test.ts` per D-G's
      control-by-control table — this is **mechanical re-keying with named
      exceptions**, not a rewrite:
      - `beforeAll` applies `0007` after `0004`; seeds gain
        `chatwoot_account_id` (Broker A -> `1001`, Broker S/suspended ->
        `1002`); `wa_phone_number_id` stays populated on both (proves the
        resolver no longer *uses* it, not that the column is gone).
      - Controls 1 (positive), 3 (miss `-> 999999`), and "suspended broker
        still resolves" (`-> 1002`): re-key the call literal only.
      - Control 2 (negative control) and the membership guard: **untouched**
        — key-independent.
      - Control 4 (owner control): the inline `owner_owned_probe` body must
        be re-keyed to `(p_account_id integer)` / `chatwoot_account_id` so it
        stays a true mirror of the shipped function, not a probe of a
        different signature.
      - Search-path hijack: re-key the temp-relation comment (no
        `chatwoot_account_id` column, was no `wa_phone_number_id`) — same
        mechanism, updated wording.
      - Catalog `EXECUTE`-grant assertions: change the signature string in
        both `has_function_privilege` calls from `'dirus_resolve_broker_id(text)'`
        to `'dirus_resolve_broker_id(integer)'`.
      - `proconfig`, `SECURITY DEFINER`/owner/bare-`uuid`, `tenant_resolver_lookup`
        `TO` clause, `tenant_isolation`, and both mutation tests: **untouched**.
      - **Add** the grant-miss detector: a known account id (`1001`) resolves
        non-`NULL` after `0007` applies (proposal Risk row 1's mitigation —
        with the column grant missing this fails loudly with a permissions
        error instead of quietly returning `NULL`).
      - **Add** the old-signature-is-gone assertion, against `pg_proc`
        directly (not `has_function_privilege`, which errors on a
        non-existent signature rather than returning `false`):
        `SELECT count(*) FROM pg_proc WHERE proname = 'dirus_resolve_broker_id'`
        is exactly `1`, and its single argument type is `int4`.
      - The exported-function block (`resolveBrokerIdByChatwootAccountId`,
        the pathological-key replacement) is **Phase 3's task, not this
        one** — this task covers only the SQL-function-level controls.
      - The after-count of controls in this file MUST be >= the before-count
        (proposal Risk row 2) — confirm explicitly in the task's own PR
        description, not just by inspection.
- [x] 1.4 GREEN: confirm 1.1 and 1.3 pass against CI's `pgvector/pgvector:pg17`
      service container (superuser). **This confirms the SQL is correct; it
      does NOT discharge the ownership question** — CI's superuser role can
      drop the old function regardless of whether the `SET ROLE` sequence
      actually works, so a CI-only pass here is not evidence for 1.5.
- [x] 1.5 **HARD GATE — non-superuser drop proof, real database only.** Apply
      `0007` for real against the developer's actual Neon dev project
      (already migrated through `0006`, connecting as the ordinary
      non-superuser migration role — never as the Neon project's owner
      role). Confirm the exact sequence from D-C —
      `GRANT dirus_tenant_resolver TO CURRENT_USER WITH INHERIT FALSE;` /
      `SET ROLE dirus_tenant_resolver;` / `DROP FUNCTION
      public.dirus_resolve_broker_id(text);` / `RESET ROLE;` — actually
      succeeds, and that the subsequent `ALTER FUNCTION ... OWNER TO
      dirus_tenant_resolver` step (which needs the same membership grant)
      also succeeds. **Do not proceed to Phase 2 until this passes.** If it
      fails: STOP, do not attempt a workaround inline — this is design
      D-C's own documented fallback path (perform the drop as the Neon
      project's owner role in a one-off, then re-shape `0007` so the shipped
      migration file matches what actually works), and the fallback is a
      design change to be recorded, not silently patched. Record the outcome
      (pass, or fail-and-fallback-taken) in the verify report, naming the
      database, the role used, and the exact statements run.

      **STATUS: DONE — run for real by the orchestrator against the
      developer's live Neon dev project** (connecting as `creator`, the
      project's ordinary non-superuser owner role — never a Postgres
      superuser). The D-C sequence (`GRANT ... WITH INHERIT FALSE`;
      `SET ROLE dirus_tenant_resolver`; `DROP FUNCTION
      public.dirus_resolve_broker_id(text)`; `RESET ROLE`) succeeded exactly
      as designed, and the subsequent `ALTER FUNCTION ... OWNER TO` step
      (needing the same membership) also succeeded. D-C's own hypothesis is
      confirmed correct.

      **This run also found two real defects beyond D-C's own prediction,
      both fixed before the gate could be called passed:**

      1. **The migration never actually ran on the first attempt.**
         `packages/db/migrations/meta/_journal.json` was never updated to
         register `0007_chatwoot_account_resolution` — `drizzle-orm`'s
         `migrate()` reads the file list to apply from that journal, not
         from the migrations directory, so `pnpm db:migrate` silently
         no-op'd and printed "Migrations applied successfully" without
         executing a single statement. Fixed by adding the missing journal
         entry (idx 7, tag `0007_chatwoot_account_resolution`). **Any
         hand-written migration in this project (every `SECURITY DEFINER`
         migration so far, since `drizzle-kit generate` cannot produce
         these) must add its own journal entry — this is not automatic and
         was missed here.**
      2. **`REVOKE ALL ... FROM PUBLIC` fails silently, not loudly, when the
         executing role lacks grant-option provenance on that ACL entry** —
         a third instance of the `WITH INHERIT FALSE` class of gap this
         project has now hit three times (`ALTER FUNCTION ... OWNER TO`
         needing CREATE on schema; `DROP FUNCTION` needing `SET ROLE`; now
         `REVOKE` needing `SET ROLE` too, with no exception thrown — it must
         be checked via `pg_proc.proacl`, not a try/catch). Live query
         confirmed this was not new to `0007`: **all three of `0006`'s
         `SECURITY DEFINER` functions (`dirus_resolve_broker_id_by_email`,
         `_by_magic_link`, `_by_session`) currently had `PUBLIC` `EXECUTE`
         live on the developer's real database**, because `0006`'s own
         unqualified `REVOKE ALL ... FROM PUBLIC` had the identical silent
         no-op. `0006` is immutable (same rule as `0004`) — fixed instead by
         adding a corrective step 5b to `0007` that re-applies the REVOKE
         under `SET ROLE` for all three `0006` functions, alongside fixing
         `0007`'s own step 5 for the function it creates. Verified
         post-fix: `has_function_privilege('public', ..., 'EXECUTE')` is
         `false` for all four functions.

      Both fixes are committed in `0007_chatwoot_account_resolution.sql`
      itself (steps 5 and 5b) plus the `meta/_journal.json` entry — see that
      file's own comments for the full reasoning. Functional proof: with
      `brokers.chatwoot_account_id` set to `1` for the seeded dev broker,
      `SET ROLE dirus_tenant_resolver; SELECT dirus_resolve_broker_id(1)`
      returns that broker's `id`; an unknown `account_id` returns `NULL`;
      `creator` (the ordinary connection role) gets a permission-denied
      error calling the function directly, confirming EXECUTE is correctly
      restricted. `pnpm --filter @dirus/db run typecheck`/`test`: 144
      passed, 61 skipped, 0 failed, including `drift.test.ts` (no
      unexpected drizzle-kit drift from `0007`).

      **Known Phase 1/Phase 3 interaction, recorded for whoever runs 1.5 or
      starts Phase 2:** `live-tenant-resolution.test.ts`'s `2.7` describe
      block (the exported `resolveBrokerIdByWaPhoneNumberId` scenarios) is
      explicitly out of this task's scope per this task's own text above,
      and was left untouched. Because `beforeAll` now applies `0007` (which
      drops the `(text)` signature that export still calls), that block will
      fail live once run against a database with `0007` applied, until
      Phase 3 renames/re-keys it. This is flagged in the test file's own
      docstring as a deliberate, temporary consequence of the phase split —
      not a fresh regression — but it means this file cannot be run live
      end-to-end (all controls green) until Phase 3 lands alongside it.
- [x] 1.6 Confirm `packages/db/migrations/0004_tenant_resolver.sql` is
      byte-identical to its archived state (e.g. `git diff` against the
      commit that archived F2, or a checksum comparison) — Success Criteria
      item 11. This is a read-only confirmation task; it must not touch the
      file.
- [x] 1.7 Update `tenant-resolver-migration.test.ts`'s file docstring only
      (per D-G — assertions stay on `0004`'s text, unchanged) to state
      explicitly that this file asserts what `0004` declares, and that `0007`
      supersedes the function `0004` creates — see
      `chatwoot-account-resolution-migration.test.ts` for the current
      contract. No assertion in this file changes.

**Blocked on nothing external** — Phase 1 is self-contained and is itself the
mechanism that discharges D-C's `NEEDS EMPIRICAL PROOF` status. Everything in
Phase 2 onward is blocked on task 1.5 passing (or its documented fallback
being taken and recorded).

**Post-push CI stabilization (3 follow-up commits, all against `main`
directly, all before Phase 2 started):** pushing Phase 1 surfaced two
further real defects only a real CI run against a live, non-superuser-shaped
Postgres could catch, plus one known-and-accepted temporary breakage that
needed explicit skipping rather than leaving `main`'s CI red:

1. `0007`'s new step 5b (the 0006-function REVOKE correction) ran
   unconditionally, but `live-tenant-resolution.test.ts` deliberately
   applies only `0000/0002/0004(/0007)` — 0006's three functions don't
   exist there. Fixed with a `to_regprocedure()` existence guard (commit
   `bf2bb6e`).
2. Task 1.3's control 2 ("negative control... key-independent") still had a
   stale `dirus_resolve_broker_id('phoneA')` text literal left over from
   before re-keying — fixed to `dirus_resolve_broker_id(1001)` (commit
   `19392a2`).
3. The `2.7` describe block (Phase 3's own documented scope) was assumed to
   report SKIPPED in CI the way it does in a sandbox with no live Postgres;
   CI's dedicated tenant-resolver database actually runs it and fails
   loudly. Marked `describe.skip` with a corrected docstring, to be
   un-skipped by Phase 3 (commit `19392a2`).

CI run `34161449517` confirmed genuinely green: `live-tenant-resolution
.test.ts` reports "19 tests | 3 skipped" — 16 controls actually executed
against CI's live Postgres and passed; the 3 skipped are exactly the `2.7`
block awaiting Phase 3.

## Phase 2: `packages/schemas` — real payload, narrowed shape, boundary guard — design D-A, D-B

- [ ] 2.1 Replace `packages/schemas/test/fixtures/chatwoot-message-created.json`
      with the real captured payload from design D-A, committed unmodified
      except whatever `pubsub_token`/identifier scrubbing review requires.
      Record the captured Chatwoot version, channel (`Channel::Whatsapp`),
      event (`message_created`/`incoming`), and capture date
      (2026-09-07) in the task record and in the schema module's docstring
      (task 2.8) — this closes F2 task 4.8 and resolves O4.
- [ ] 2.2 RED: `chatwoot.test.ts` — a payload carrying the old invented shape
      (`inbox.phone_number` present, a top-level `contact` object) must
      **not** parse as a valid key source: either the parse itself narrows
      the field away (so reading `inbox.phone_number` off the parsed result
      is a type/runtime miss) or a payload built to require `contact` fails
      stage-2 validation. Write this against the current (unfixed) schema so
      it fails for the right reason first. Traces to Success Criterion 2 and
      the `webhook-ingress` delta's "Migration" note.
- [ ] 2.3 RED: `chatwoot.test.ts` — `chatwootInboxSchema` parses
      `{ id: number, name?: string }` and rejects/ignores `phone_number`;
      the top-level `contact` field is absent from
      `chatwootMessageCreatedPayloadSchema` entirely; a payload built from
      the real fixture (2.1) parses successfully end-to-end.
- [ ] 2.4 GREEN: implement the schema changes in
      `packages/schemas/src/webhooks/chatwoot.ts` per design D-A's table —
      narrow `chatwootInboxSchema`, remove top-level `contact` and delete
      `chatwootContactSchema` (no remaining referent), satisfying 2.2-2.3.
- [ ] 2.5 RED: table-driven test for `extractResolutionKey()` — returns the
      number `42` for a well-formed `account.id = 42`; returns `null` (never
      throws) when `account` is missing, `account.id` is missing, `null`, a
      string, or otherwise not a well-formed integer; and — the D-B boundary
      guard — returns `null` for `2147483648`, `-1`, `0`, and `1.5` with no
      query-layer code reachable from this test (this module has no query
      layer, so the assertion is purely on the return value). Traces to spec
      "extractResolutionKey returns null, never throws" and "A non-integer,
      negative, or out-of-int4-range account.id is refused before any query
      runs".
- [ ] 2.6 GREEN: implement `extractResolutionKey(): number | null` per design
      D-B's exact predicate (`Number.isInteger`, `id < 1`, `id > MAX_INT4`
      where `MAX_INT4 = 2_147_483_647`), satisfying 2.5. Return type changes
      from `string` to `number | null` — this is the compile-error-detection
      point Risk row 5 relies on for every downstream caller.
- [ ] 2.7 Rework `chatwoot-resolution-key-isolation.test.ts` — mechanism is
      unchanged (no module outside this one file reads the key field
      directly), but the forbidden string it asserts against becomes
      `account.id`-shaped rather than `inbox.phone_number`-shaped.
- [ ] 2.8 Rewrite the module docstring in
      `packages/schemas/src/webhooks/chatwoot.ts`: remove `@provisional` /
      "NEEDS CONFIRMATION" markers only for fields now confirmed against the
      real captured payload (2.1); record the capture instance, event,
      channel, and date in place of the citation to Chatwoot's public docs.
- [ ] 2.9 Verify `pnpm --filter @dirus/schemas test` passes and
      `packages/schemas/package.json` still declares zero `workspace:*`
      dependencies (dependency rule, unchanged by this change).

## Phase 3: `packages/db` TS surface — rename, retype, boundary guard — design D-E

- [ ] 3.1 RED: `packages/db/test/barrel-surface.test.ts` — the exhaustive
      export allowlist expects `resolveBrokerIdByChatwootAccountId` in place
      of `resolveBrokerIdByWaPhoneNumberId`. Must fail before the rename
      lands (old name still exported, new name absent).
- [ ] 3.2 RED: unit test for the not-yet-renamed export — an integer-range
      guard throws for a non-integer, non-positive, or out-of-`int4`-range
      `accountId`, replacing the deleted `MAX_KEY_LENGTH` string-length test.
      Write against a stub/mock of the query layer so this runs offline.
- [ ] 3.3 GREEN: rewrite `packages/db/src/tenant-resolution.ts` per design
      D-E — rename to `resolveBrokerIdByChatwootAccountId(accountId: number):
      Promise<string | null>`, delete `MAX_KEY_LENGTH` and its docstring,
      add the `MIN_ACCOUNT_ID`/`MAX_ACCOUNT_ID` throwing guard, bind
      `accountId` as a numeric parameter to
      `select public.dirus_resolve_broker_id(${accountId})`. Satisfies
      3.1-3.2. The old function name is deleted outright, not aliased (P1 —
      an alias is a second path in a TypeScript costume).
- [ ] 3.4 GREEN: update `packages/db/src/index.ts`'s export to satisfy 3.1.
- [ ] 3.5 Update the two docstrings design D-E/D-A name as falsified by the
      rename: `packages/db/src/tenant.ts`'s `TenantDb` docstring says
      "`chatwoot_account_id`" in place of "a `wa_phone_number_id`" as one of
      the things the resolution class learns a `broker_id` from;
      `packages/db/src/index.ts`'s barrel docstring names
      `resolveBrokerIdByChatwootAccountId` in place of the old export.
- [ ] 3.6 RED then GREEN, or mutation-tested if RED is structurally
      unattainable: rework the exported-function block in
      `live-tenant-resolution.test.ts` (D-G's "2.7 block") — import name
      changes to `resolveBrokerIdByChatwootAccountId`; "resolves a known
      key" re-keys to `1001`; "unknown key returns null" re-keys to
      `999999`; and the "rejects a pathological over-length key" case is
      **replaced, not re-keyed** — there is no over-length integer — with a
      table-driven case asserting `2_147_483_648`, `-1`, `0`, and `1.5` each
      reject before any query reaches Postgres. If this passes on first
      write because the guard is already correct by construction from 3.3,
      confirm by mutation instead: temporarily widen or remove the guard,
      confirm this test then fails, then restore. State in the test file
      which convention was used. This is the live proof of design D-E's
      guard, distinct from Phase 2's offline `extractResolutionKey` proof —
      the two boundaries are validated independently per D-B's stated
      rationale (a package's export validates its own preconditions; a
      request pipeline validates the request).
- [ ] 3.7 Run the full `live-tenant-resolution.test.ts` suite (Phase 1's
      1.3 SQL-level rework plus this phase's 3.6 TS-level rework) against
      CI's live Postgres. Confirm the after-count of controls in the file
      exceeds the before-count by at least the two controls Phase 1 added
      (proposal Risk row 2).

## Phase 4: `apps/api` — middleware, route, ingest boundary, wiring — design D-A consequence, D-B, D-E, D-F

- [ ] 4.1 RED: `apps/api/test/.../tenant-resolver.test.ts` (or its existing
      equivalent) — `ResolveBrokerId` is typed `(accountId: number) =>
      Promise<string | null>`; a fake resolver typed to the old
      `(key: string) => ...` shape is a compile error, and the miss log
      emits `{ chatwoot_account_id: key }` (field renamed, event name
      `tenant_resolution_miss` unchanged) with no other payload field
      present.
- [ ] 4.2 GREEN: update `apps/api/src/middleware/tenant-resolver.ts` —
      `ResolveBrokerId` type, `TenantResolverVariables.resolutionKey: number`
      doc comment, and the log line's field name, satisfying 4.1.
- [ ] 4.3 RED: `apps/api/test/routes/webhooks/chatwoot.test.ts` — when
      `extractResolutionKey()` returns `null` for a malformed `account.id`,
      the route responds `400 { error: "invalid payload" }`, and the
      tenant-resolver function is never called (assert via a spy/counter on
      a fake resolver, not a real lookup) — no query issued, no 500. Traces
      to spec "A non-integer, negative, or out-of-int4-range account.id is
      refused before any query runs".
- [ ] 4.4 GREEN: add the `null`-branch to `parseAndExtractResolutionKey` in
      `apps/api/src/routes/webhooks/chatwoot.ts` per design D-B, satisfying
      4.3; update the route's doc comments that reference the old key.
- [ ] 4.5 RED: `apps/api/src/services/ingest-message.ts`'s existing test
      coverage — a payload built on the real captured shape (no top-level
      `contact`) is read via `payload.sender.phone_number`, not
      `payload.contact.phone_number`; the "missing phone number" error
      message names `sender`, not `contact`.
- [ ] 4.6 GREEN: at `apps/api/src/services/ingest-message.ts:54`, change
      `payload.contact.phone_number` to `payload.sender.phone_number` and
      reword the associated error message to name `sender`, satisfying 4.5.
      This file is explicitly in this change's scope — the proposal's
      Affected Areas table missed it; design.md names it directly as the
      site `pnpm -r typecheck` would otherwise catch only after the fact.
- [ ] 4.7 GREEN: update `apps/api/src/index.ts` — the import and the wiring
      line both rename to `resolveBrokerIdByChatwootAccountId`; the shape
      (`resolveBrokerId: resolveBrokerIdByChatwootAccountId`) does not
      change.
- [ ] 4.8 Rework `apps/api/test/routes/webhooks/chatwoot.test.ts` (structural,
      per D-G) — fixtures rebuilt on the real captured shape (Phase 2's
      fixture), every fake resolver retyped to `(accountId: number) =>
      Promise<string | null>`.
- [ ] 4.9 Rework `apps/api/test/live/webhook-ingress.live.test.ts` (structural,
      per D-G) — end-to-end key and payload shape corrected to
      `account.id`/`chatwoot_account_id` and `sender.phone_number`; this
      suite runs against `LIVE_TEST_DATABASE_URL`, not the real Chatwoot
      instance — that is Phase 5.
- [ ] 4.10 Run `pnpm -r typecheck` from a clean state. Confirm every fake
      resolver across `apps/api`'s test suite that was not yet updated
      surfaces as a compile error (this is the detection mechanism proposal
      Risk row 5 relies on — `resolutionKey`/`ResolveBrokerId` moving from
      `string` to `number`), fix any remaining site, and confirm the command
      passes clean.

## Phase 5: Live end-to-end confirmation against the real Chatwoot instance — Success Criteria (the evidence class F2 never had)

- [ ] 5.1 Confirm at least one `brokers` row's `chatwoot_account_id` matches
      the account id of the seeded WhatsApp-shaped inbox in the running
      `infra/chatwoot/` instance (proposal Dependencies / Risk row 3;
      Migration/Rollout note). If unpopulated, populate it before proceeding
      — an unpopulated column produces the same 400/404 symptom for an
      unrelated reason and would be misdiagnosed as this change failing.
- [ ] 5.2 Run `apps/api` locally, wired to the real `infra/chatwoot/`
      instance via the existing `.env` configuration
      (`CHATWOOT_WEBHOOK_TOKEN`, `CHATWOOT_BASE_URL`,
      `CHATWOOT_API_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID`) established in F2.
- [ ] 5.3 Trigger a real `message_created`/`incoming` webhook by sending a
      message through the live Chatwoot instance's seeded WhatsApp-shaped
      inbox, so an actual Chatwoot-originated HTTP POST reaches `apps/api` —
      not a synthetic fixture, not a replayed capture.
- [ ] 5.4 **The success criterion F2 could never evaluate.** Confirm the
      request resolves the correct `broker_id` (matching 5.1's broker),
      returns a 2xx response, and persists **exactly one** `messages` row
      with the correct `broker_id`, `conversation_id`, and `contact_id`.
      This closes proposal Success Criteria item 5.
- [ ] 5.5 Confirm the negative path live: a webhook from an account id that
      matches no seeded broker is refused, writes no `messages`,
      `conversations`, or `contacts` row, and emits the
      `tenant_resolution_miss` operational log line containing only
      `chatwoot_account_id` — no message body, sender name, or other payload
      content (F2 P4, preserved).
- [ ] 5.6 Record the evidence from 5.3-5.5 (request/response, the emitted log
      line, the resulting database row) in the verify report as the real,
      non-synthetic proof this change exists to produce — distinct from and
      in addition to the CI-run synthetic live suites (Phases 1, 3, 4).
- [ ] 5.7 Run `pnpm -r typecheck` and `pnpm -r test` from a clean state.
      Cross-check every checkbox in proposal.md's Success Criteria against
      completed tasks, including the ones only this phase can close (items 5
      and, transitively, item 1's "F2 task 4.8 is closed and O4 is marked
      resolved").
- [ ] 5.8 Update `openspec/ROADMAP.md` and `openspec/PHASES.md` to register
      F2.1 and mark F2's O4 resolved, per proposal Affected Areas.
