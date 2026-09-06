# DIRUS — SDD Phase Map

Where each change stands in the pipeline, and what each phase is actually for.

`ROADMAP.md` answers **which changes** we build and in what order. This file answers **which phase** each change is in, and why the phases are separate at all.

---

## The pipeline

```
explore ──▶ propose ──▶ spec ──┬──▶ tasks ──▶ apply ──▶ verify ──▶ archive
                        │      │
                        └──▶ design ──┘
```

`spec` and `design` both read the proposal and do not read each other. They can run in parallel. `tasks` needs both.

---

## What each phase does

| Phase     | Question it answers                                              | Produces                | Why it is its own phase                                                                                                  |
| :-------- | :--------------------------------------------------------------- | :---------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| `explore` | What already exists? What are the options?                       | `explore` notes         | Prevents proposing against an imagined codebase. Skippable when the ground is already known.                             |
| `propose` | What are we changing, and what are we deliberately NOT changing? | `proposal.md`           | Scope and non-goals get written down before anyone is emotionally invested in code. Non-goals are the load-bearing half. |
| `spec`    | How do we know it is correct?                                    | `specs/*/spec.md`       | The acceptance contract. Requirements + scenarios, testable. A spec you cannot execute is a wish.                        |
| `design`  | How do we build it, given the constraints?                       | `design.md`             | Mechanism and tradeoffs. Reading the spec adversarially is what exposes its holes — see below.                           |
| `tasks`   | What is the ordered work, in reviewable slices?                  | `tasks.md`              | Turns intent into a checklist and forecasts review load before a 900-line PR exists.                                     |
| `apply`   | Build it.                                                        | code + `apply-progress` | Implementation against a contract that was agreed first.                                                                 |
| `verify`  | Does the implementation satisfy the spec?                        | `verify-report`         | Checks against the written scenarios, not against vibes or "it runs".                                                    |
| `archive` | Close it.                                                        | `archive-report`        | Merges delta specs into the main specs and closes the change.                                                            |

### Why the separation earns its keep

This is not ceremony. On `scaffold-monorepo`, writing the **design against the spec** surfaced two defects the spec had missed:

1. **No scenario blocked a cross-tenant INSERT.** The spec covered SELECT, UPDATE and DELETE isolation. A policy with `USING` but no `WITH CHECK` would have passed every one of those tests while letting broker A insert rows attributed to broker B.
2. **`current_setting('app.broker_id')` vs the two-argument form.** The spec required "zero rows when unset". Only `current_setting(name, true)` produces that; the one-argument form raises an exception instead.

Both would have shipped silently if the work had gone straight from idea to implementation.

---

## Current state

### `scaffold-monorepo` (F1 — foundation, blocks everything)

| Phase   | Status   | Artifact                                                                    |
| :------ | :------- | :-------------------------------------------------------------------------- |
| explore | skipped  | greenfield; context lives in `docs/ARCHITECTURE.md`                         |
| propose | done     | `changes/scaffold-monorepo/proposal.md`                                     |
| spec    | done     | `changes/scaffold-monorepo/specs/{data-model,workspace-foundation}/spec.md` |
| design  | done     | `changes/scaffold-monorepo/design.md`                                       |
| tasks   | **next** | —                                                                           |
| apply   | pending  | —                                                                           |
| verify  | pending  | —                                                                           |
| archive | pending  | —                                                                           |

### `extraction-schemas` (B1 — extraction schemas, blocks B2)

| Phase   | Status   | Artifact                                                                    |
| :------ | :------- | :-------------------------------------------------------------------------- |
| explore | skipped  | fast-forward from proposal/ticket; context in `docs/ARCHITECTURE.md:255`    |
| propose | done     | `changes/archive/2026-09-04-extraction-schemas/proposal.md`                 |
| spec    | done     | `changes/archive/2026-09-04-extraction-schemas/specs/extraction-schemas/spec.md` & `specs/extraction-schemas/spec.md` (merged) |
| design  | skipped  | fast-forward; no design.md                                                  |
| tasks   | done     | `changes/archive/2026-09-04-extraction-schemas/tasks.md`                    |
| apply   | done     | `changes/archive/2026-09-04-extraction-schemas/apply-progress.md`           |
| verify  | done     | `changes/archive/2026-09-04-extraction-schemas/verify-report.md` (PASS, 0 CRITICAL, 2 disclosed WARNINGs) |
| archive | **done** | `changes/archive/2026-09-04-extraction-schemas/` + archive-report           |

### `whatsapp-webhook-ingress` (F2 — foundation, enables A2 and B2)

