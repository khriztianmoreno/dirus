# Tasks: WhatsApp webhook ingress

## Ordering constraint — read before touching anything below

**D-1 is marked `NEEDS EMPIRICAL PROOF`** (design.md). No Postgres, Docker, or
Podman is reachable on the development machine that authored the design, so
the entire tenant-resolution mechanism — a dedicated `NOLOGIN` role, a
`TO`-scoped permissive policy, a `SECURITY DEFINER` function returning a bare
`uuid` — rests on reasoning about Postgres RLS/role semantics and has never
been executed against a live server. CI's `pgvector/pgvector:pg17` service
container is the only place it can be proven.

**Therefore Phase 1 is the migration plus its live proof, and nothing else.**
No `apps/api` bootstrap, no route handlers, no ingest pipeline, no Chatwoot
schema — until D-1's five live assertions (design.md, "The live test that
must pass before implementation is accepted") are green in CI, including the
negative control: `dirus_app`, in the *same session* that just resolved a
broker through `dirus_resolve_broker_id`, must still see **zero** rows on a
direct `SELECT * FROM brokers`.

**Do not parallelize Phase 1 with any later phase.** Every phase from 2
onward assumes `resolveBrokerIdByWaPhoneNumberId` is a safe, proven primitive
to build on. If the gate fails, D-1's chosen mechanism is wrong (design.md
already names the most likely wrong turn — role-membership `INHERIT` defeats
the `TO` clause) and the design itself changes. Any webhook/route/pipeline
code written before the gate passes would be built on an unproven
foundation and is likely to be partially or wholly discarded. This is a
correctness ordering constraint, not a scheduling preference — do not
"optimize" it by starting Phase 3+ scaffolding in parallel.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1500-2000 (migration + live proof, `packages/db` export + docstrings, `apps/api` bootstrap, `packages/schemas` webhook schema, `packages/integrations` Chatwoot client, ingest pipeline, live integration tests) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Phase 1 gate) -> PR 2 (Phase 2 db export) -> PR 3 (Phase 3+4 api bootstrap + schema) -> PR 4 (Phase 5 ingest pipeline) -> PR 5 (Phase 6 live integration tests) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending — user decision needed before `sdd-apply` starts Phase 2 |

Ask the user for chain strategy (stacked-to-main / feature-branch-chain /
size-exception) before `sdd-apply` starts Phase 2. Phase 1 must merge (or at
minimum sit green in CI) before Phase 2 begins, per the ordering constraint
above.

## Phase 1: Tenant-resolution migration + live proof (the gate) — design D-1, spec "Multi-Tenant Isolation", data-model delta

- [x] 1.1 RED: catalog/structural tests for migration `0004_tenant_resolver.sql`
      before the migration exists — asserts (by reading the SQL text, mirroring
      `rls-policies.test.ts`'s convention) that the file will declare: a
      `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` role, a
      `CREATE POLICY ... FOR SELECT TO dirus_tenant_resolver USING (true)` on
      `brokers`, a `SECURITY DEFINER` function with `SET search_path = ''` and a
      schema-qualified `public.brokers` reference, and a `REVOKE ALL ... FROM
      PUBLIC` followed by `GRANT EXECUTE ... TO dirus_app`. (design D-1)
- [x] 1.2 GREEN: write `packages/db/migrations/0004_tenant_resolver.sql` per the
      sketch in design.md D-1 (`drizzle-kit generate --custom`), satisfying 1.1.
      Traces to: proposal O1/R1, design D-1, and the `data-model` delta spec
      (concurrent artifact, scope: resolver role, `TO`-scoped policy,
      `SECURITY DEFINER` function, `WITH INHERIT FALSE`).
- [x] 1.3 Write the down path as a committed script or comment block, in the
      documented order: `REVOKE EXECUTE` -> `DROP FUNCTION` -> `DROP POLICY
      tenant_resolver_lookup ON brokers` -> revoke the column/schema grants ->
      revoke the owner's `INHERIT` membership -> `DROP ROLE`. (design.md
      "Migration / Rollout")
