# Proposal: Fix Chatwoot tenant resolution

## Intent

F2 (`whatsapp-webhook-ingress`) shipped, was verified PASS, and archived — and its ingress path has never once worked against a real Chatwoot instance. A real self-hosted Chatwoot (`infra/chatwoot/`) was connected to `apps/api` for the first time and its actual `message_created` payload was captured and compared against `packages/schemas/src/webhooks/chatwoot.ts`. Two independent, always-fatal defects were confirmed:

1. **`inbox.phone_number` does not exist.** A real `inbox` object only ever contains `{id, name}`. `extractResolutionKey()` returns `payload.inbox.phone_number`, so the tenant key can never be extracted. Every real webhook is rejected with 400 *before* tenant resolution is even attempted.
2. **There is no top-level `contact` field.** Real payloads carry only `sender` (already modeled correctly and separately). The schema's required `contact` field fails validation independently of defect 1.

Either defect alone makes ingress unreachable. CI never caught this because the schema and its own fixture were both written from Chatwoot's public docs and both self-labelled `@provisional` / "NEEDS CONFIRMATION" — this is F2's open question **O4**, and a fixture cannot falsify the assumption it was derived from.

This is not a surprise. F2's design decision **D-6** anticipated exactly this failure mode and named its contingency in advance: fall back to `account.id` matched against `brokers.chatwoot_account_id`. That column already exists, already `UNIQUE` and indexed (`0000_init.sql:21`), and is already populated by the Chatwoot-mirror-columns requirement. The fix is executing a contingency that was written down, not inventing one under pressure.

**Why now.** A2 and B2 both build on ingress. Every day this stays broken, more work is layered on a path that provably cannot receive a message.

## Scope

### In Scope

- **`packages/schemas`**: drop required `phone_number` from `chatwootInboxSchema`; drop required `contact` from `chatwootMessageCreatedPayloadSchema`; `extractResolutionKey()` returns `payload.account.id`. Replace `test/fixtures/chatwoot-message-created.json` with the **real captured payload** — this closes F2 task 4.8, deferred pending O4. Rework `chatwoot.test.ts` and `chatwoot-resolution-key-isolation.test.ts`.
- **`packages/db` (security-critical)**: new migration `0007` rebuilding `dirus_resolve_broker_id` to match on `chatwoot_account_id`, **with its column-scoped `GRANT SELECT` updated in the same migration** — see P3. Rename and retype `resolveBrokerIdByWaPhoneNumberId` in `tenant-resolution.ts`; replace the `MAX_KEY_LENGTH = 256` string guard with an integer-range guard (P2). Rework `test/migrations/tenant-resolver-migration.test.ts` and `test/migrations/live-tenant-resolution.test.ts` — the latter is the actual security proof (positive / negative-control / miss / owner-control / suspended-broker / search-path-hijack / mutation), not fixture plumbing, and every one of its seeds and assertions is keyed on the wrong column today.
- **`apps/api`**: `middleware/tenant-resolver.ts` (`ResolveBrokerId` type, log line, comments), `routes/webhooks/chatwoot.ts` doc comments, `test/routes/webhooks/chatwoot.test.ts`, `test/live/webhook-ingress.live.test.ts`.
- **Spec deltas** superseding the requirements that state the wrong key (P4).
- A live end-to-end confirmation against the real Chatwoot instance — the evidence class that was missing when F2 was verified.

### Out of Scope

- **Dropping `brokers.wa_phone_number_id`.** The column stops being the *resolution key*; it stays as a Chatwoot/WhatsApp mirror column. Removing a populated column is a separate, riskier change with no benefit here.
- **Editing `0004_tenant_resolver.sql` in place.** That migration has now been applied to a real database. Forward-only from here.
- **Re-opening O3 (Chatwoot HMAC signing).** Inbound authentication is untouched by this change and remains a disclosed F2 SUGGESTION.
- **Any other Chatwoot event type.** `message_created` only, as in F2.
- **Media download, agent routing, correction sync.** Unchanged F2 non-goals.
- **A generalized multi-channel resolution abstraction.** See P1.
- **Re-verifying unaffected payload fields.** `account`, `conversation`, `sender`, `event`, `content`, `content_type`, `message_type`, `id`, `source_id` were confirmed to match already.