| Phase   | Status   | Artifact                                                                    |
| :------ | :------- | :-------------------------------------------------------------------------- |
| explore | skipped  | context in `docs/ARCHITECTURE.md` §1-14; proposal covers exploration implicitly |
| propose | done     | `changes/archive/2026-09-04-whatsapp-webhook-ingress/proposal.md`           |
| spec    | done     | `changes/archive/2026-09-04-whatsapp-webhook-ingress/specs/{webhook-ingress,data-model}/spec.md` & `specs/{webhook-ingress,data-model}/spec.md` (merged) |
| design  | done     | `changes/archive/2026-09-04-whatsapp-webhook-ingress/design.md`             |
| tasks   | done     | `changes/archive/2026-09-04-whatsapp-webhook-ingress/tasks.md` (63/64 complete; 4.8 deferred) |
| apply   | done     | `changes/archive/2026-09-04-whatsapp-webhook-ingress/apply-progress.md`     |
| verify  | done     | `changes/archive/2026-09-04-whatsapp-webhook-ingress/verify-report.md` (PASS, 0 CRITICAL, 0 WARNING, 2 disclosed SUGGESTIONs) |
| archive | **done** | `changes/archive/2026-09-04-whatsapp-webhook-ingress/` + archive-report     |

### `policy-bulk-import` (A1 — policy import, enables A2)

| Phase   | Status   | Artifact                                                                    |
| :------ | :------- | :-------------------------------------------------------------------------- |
| explore | skipped  | fast-forward from proposal/ROADMAP; context in `docs/ARCHITECTURE.md` §3    |
| propose | done     | `changes/archive/2026-09-05-policy-bulk-import/proposal.md`                 |
| spec    | done     | `changes/archive/2026-09-05-policy-bulk-import/specs/{policy-import,data-model}/spec.md` & `specs/{policy-import,data-model}/spec.md` (merged) |
| design  | skipped  | fast-forward; no separate design.md (scope resolved in proposal Product Decisions round 2) |
| tasks   | done     | `changes/archive/2026-09-05-policy-bulk-import/tasks.md` (7 phases, 59 tasks, all complete) |
| apply   | done     | `changes/archive/2026-09-05-policy-bulk-import/apply-progress.md` (all phases implemented, 2 disclosed findings) |
| verify  | done     | `changes/archive/2026-09-05-policy-bulk-import/verify-report.md` (PASS, 0 CRITICAL, 2 disclosed non-blocking findings) |
| archive | **done** | `changes/archive/2026-09-05-policy-bulk-import/` + archive-report           |

### All other changes

Not started. See `ROADMAP.md` for the sequence and the blocking preconditions on `ingestion-agent` (golden dataset) and `renewal-agent` (Meta HSM approval).

---

## Open items carried into `tasks`

These must be closed before `scaffold-monorepo` can be archived.

1. **Add the missing cross-tenant INSERT scenario** to `data-model/spec.md`. Surfaced by design decision D-D, deliberately not patched there — the spec is the contract, and design silently editing it would make the contract meaningless.
2. **Reword the "FORCE applies to the table owner" scenario.** It is not verifiable on Neon as written: Neon's default owner role belongs to `neon_superuser`, which carries `BYPASSRLS`, and `BYPASSRLS` defeats policies regardless of `FORCE`. Isolation must be proven with the non-owner `dirus_app` role instead.
3. **Confirm the Neon project exposes a pooled endpoint.** If not, `ALLOW_UNPOOLED_RUNTIME` is the documented interim escape hatch.

---

## Session settings (cached)

| Setting           | Value         | Effect                                                                                                                                                 |
| :---------------- | :------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution mode    | `interactive` | Each planning phase stops for review before the next launches.                                                                                         |
| Artifact store    | `hybrid`      | OpenSpec files in-repo + Engram. **Engram is currently unavailable** — every artifact so far is filesystem-only and needs backfill when it reconnects. |
| Delivery strategy | `ask-on-risk` | Asks whether to split only when the tasks forecast flags review-budget risk.                                                                           |

---

## Commands

| Command                  | Use                                      |
| :----------------------- | :--------------------------------------- |
| `/sdd-status [change]`   | Where does a change stand                |
| `/sdd-continue [change]` | Run the next dependency-ready phase      |
| `/sdd-new <change>`      | Start a new change (explore + propose)   |
| `/sdd-ff <change>`       | Fast-forward the planning phases         |
| `/sdd-apply [change]`    | Implement pending tasks                  |
| `/sdd-verify [change]`   | Validate implementation against the spec |
| `/sdd-archive [change]`  | Close a completed change                 |