- [x] 1.4 RED: extend `packages/db/test/migrations/rls-catalog-guard.test.ts`
      (or a sibling file, if scope grows large enough to warrant a split) with
      the membership guard — `pg_auth_members` shows no *inheriting* membership
      of `dirus_app` in `dirus_tenant_resolver` — and the `proconfig`/`EXECUTE`
      grantee guards named in design D-1's "Delta" paragraph. Write this against
      the not-yet-applied migration so it fails for the right reason (table/role
      absent) before 1.2, or immediately after 1.2 if sequencing the catalog
      guard after the migration text is clearer — either order is acceptable as
      long as RED is observed before GREEN.
- [x] 1.5 GREEN: confirm 1.4 passes once 1.2's migration is applied in CI's live
      Postgres.
- [x] 1.6 Create `packages/db/test/migrations/live-tenant-resolution.test.ts`,
      extending `live-rls-verification.test.ts`'s established conventions
      exactly (`describe.skipIf(!LIVE_TEST_DATABASE_URL)`, throwaway schema,
      disposable fixture roles, `assertThrowawayDatabase`) — do not invent a
      second convention. Implements the five live assertions from design.md
      D-1 verbatim, each as its own `it()`:
      1. **RED then GREEN — positive**: connected as the app fixture role with
         no `app.broker_id` set, `SELECT dirus_resolve_broker_id('phoneA')`
         returns broker A's `id`. Write this test before 1.2/1.5 land in this
         file's target environment so it is observed failing (function does
         not exist) before it passes.
      2. **RED then GREEN — negative control, the whole point**: in the *same
         session* that just called `dirus_resolve_broker_id`, `SELECT count(*)
         FROM brokers` returns `0` and `SELECT * FROM brokers` returns zero
         rows. This is the assertion the ordering constraint above exists to
         protect — if it is ever green for the wrong reason (e.g. because the
         function silently no-ops instead of resolving), 1.6.1 would also be
         failing, so the pair is the real gate.
      3. **RED then GREEN — miss**: `dirus_resolve_broker_id('unknown')`
         returns `NULL`, not an error.
      4. **RED then GREEN — owner control**: the same call made through an
         owner-owned `SECURITY DEFINER` function (constructed inline in this
         test, not reusing 0004's function) returns `NULL`, re-proving `FORCE`
         binds the table owner and that the resolver role's non-ownership is
         load-bearing.
      5. **RED then GREEN — membership guard**: `pg_auth_members` shows no
         inheriting membership of the app role in the resolver role (live
         re-assertion of 1.4's catalog check, from the app role's own
         connection this time).
- [x] 1.7 Run the full Phase 1 test suite against CI's `pgvector/pgvector:pg17`
      service container. **This is the acceptance gate.** If assertion 2
      (negative control) or 5 (membership guard) fails, STOP — do not proceed
      to Phase 2. Record the failure, revisit design D-1's option table, and
      treat this as a design change, not an implementation bug to patch around.
      **PASSED** — CI run 33899572167: `live-tenant-resolution.test.ts` 14/14,
      `packages/db` 120/120 across 19 files, zero skipped. The negative
      control, the owner control, and both mutation tests all executed against
      a live server. D-1's `NEEDS EMPIRICAL PROOF` status is discharged: the
      `TO`-scoped policy plus `SECURITY DEFINER` mechanism works, and the
      guards proving it discriminate rather than decorate.

      The first CI run failed 9 of 14. All three defects were in the test, none
      in migration 0004: a missing `GRANT USAGE ON SCHEMA public TO dirus_app`
      (0003 carries it and is deliberately not applied here, and the schema
      reset discards initdb's grant to PUBLIC), `toContain` used for substring
      matching on an array, and an assertion that contradicted its own
      `array_to_string` query. Consistent with F1's Phase 4 experience, where
      nine of ten confirmed defects lived in the verification code rather than
      the code being verified.
- [x] 1.8 Update `openspec/changes/whatsapp-webhook-ingress/specs/data-model/spec.md`
      status/notes to record that D-1's live proof passed (or, if it did not,
      that the gate blocked progress and why) — this file is authored
      concurrently per the task brief; this task only touches its status, not
      its scenario content.

**Blocked on open question**: none — Phase 1 is self-contained and is itself
the mechanism for resolving D-1's "NEEDS EMPIRICAL PROOF" status. Everything
in Phase 2 onward is blocked on Phase 1's task 1.7 passing.

## Phase 2: `packages/db` public surface — design D-7

- [x] 2.1 RED: `packages/db/test/barrel-surface.test.ts` — extend the exhaustive
      allowlist assertion to expect `resolveBrokerIdByWaPhoneNumberId` alongside
      `assertUuid`, `schema`, `withBrokerContext`. This must fail before the
      export exists (RED first — the allowlist is exhaustive, so adding the
      name before the export exists fails for the right reason: export
      missing).
- [x] 2.2 RED: unit test for `resolveBrokerIdByWaPhoneNumberId` — input length
      cap rejects pathological input before any query runs (design D-7, "cap
      its length to reject pathological input"). Write against a stub/mock of
      the query layer so this runs offline.
- [x] 2.3 GREEN: create `packages/db/src/tenant-resolution.ts` —
      `resolveBrokerIdByWaPhoneNumberId(key: string): Promise<string | null>`,
      a single statement (`select public.dirus_resolve_broker_id($1)`) on the
      pooled client, no transaction. Traces to design D-7 and depends on Phase
      1's `dirus_resolve_broker_id` function existing and being proven safe.
- [x] 2.4 GREEN: add the export to `packages/db/src/index.ts`, satisfying 2.1.
- [x] 2.5 Correct the two docstrings design D-7 names as falsified by this
      export:
      - `packages/db/src/tenant.ts` — the `TenantDb` docstring ("the only
        tenant-scoped handle callers ever receive") gains the clarification
        that `TenantDb` remains the only handle through which **table** access
        is possible, and that `resolveBrokerIdByWaPhoneNumberId` is a second,
        deliberately narrower access class returning only an opaque identifier
        — state explicitly that the pattern must not be extended to any call
        returning row or column data.
      - `packages/db/src/index.ts` — the barrel docstring's claim ("every query
        a caller issues goes through the transaction-scoped tenant context")
        is now false as written; amend it to name the new export as the single
        documented exception and explain why (tenant resolution logically
        precedes tenant context).
- [x] 2.6 RED then GREEN, or mutation-tested if RED is impossible: a test
      asserting `resolveBrokerIdByWaPhoneNumberId` never opens a
      `withBrokerContext` transaction and returns no table handle — i.e. its
      return type is `string | null`, never a row object. If this is correct
      by construction from the type signature alone (so a meaningful RED state
      cannot be produced), validate by mutation instead: temporarily change the
      return type/implementation to leak a row object, confirm the test fails,
      then restore. State in the test file which convention was used.
- [x] 2.7 Live: extend `packages/db/test/migrations/live-tenant-resolution.test.ts`
      (or add a focused sibling) to call `resolveBrokerIdByWaPhoneNumberId`
      itself (not the raw SQL) against the throwaway fixture, so the exported
      function — not just the underlying SQL statement — is proven safe
      end-to-end.

## Phase 3: `apps/api` bootstrap — design D-5

- [x] 3.1 Add `hono`, `@hono/node-server`, and the workspace deps (`@dirus/db`,
      `@dirus/schemas`, `@dirus/integrations`) to `apps/api/package.json`.
- [x] 3.2 RED: `apps/api/src/env.ts` test — mirrors the house pattern
      (`packages/db/src/internal/client.ts`'s `readRequired(name)`): throws at
      **import time** naming the missing variable. Write the test asserting
      import-time throw before the module exists. Note: this test must not
      import anything that transitively pulls in `@dirus/db`'s
      `DATABASE_URL`-checking import chain in a way that makes the test itself
      require a database — `env.ts` deliberately does **not** re-validate
      `DATABASE_URL` (design D-5), so this test only covers `apps/api`'s own
      required vars (per `.env.example`: `CHATWOOT_WEBHOOK_TOKEN`,
      `CHATWOOT_BASE_URL`, `CHATWOOT_API_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID`,
      `PORT`).
- [x] 3.3 GREEN: `apps/api/src/env.ts`.
- [x] 3.4 Update `.env.example` with `CHATWOOT_WEBHOOK_TOKEN`,
      `CHATWOOT_BASE_URL`, `CHATWOOT_API_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID`,
      `PORT`.
- [x] 3.5 RED: `apps/api/src/app.ts` test — `createApp({ ingest })` is a
      factory taking the ingest function as a parameter (design D-5's stated
      consequence: `@dirus/db` throws at import, so anything transitively
      importing it cannot load in a test without a database; `createApp` must
      accept a fake `ingest` and run fully offline). Assert the app can be
      constructed and a request routed through it using only a fake `ingest`,
      with no `@dirus/db` import reachable from the test's import graph.
- [x] 3.6 GREEN: `apps/api/src/app.ts` — the `createApp({ ingest })` factory,
      wiring routes but not yet the real ingest pipeline (that lands in Phase
      5).
- [x] 3.7 RED: `apps/api/src/routes/health.ts` test — GET returns 200 with no
      auth required, no database access.
- [x] 3.8 GREEN: implement the health route.
- [x] 3.9 GREEN: `apps/api/src/index.ts` — bootstrap: import `./env.js`, then
      `serve(createApp({ ingest: realIngestFromServicesIngestMessage }))`. This
      is the one place the real `services/ingest-message.ts` (Phase 5) is
      wired in; keep it out of `app.ts` per D-5's offline-testability
      constraint.
- [x] 3.10 Verify `pnpm -r typecheck` and `pnpm --filter @dirus/api test` pass
      with only the health route and env loader in place (no webhook route
      yet — that is Phase 5).

## Phase 4: Chatwoot payload schema — design D-6, spec "Raw Payload Is Not Retained Verbatim"

- [ ] 4.1 **NEEDS CONFIRMATION (proposal O4, design D-6, "Open and material")**:
      Chatwoot's real payload shape, and specifically which field (if any)
      carries Meta's `wa_phone_number_id`, is unverified — no live Chatwoot
      instance or fixture exists. This phase proceeds on the documented
      fallback design decision (fixture derived from Chatwoot's documentation,
      schema marked `@provisional`), per D-6. If a real payload becomes
      available before this phase starts, capture it and replace the derived
      fixture before writing 4.2-4.7; otherwise proceed as below and leave the
      `@provisional` marker in place.
- [ ] 4.2 Author `packages/schemas/test/fixtures/chatwoot-message-created.json`,
      a fixture derived from Chatwoot's public documentation for a
      `message_created` / `incoming` event, marked as provisional in an
      adjacent comment or the schema's own docstring.
- [ ] 4.3 RED: test — the envelope schema (`z.object({ event: z.string() })`,
      non-strict) parses an event whose `event` is not `message_created` (or
      whose `message_type` is not `incoming`) and the caller can branch on
      that to short-circuit before any stage-2 parse. Write against the
      not-yet-written schema.
- [ ] 4.4 RED: test — the stage-2 message-payload schema strips unknown keys by
      default (no `.passthrough()`), asserted against a payload that includes
      an extra Chatwoot-internal field not modeled by the schema — the parsed
      result must not contain that field. Traces directly to spec "Raw Payload
      Is Not Retained Verbatim" / P2.
- [ ] 4.5 RED: test — a malformed `message_created` payload (missing a
      required field) fails stage-2 parsing.
- [ ] 4.6 GREEN: `packages/schemas/src/webhooks/chatwoot.ts` — two-stage parse
      (envelope, then message payload), `@provisional` docstring, satisfying
      4.3-4.5. Re-export from `packages/schemas/src/index.ts`.
- [ ] 4.7 RED then GREEN: `extractResolutionKey(payload): string` — the single
      function design D-6 names as the sole place that knows which payload
      field carries the resolution key. Write it against the current
      best-guess field from the fixture; the isolation itself (not the
      specific field choice) is what this task certifies. Test that swapping
      the extraction logic requires touching only this function, not the
      route or middleware — e.g. by asserting no other module in
      `apps/api/src/routes/webhooks` or `apps/api/src/middleware` imports
      anything from `packages/schemas` other than the parse functions and this
      extractor.
- [ ] 4.8 **Flagged — depends on O4's resolution**: if/when a real Chatwoot
      payload is captured and it turns out `wa_phone_number_id` is not present
      (the design's stated fallback: use `brokers.chatwoot_account_id`
      instead), this task is to update `extractResolutionKey` and
      `dirus_resolve_broker_id`'s predicate. Not scheduled now — the design
      states this should be a one-function, one-predicate change if it
      happens. Do not attempt this until O4 is confirmed one way or the other.
- [ ] 4.9 Verify `pnpm --filter @dirus/schemas test` passes and
      `packages/schemas/package.json` still declares zero `workspace:*` deps
      (dependency rule, unchanged by this phase).

## Phase 5: Ingest pipeline — design D-2, D-3, D-4; spec requirements "Inbound Webhook Authentication", "Tenant Resolution", "Idempotent Message Persistence", "Contact Find-or-Create", "Conversation Find-or-Create", "Fixed Echo Reply", "Media Message Persistence"

- [ ] 5.1 **NEEDS CONFIRMATION (proposal O3, design D-4)**: whether Chatwoot
      HMAC-signs webhooks is unverified. This phase implements D-4's stated
      compensating control (`CHATWOOT_WEBHOOK_TOKEN` bearer credential,
      `crypto.timingSafeEqual`, accepted from `X-Dirus-Webhook-Token` header or
      URL path segment) rather than a signature. If confirmation later shows
      HMAC support, D-4 states the upgrade is local to
      `apps/api/src/middleware/webhook-auth.ts` — no route rewrite. Proceed on
      that basis.
- [ ] 5.2 RED: `apps/api/src/middleware/webhook-auth.ts` test — a request
      missing the token, or presenting a wrong-length/incorrect token, is
      rejected with 401 and no detail in the body, and — critically — the
      tenant-resolver middleware never runs (assert via a spy/counter on a
      fake resolver, not by asserting on a real lookup). Traces to spec
      "Inbound Webhook Authentication" / "Request without valid authentication
      is rejected".
- [ ] 5.3 RED: same middleware test — a request with a valid token passes
      through.
- [ ] 5.4 GREEN: `apps/api/src/middleware/webhook-auth.ts` — reads the raw body
      (`c.req.text()`, defers `JSON.parse`), `crypto.timingSafeEqual` after a
      length check, accepts header or path-segment token, mounted before the
      tenant resolver.
- [ ] 5.5 RED: `apps/api/src/middleware/tenant-resolver.ts` test — given a
      known `wa_phone_number_id` (via a fake `resolveBrokerIdByWaPhoneNumberId`
      injected into the middleware, not the real `@dirus/db` export — keep
      this test offline per D-5), sets `c.var.brokerId`; given an unknown key,
      rejects with no `brokerId` set and never guesses/defaults one.
- [ ] 5.6 RED: same test — an unknown key emits an operational log line
      containing only the `wa_phone_number_id`, never message body/sender
      name/other payload fields. Traces to spec "Unknown wa_phone_number_id
      emits an operational log without message content" / P4.
- [ ] 5.7 GREEN: `apps/api/src/middleware/tenant-resolver.ts`, satisfying
      5.5-5.6.
- [ ] 5.8 RED: `apps/api/src/routes/webhooks/chatwoot.ts` test — envelope
      parse rejects non-`message_created`/non-`incoming` events with 200
      `{ ignored: true }` and no database access (assert via the fake ingest
      never being called). Traces to design D-6 stage 1.
- [ ] 5.9 GREEN: wire the route: auth middleware -> tenant resolver -> stage-1
      envelope parse -> (ignored -> 200) -> stage-2 payload parse -> (invalid
      -> 400) -> call `ingest(brokerId, payload)`.
- [ ] 5.10 RED: `apps/api/src/services/ingest-message.ts` test, against a real
      (not fake) `@dirus/db` — this file is exactly the boundary D-5 draws
      ("no HTTP types cross this line") and the one place Phase 1-2's proven
      primitives get exercised together. Since this needs a real transaction,
      write it as a `describe.skipIf(!LIVE_TEST_DATABASE_URL)` test alongside
      the live suite, not as an offline unit test. Assert: first message from
      a new sender creates exactly one `contacts` row and one `conversations`
      row, and the `messages` row references both. Traces to spec "Contact
      Find-or-Create" / "First message from a new sender creates a contact"
      and "Conversation Find-or-Create" / "First message in a thread creates a
      conversation".
- [ ] 5.11 RED: same file — a second message from the same sender reuses the
      existing `contacts` and `conversations` rows (no duplicates). Traces to
      spec "Subsequent message from a known sender reuses the existing
      contact" and "Subsequent message in the same thread reuses the existing
      conversation".
- [ ] 5.12 GREEN: implement `services/ingest-message.ts` per design D-2's exact
      statement order — this order is **load-bearing, not stylistic** (design
      D-2): (1) `INSERT INTO contacts ... ON CONFLICT (broker_id, phone) DO
      UPDATE SET phone = EXCLUDED.phone RETURNING id` (the serialization
      point — `DO UPDATE`, never `DO NOTHING`, because only `DO UPDATE` takes
      the row lock D-2 depends on), (2) `SELECT` the latest matching
      conversation, (3) insert one if none found, (4) `INSERT INTO messages
      ... ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`. All four
      inside one `withBrokerContext` transaction. Satisfies 5.10-5.11.
- [ ] 5.13 RED: test — a duplicate `wa_message_id` on a second sequential
      call: the transaction still commits (steps 1-3 are idempotent), no
      second `messages` row is created, the caller sees `{ deduplicated: true
      }` (or equivalent signal), and no echo is triggered for that call.
      Traces to spec "Sequential replay of the same wa_message_id leaves one
      row" and design D-3's "Losing side" paragraph.
- [ ] 5.14 GREEN: implement the dedup-signal branch in `ingest-message.ts` /
      the route, satisfying 5.13.
- [ ] 5.15 RED: test — a media-message payload (per the schema, once Phase 4
      lands) persists a `messages` row with `media_r2_key` null and makes no
      attempt to fetch/store a media binary (assert no network call is made —
      inject a spy in place of any media-fetch dependency, or assert none
      exists in the call graph). Traces to spec "Media Message Persistence" /
      P3.
- [ ] 5.16 GREEN: satisfy 5.15 — this may already be correct by construction
      if the pipeline never attempts a media fetch. **If RED is impossible
      because the implementation is already correct by construction, validate
      by mutation testing instead**: temporarily add a media-fetch call (or
      remove the null default), confirm 5.15 fails, then restore. This
      convention (mutation-test in place of an impossible RED) was established
      in the `extraction-schemas` change and is not optional here.
- [ ] 5.17 Create `packages/integrations/src/chatwoot.ts` — a minimal typed
      client sending one text reply (P1's fixed acknowledgement copy). No
      test-first RED needed for the copy string itself (a literal), but:
- [ ] 5.18 RED: test — the fixed acknowledgement reply text is never equal to,
      nor a substring-derived echo of, the customer's own message body (use a
      table of varied input bodies, including one that happens to overlap
      textually with the fixed copy, to make this a real assertion rather than
      a tautology). Traces to spec "Reply is a fixed acknowledgement, not the
      customer's text" / P1.
- [ ] 5.19 GREEN: satisfy 5.18 in `packages/integrations/src/chatwoot.ts` and
      the route's post-commit echo call.
- [ ] 5.20 RED: test — when persistence fails (transaction rejected before
      commit, e.g. tenant-resolution miss or a parse failure upstream), no
      echo call reaches the Chatwoot client (assert via a spy/counter, not a
      live network call). Traces to spec "Reply is not sent when persistence
      fails".
- [ ] 5.21 GREEN: ensure the echo call happens strictly after commit, outside
      the transaction, and only on the success path — satisfies 5.20 alongside
      5.13-5.14's dedup-suppresses-echo behaviour.
- [ ] 5.22 Wire `apps/api/src/index.ts`'s real `ingest` to
      `services/ingest-message.ts`, replacing the placeholder from Phase 3.

## Phase 6: Live integration tests — concurrency and isolation (non-negotiable)

These tests must **dispatch requests concurrently, not sequentially**. A
sequential replay test passes against a broken check-then-insert
implementation and proves nothing about the race the spec forbids — this is
stated explicitly in the task brief and echoed in design D-2/D-3's own
reasoning about `DO UPDATE` vs `DO NOTHING`.

- [ ] 6.1 RED (dispatched, not sequential): two `pg`-backed webhook requests
      carrying the identical `wa_message_id` are dispatched via
      `Promise.all([send(reqA), send(reqB)])` — i.e. both fired before either
      is awaited to completion — against a broker/conversation fixture that
      already exists. Before 5.12's `ON CONFLICT DO NOTHING` implementation is
      correct, this is expected to be written and observed failing against an
      intentionally-broken read-then-insert stand-in, or observed passing
      immediately if 5.12 already landed correctly — in the latter case,
      confirm by mutation: temporarily replace the dedup insert's `ON
      CONFLICT DO NOTHING` with a read-then-insert, confirm this test then
      fails (two rows, or a constraint-violation crash on the loser), then
      restore. Traces to spec "Concurrent delivery of the same wa_message_id
      leaves one row".
- [ ] 6.2 GREEN/confirm: exactly one `messages` row exists with the shared
      `wa_message_id` after both requests complete, and both return 2xx.
- [ ] 6.3 RED (dispatched, not sequential): two distinct first-time webhook
      messages from the same brand-new sender phone number, addressed to the
      same broker, dispatched via `Promise.all` without awaiting either first.
      Mutation-test convention applies identically to 6.1 if this passes on
      first write because D-2's statement ordering is already correct by
      construction: temporarily swap `DO UPDATE` for `DO NOTHING` in the
      contacts upsert (design D-2 names this exact substitution as the one
      that reopens the race), confirm this test then fails (two
      `conversations` rows), then restore. Traces to spec "Concurrent first
      messages from the same new contact do not duplicate the conversation".
- [ ] 6.4 GREEN/confirm: exactly one `conversations` row links
      `(broker_id, contact_id)` after both requests complete, and both
      `messages` rows reference that single conversation.
- [ ] 6.5 Extend the existing two-broker live fixture pattern (mirroring
      `live-rls-verification.test.ts` / `rls-catalog-guard.test.ts`'s
      conventions) to seed rows via the actual webhook ingress path — not
      direct SQL inserts — for `messages`, `conversations`, and `contacts` for
      two distinct brokers.
- [ ] 6.6 RED then GREEN: broker X's tenant-scoped session reads none of
      broker Y's `messages`, `conversations`, or `contacts` rows. Traces to
      spec "Broker X cannot read Broker Y's messages, conversations, or
      contacts rows" — this is the ROADMAP hard requirement and the proposal's
      "non-negotiable" success criterion.
- [ ] 6.7 Confirm (already covered structurally in Phase 1 task 1.6, assertion
      2, but re-run here end-to-end through the real webhook path rather than
      a raw SQL call): after a webhook request resolves broker X's tenant,
      `dirus_app`'s session still returns zero rows on a direct `SELECT *
      FROM brokers`. This closes the loop from Phase 1's isolated proof to the
      full pipeline.
- [ ] 6.8 Run `pnpm -r typecheck` and `pnpm -r test` from a clean state; cross-
      check every proposal Success Criteria checkbox (proposal.md, bottom)
      against completed tasks.
- [ ] 6.9 Update `openspec/ROADMAP.md` to correct the F2 scope line (proposal:
      "Out of Scope" — Chatwoot's VPS deployment is infrastructure, not this
      change; the current ROADMAP line conflates the two).
