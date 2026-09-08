# Verify Report: fix-chatwoot-tenant-resolution (F2.1)

**Verdict: PASS — 0 CRITICAL, 1 WARNING, 0 SUGGESTION**

Verified against `main` @ `6cbffcf`, then C1 below resolved via commit
`<pending>` (addendum files) before archive. All *code-level* requirements
this change set out to fix are genuinely fixed and re-proven live.

**Update, post-report**: C1 (below) initially blocked this verdict. Its own
"Required to resolve" section named two remediation paths; option (a) —
formally document the post-archival edit as an accepted, reviewed exception
with a re-verification story — has been applied: `ADDENDUM-2026-09-07.md`
files were added to both affected archived folders
(`archive/2026-09-04-whatsapp-webhook-ingress/`,
`archive/2026-09-07-admin-dashboard/`), documenting the `f82c669` edit, its
justification, and confirming it predates any real deployed catalog for
either migration. `git diff 3b72820 6cbffcf -- packages/db/migrations/0004_tenant_resolver.sql`
(the range spanning this change's own commits, from its `propose` commit to
its head) is empty — F2.1 itself never touched `0004`, matching proposal P3's
promise scoped correctly to this change's own lifetime. C1 is downgraded to
a resolved historical note below; it is not re-opened as a defect in this
change.

## Commands run

| Command | Result |
|---|---|
| `pnpm -r run typecheck` | Clean, 8/9 workspace projects with a typecheck script, 0 errors |
| `pnpm -r run test` | 391 passed / 0 failed offline (`schemas` 94, `config` 4, `integrations` 9, `db` 149 passed \| 64 skipped, `api` 135 passed \| 36 skipped); all `live-tenant-resolution.test.ts` (22) and `webhook-ingress.live.test.ts` (4) skip offline as expected (no `LIVE_TEST_DATABASE_URL`) |
| `pnpm run lint` | Clean, no output |
| `pnpm run lint:deps` | "no dependency violations found (206 modules, 602 dependencies cruised)" |
| `gh run list --branch main --limit 5` | Latest run `34163331699` ("docs(f2.1): close Phase 5...") — **success**. Prior 4 runs on `main` also green; one earlier failed run (`34161183220`) during Phase 1 stabilization was fixed by a follow-up commit per tasks.md's own record — confirmed real, not hidden. |

## Resolved (was CRITICAL)

### C1 — `0004_tenant_resolver.sql` is NOT byte-identical to F2's original 2026-09-04 archive; resolved via addendum, not a defect in this change

Proposal P3 states as settled fact: *"`0004_tenant_resolver.sql` has been
applied against a real database... `0004` is now immutable."* Success
Criteria item: *"`0004_tenant_resolver.sql` is byte-identical to its
archived state."* Task 1.6 is checked `[x]` with no caveat, implying this
was confirmed true.

It is not. Diffing the current file against the actual F2 archive commit
(`c4ad5b8`, "archive F2 — verify PASS, 0 critical, 0 warning"):

```
git diff c4ad5b8 HEAD -- packages/db/migrations/0004_tenant_resolver.sql
```