## Capabilities

### New Capabilities

None. This corrects an existing capability; it introduces nothing.

### Modified Capabilities

- `webhook-ingress`: the requirement "Tenant Resolution by wa_phone_number_id" (`openspec/specs/webhook-ingress/spec.md:41-69`) is **superseded** — same invariants (fail closed, unknown key refused with no rows written and no tenant inferred, operational log without message content), restated on `account.id` → `chatwoot_account_id`. The payload-shape assumptions behind it change with it.
- `data-model`: the "Delta: Tenant Resolver Role (F2 Extension)" block (`openspec/specs/data-model/spec.md:139-266`) is **superseded** — function signature, column-scoped grant, unknown-key-returns-NULL, and the no-`status`-predicate scenario all currently name `wa_phone_number_id`. The role, the `TO`-scoped `tenant_resolver_lookup` policy, the `SECURITY DEFINER`/owner/pinned-`search_path`/bare-`uuid` envelope, and the non-inheritable-membership requirement are **unchanged and must be re-proven, not relaxed**.

## Approach

Replace the resolution key end-to-end, integer-typed, in one coherent slice: real fixture → schema → `extractResolutionKey()` → TS resolver → SQL function + grant, with the security-boundary live tests re-proven on the new column before the change is considered done.

The security envelope established by F2's D-A/R1 work is treated as settled and preserved verbatim. Only the *predicate* and the *column reachable through the grant* move. Any change that would relax the envelope to make the fix easier is out of bounds.

## Product Decisions

Made in this proposal, with reasoning, per this project's practice of settling real architectural questions at proposal/design time rather than deferring them into a task list.