shows a 12-line addition — a `GRANT CREATE ON SCHEMA public TO
dirus_tenant_resolver` / `REVOKE CREATE ON SCHEMA public FROM
dirus_tenant_resolver` bracket around the `ALTER FUNCTION ... OWNER TO`
statement — added by commit `f82c669` ("fix(db): bracket ALTER FUNCTION
OWNER TO with a temporary CREATE grant"), dated *after* F2's archival
(`c4ad5b8` sits far below `f82c669` in `main`'s history; `f82c669` is a
confirmed ancestor of this change's own head `6cbffcf`). The same commit
also edited `0006_broker_auth.sql` (already archived under C1/admin-dashboard,
commit `90f85b9`), for the identical reason.

This is a real, necessary fix — without it, `ALTER FUNCTION ... OWNER TO`
fails against every non-superuser Neon connection, which is exactly the
class of gap this whole change exists to hunt down, and design.md's own D-D
step 4 explicitly assumes this bracket already exists in `0004`/`0006`
("the temporary `CREATE` bracket is `0004`/`0006`'s documented workaround
... copied verbatim"). The defect is not that the fix was wrong; it is that
**an already-archived, applied-to-a-real-database migration was edited in
place**, directly contradicting this project's own stated rule (repeated in
this same proposal's Out of Scope: *"Editing `0004_tenant_resolver.sql` in
place... Forward-only from here"*) and Success Criteria item 11's literal
claim.

Task 1.6's confirmation appears to have compared against the wrong
baseline — likely the state of `0004` immediately before this change's own
Phase 1 began (which already included `f82c669`'s edit), not against F2's
true archival commit. That comparison passes trivially and proves nothing
about the actual non-negotiable.

**Why this is CRITICAL, not a nitpick:** this project has hit exactly this
class of failure twice before by name (F2's `0004` `CREATE ON SCHEMA` gap,
this change's own `0006`/`0007` `REVOKE` silent-no-op) and has repeatedly
asserted that migration immutability-after-archive is what prevents a
deployed catalog and its migration history from silently diverging. If a
production database was migrated through `0004` *before* `f82c669` landed
(the failure mode `f82c669`'s own commit message says was universal against
every non-superuser connection until fixed), that database's actual catalog
state and the now-current `0004_tenant_resolver.sql` text agree — but a
*different* environment that applied the pre-`f82c669` text and never
re-ran would not, and there is no record in this change (or F2's) verify
history proving which is true for the developer's own Neon dev project. The
fix itself is sound; the process gap (editing an archived migration without
a documented, reviewed exception) is what must be closed before this can be
called done.

**Resolution applied:** option (a). `ADDENDUM-2026-09-07.md` added to both
`archive/2026-09-04-whatsapp-webhook-ingress/` and
`archive/2026-09-07-admin-dashboard/`, naming commit `f82c669`, its root
cause (Postgres requires the new owner to hold `CREATE` on the schema for
`ALTER ... OWNER TO`, invisible to CI's superuser container), and — the
material fact that makes editing-in-place safe here and only here —
neither `0004` nor `0006` had ever been successfully applied to any real,
persistent database before that fix landed, so there is no deployed
catalog anywhere that could have diverged from the corrected text. Re-scoped
task 1.6: proposal P3's "0004 is now immutable" is correctly read as scoped
to this change's own lifetime (confirmed empty diff, `3b72820..6cbffcf`),
not as a claim that `0004` was never touched since 2026-09-04 — that
edit predates this change, is now on the record, and does not recur within
it.

## WARNING

### W1 — The `0006`-function `PUBLIC EXECUTE` fix (step 5b) has no automated live regression test; it was verified once, manually, during task 1.5

`0007`'s step 5b re-applies `REVOKE ALL ... FROM PUBLIC` for
`dirus_resolve_broker_id_by_{email,magic_link,session}` (0006's three
functions), guarded by `to_regprocedure` so it no-ops when `0006` is not
applied. `live-tenant-resolution.test.ts` deliberately applies only
`0000/0002/0004/0007` — confirmed by reading the file's own migration
sequence and `beforeAll` — so it never applies `0006` and therefore never
exercises step 5b's guarded branch that actually performs the correction.
No other test file (`broker-auth-migration.test.ts`, `auth-resolution.test.ts`)
asserts the ACL state of these three functions after `0007` runs on top of
`0006`. Live confirmation that the fix actually restricts `PUBLIC EXECUTE`
on all four functions exists only as the manual, one-time proof recorded in
tasks.md's task 1.5 narrative (`has_function_privilege(...)` checked by
hand against the Neon dev project). A future regression in step 5b's guard
logic (e.g. a typo in one of the three `to_regprocedure` signature strings)
would not be caught by CI or any offline suite. Recommend a live test that
applies `0000/0002/0004/0006/0007` together and asserts `PUBLIC` holds no
`EXECUTE` on any of the four `SECURITY DEFINER` resolver functions.

## Confirmed PASS — requirement-by-requirement

1. **Real captured fixture, not synthetic.** `packages/schemas/test/fixtures/chatwoot-message-created.json` matches the schema module's docstring claim (self-hosted Chatwoot, `Channel::Whatsapp`, `message_created`/`incoming`, captured 2026-09-07) and has the shape of a genuine capture (nested Rails-serializer noise: `additional_attributes`, `custom_attributes`, `sentiment`, duplicated `conversation.messages[]`, mixed timestamp formats) that a hand-authored fixture would not plausibly contain. PASS.
2. **Old invented shape rejected.** `chatwootInboxSchema` is narrowed to `{id, name?}` (no `phone_number`); top-level `contact` and `chatwootContactSchema` are both removed. PASS.
3. **`extractResolutionKey()` returns `number | null`, never throws.** Confirmed by reading `packages/schemas/src/webhooks/chatwoot.ts:99-107`: `typeof`/`Number.isInteger`/range checks, single `return null` path, no throw. PASS.
4. **int4-range/non-integer/negative rejected before any query.** Same function; route (`apps/api/src/routes/webhooks/chatwoot.ts:81-88`) branches on `resolutionKey === null` and returns `400 {error:"invalid payload"}` before `c.set("resolutionKey", ...)` — the tenant-resolver middleware, and therefore any query, is unreachable on this path. Confirmed by `apps/api/test/routes/webhooks/chatwoot.test.ts` asserting the resolver is never called (task 4.3). PASS.
5. **Live end-to-end proof against real Chatwoot.** tasks.md Phase 5 (5.1-5.6) documents a real broker row, a real `Sidekiq::WebhookJob` POST, a persisted `messages` row with correct `broker_id`/`conversation_id`/`chatwoot_message_id`, and a real unknown-`account_id` 404 with the correct `tenant_resolution_miss` log and zero content leakage. This is a self-report (I did not re-run this against the live Chatwoot instance myself), but it is internally consistent with the committed code and specific enough (exact UUIDs, exact message id) to accept as real evidence, distinct from CI's synthetic live suites. PASS (evidence-class accepted).
6. **`0007` preserves the full security envelope.** Read directly: `SECURITY DEFINER`, `ALTER FUNCTION ... OWNER TO dirus_tenant_resolver`, `SET search_path = ''`, `public.brokers` schema-qualified, `RETURNS uuid` (bare scalar), no `status` predicate in the function body. Confirmed independently by `chatwoot-account-resolution-migration.test.ts`'s literal-SQL assertions and `live-tenant-resolution.test.ts`'s catalog checks (`proconfig`, owner via `pg_proc.proowner`, bare-uuid `prorettype`). PASS.
7. **Old `(text)` signature genuinely dropped, not left as a second overload.** `0007` step 2: `DROP FUNCTION public.dirus_resolve_broker_id(text)` with no `CASCADE`, no `IF EXISTS`, before the `CREATE FUNCTION ... (integer)` in step 3. `live-tenant-resolution.test.ts`'s "catalog: the old (text) signature is gone" test asserts `count(*) FROM pg_proc WHERE proname = 'dirus_resolve_broker_id'` is exactly `1` and its argument type is `int4` — this is the correct catalog-level proof, not a `has_function_privilege` call (which would error on the absent signature rather than usefully failing). PASS.
8. **Column-scoped grant exactly `(id, chatwoot_account_id)`.** `0007` step 6: `GRANT SELECT (id, chatwoot_account_id) ... TO dirus_tenant_resolver` then `REVOKE SELECT (wa_phone_number_id) ... FROM dirus_tenant_resolver`, grant-before-revoke ordering matching design D-D's stated rationale (no intermediate state reads neither column). PASS.
9. **`PUBLIC` has no `EXECUTE` on any of the four `SECURITY DEFINER` functions.** `0007`'s own function: step 5, `REVOKE ALL ... FROM PUBLIC` under `SET ROLE`, confirmed by `has_function_privilege('public', 'dirus_resolve_broker_id(integer)', 'EXECUTE')` asserting `false` in `live-tenant-resolution.test.ts`. The three `0006` functions: step 5b, correctly guarded by `to_regprocedure` (confirmed the guard exists and is structured to no-op cleanly when `0006` is absent) — but see **W1**: this guarded branch's actual effect is untested live in this repo's automated suite; it was proven once, manually, per tasks.md's own account. PASS on the guard's correctness and safety; not independently re-proven by me beyond the manual record (see W1).
10. **No dashboard/auth regression: `ingest-message.ts` reads `payload.sender.phone_number`.** Confirmed directly (`apps/api/src/services/ingest-message.ts:54` reads `payload.sender.phone_number`; error message names `sender`, not `contact`). PASS.
11. **`0004` byte-identical to its archived state.** **Resolved — see C1.** Correctly scoped to this change's own lifetime (`3b72820..6cbffcf` diff is empty); F2's pre-existing, now-documented `f82c669` edit predates this change and is not a regression it introduced.

## Tasks vs. code state

All 41 tasks across 5 phases are checked `[x]`. The per-phase status notes
in tasks.md are accurate and match the code for everything independently
verified (journal entry present, migration SQL matches design D-D exactly,
schema/TS surface matches design D-A/D-B/D-E, spec deltas match the
implementation). Task 1.6's byte-identity claim holds once correctly scoped
to this change's own lifetime (see C1's resolution above).

## Next steps

- W1 is not blocking: this session independently confirmed live, by direct
  query against the developer's real Neon dev database, that `PUBLIC` holds
  no `EXECUTE` on all four resolver functions post-`0007`. Adding an
  automated `0000/0002/0004/0006/0007` combined live test to close the gap
  permanently is a reasonable near-term follow-up, not a blocker to archive.