- **P1 — Replace the `wa_phone_number_id` resolution path outright; do not add a second path.** The tempting move is to keep the old resolver "for a future non-Chatwoot channel" and add `account.id` alongside it. Reject it, for three reasons. First, the phone-number path has **never resolved a single real request** since it shipped; there is no integration reachable today that exercises it, so "keeping it working" is keeping untested code that has never worked. Second, a second resolution path is not free in this codebase: it is a second permissive-policy surface, a second column exposed through the resolver role's grant, and a second set of negative-control and owner-control live tests that must stay green forever. The security proof is the expensive part, and dual paths double it to protect a hypothesis. Third, this project has repeatedly rejected speculative abstraction (see A1 and C1); building a channel-agnostic resolver before a second channel exists is exactly that. If a real second inbound channel ever arrives, it will bring its own payload shape and its own key, and the right generalization will be obvious then instead of guessed now. `brokers.wa_phone_number_id` survives as data; only the resolver stops reading it.
- **P2 — The resolution key is an integer end-to-end, not a `text` parameter with a cast at the boundary.** Keeping `dirus_resolve_broker_id(p_key text)` minimizes the diff, and that is its only merit. `chatwoot_account_id` is an integer with a UNIQUE index; a `text` parameter forces either `chatwoot_account_id::text = p_key` (which cannot use that index and makes a security-critical lookup quietly do a sequential scan on a table that grows with every broker) or an implicit cast whose failure mode is a runtime error rather than a miss. Typing it properly also **deletes a guard instead of adjusting it**: `MAX_KEY_LENGTH = 256` exists to bound an attacker-controlled unbounded string, and an integer parse is a strictly stronger validation than a length cap. Consequences, stated so `sdd-design` cannot skip them: `extractResolutionKey()` returns `number | null`; `ResolveBrokerId` becomes `(accountId: number) => Promise<string | null>`; `resolveBrokerIdByWaPhoneNumberId` is renamed (a function named after the wrong column is a future bug); and **the boundary must reject non-integer, non-positive, and out-of-`int4`-range values before the query runs**, or a Postgres numeric-overflow error surfaces as a 500 where the spec requires a clean refusal. That validation is a required scenario, not an implementation detail.
- **P3 — Ship as new migration `0007_chatwoot_account_resolution.sql`; `0004` is now immutable.** `0004_tenant_resolver.sql` has been applied against a real database (the developer's Neon dev project, this session). Editing an applied migration means the file and the deployed catalog disagree, which is precisely the divergence migrations exist to prevent. `0007` (next after `0006_broker_auth.sql`) does exactly four things, at intent level: (a) **`DROP FUNCTION` the old `(text)` signature** — since P2 changes the signature, `CREATE OR REPLACE` is unavailable, and leaving the old overload alive would leave a broken, still-`EXECUTE`-granted resolution path in the catalog; dropping it is the point, not a side effect; (b) create the new function preserving the full F2 envelope — `SECURITY DEFINER`, owned by `dirus_tenant_resolver`, `SET search_path = ''`, schema-qualified `public.brokers`, bound parameter, returns a bare `uuid`, **no `status` predicate** (F2's P5 stands: a suspended broker still resolves); (c) `REVOKE` the default `PUBLIC` `EXECUTE` on the new signature and `GRANT EXECUTE` to `dirus_app`; (d) **move the resolver role's column-scoped grant to `(id, chatwoot_account_id)` and revoke `wa_phone_number_id`** — this is mandatory and must land in the same migration, because a function that can read the row but not the column it filters on fails at runtime with a permissions error indistinguishable from "broker not found", i.e. a security-relevant failure that looks like a routine miss. The role itself and the `tenant_resolver_lookup` policy are `TO`-scoped, not column-scoped, and are not touched. No table structure changes; no new constraint (`chatwoot_account_id` is already `UNIQUE` and indexed). `sdd-design` writes the SQL.
- **P4 — This is a supersession of an archived capability's spec, not a new capability alongside it.** The wrong behaviour is currently written down as the contract in two merged specs. Adding correct requirements next to them would leave the repo asserting two mutually exclusive resolution keys, and the archived, already-verified one would keep winning by seniority. The deltas must replace those requirement blocks, and `sdd-archive` must merge them over the existing text — not append.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/schemas/src/webhooks/chatwoot.ts` | Modified | Drop `inbox.phone_number` and top-level `contact`; `extractResolutionKey()` → `account.id` (number) |
| `packages/schemas/test/fixtures/chatwoot-message-created.json` | Modified | Replaced with the real captured payload (closes F2 task 4.8 / O4) |
| `packages/schemas/test/*` | Modified | `chatwoot.test.ts`, `chatwoot-resolution-key-isolation.test.ts` |
| `packages/db/migrations/0007_chatwoot_account_resolution.sql` | New | Drop + recreate resolver function; `EXECUTE` and column-scoped `SELECT` grants (P3) |
| `packages/db/src/.../tenant-resolution.ts` | Modified | Rename + integer parameter; integer-range guard replaces `MAX_KEY_LENGTH` |
| `packages/db/test/migrations/tenant-resolver-migration.test.ts` | Modified | Literal-SQL assertions rewritten for `0007` |
| `packages/db/test/migrations/live-tenant-resolution.test.ts` | Modified | **The security proof.** All controls re-seeded and re-asserted on `chatwoot_account_id` |
| `apps/api/src/middleware/tenant-resolver.ts` | Modified | `ResolveBrokerId` type, log line, comments |
| `apps/api/src/routes/webhooks/chatwoot.ts` | Modified | Doc comments referencing the old key |
| `apps/api/test/routes/webhooks/chatwoot.test.ts` | Modified | Fixtures rebuilt on the real shape |
| `apps/api/test/live/webhook-ingress.live.test.ts` | Modified | End-to-end key/shape corrected |
| `openspec/specs/webhook-ingress/spec.md` | Modified | Requirement at :41-69 superseded (P4) |
| `openspec/specs/data-model/spec.md` | Modified | F2 Extension block at :139-266 superseded (P4) |
| `openspec/ROADMAP.md`, `openspec/PHASES.md` | Modified | F2.1 registered; F2's O4 closed |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **The column-scoped grant is forgotten or lands in a later commit than the function.** The function then fails with a permissions error that the resolver reports as "broker not found" — a security-relevant failure disguised as a routine miss. | Med | Grant and function ship in the same migration (P3). A live scenario must assert a **known** account id resolves non-`NULL` after `0007`, so a grant miss fails loudly instead of looking like a normal unknown-key path. |
| **The live-tenant-resolution suite is rewritten into something weaker.** It is the only real proof of the F2 security boundary; a rushed rewrite could quietly drop the negative control or the owner control. | Med | The spec delta re-states every control as an explicit scenario. `sdd-verify` checks control-by-control, not "suite green". Control count after must be ≥ control count before. |
| **`brokers.chatwoot_account_id` is unpopulated for an existing broker**, so a real webhook still 400s — same symptom, different cause. | Med | Confirm population for the live pilot broker as part of end-to-end verification; the unknown-key operational log (F2 P4) already makes this visible instead of silent. |
| **The captured payload is one instance from one Chatwoot version**, and self-hosted Chatwoot could change shape again. | Med | Fixture is committed with the captured version recorded, and required fields are narrowed to what was actually observed. `@provisional` markers are removed only for fields confirmed against reality. |
| **Type change ripples wider than forecast** (`number` vs `string` key through middleware and tests). | Low | `pnpm -r typecheck` makes this a compile error, not a runtime one — the strongest possible detection for this class. |
| Migration `0007` conflicts with an unmerged migration on another branch. | Low | Confirm `0006_broker_auth.sql` is the highest applied number before writing. |

## Rollback Plan

Revert the commit range and apply a down migration that restores `dirus_resolve_broker_id(p_key text)` filtering on `wa_phone_number_id`, restores the `(id, wa_phone_number_id)` column grant, and drops the integer-signature function — the drop/create/grant sequence must be scripted in the change, not improvised, exactly as F2's rollback required. The honest caveat: **rolling back returns ingress to a state that has never accepted a real webhook.** Rollback is a way to un-break something else this change touched, not a way to restore working ingress. No data is written or migrated by `0007`, so there is nothing to un-migrate.

## Dependencies

- `whatsapp-webhook-ingress` (F2) — archived; this change corrects it.
- `LIVE_TEST_DATABASE_URL` for the security-boundary suites (CI provides `pgvector/pgvector:pg17`).
- The running self-hosted Chatwoot instance in `infra/chatwoot/` for end-to-end confirmation. Unit and integration tests MUST NOT require it — the committed fixture carries the real shape.
- At least one `brokers` row with `chatwoot_account_id` populated to match the live instance's account.

## Success Criteria

- [ ] The committed fixture is the **real captured Chatwoot payload**, and it parses against the schema. F2 task 4.8 is closed and O4 is marked resolved in `ROADMAP.md`.
- [ ] The schema **rejects** a payload carrying the old invented shape (`inbox.phone_number`, top-level `contact`) as the tenant key source — the defect cannot silently return.
- [ ] `extractResolutionKey()` returns `account.id` as a number for the real payload, and `null` (not a throw) when `account.id` is absent or malformed.
- [ ] A non-integer, negative, or out-of-`int4`-range `account.id` is refused at the boundary with no query issued and no 500 (P2).
- [ ] A **real webhook POST from the live Chatwoot instance** resolves the correct broker and persists exactly one `messages` row with the right `broker_id`, `conversation_id`, and `contact_id`. This is the criterion F2 could not evaluate.
- [ ] An unknown `account.id` is refused with no rows written, no tenant inferred, and an operational log line containing no message content (F2 P4 preserved).
- [ ] A broker with a non-`active` `status` still resolves (F2 P5 preserved); the `0007` function body contains no `status` predicate.
- [ ] **Non-negotiable, re-proven live on the new column**: `dirus_app` calling the resolver successfully still reads **zero** `brokers` rows directly afterwards (negative control); an owner-owned function with the same body still returns `NULL` (owner control); the caller-created-`brokers`-relation hijack still fails; `tenant_isolation` is unchanged; no inheriting membership in `dirus_tenant_resolver` exists.
- [ ] The resolver role's grant is exactly `SELECT (id, chatwoot_account_id)` on `public.brokers`; `wa_phone_number_id` is no longer reachable through the resolver role.
- [ ] `dirus_resolve_broker_id(text)` no longer exists in the catalog after `0007`; `PUBLIC` holds no `EXECUTE` on the new signature and `dirus_app` does.
- [ ] `0004_tenant_resolver.sql` is byte-identical to its archived state.
- [ ] `pnpm -r typecheck` and `pnpm -r test` pass; `packages/schemas` still imports nothing from the workspace.
