-- policy-bulk-import (A1), proposal P5 / data-model delta "Partial Unique
-- Index on Numbered Policies": defines "the same policy" as a
-- (broker_id, policy_number) pair only when policy_number is present.
-- A plain UNIQUE (broker_id, policy_number) would behave identically in
-- every test that always supplies a policy_number (Postgres already treats
-- NULLs as distinct in a plain unique index too) but would misdescribe its
-- own intent; a PG15+ "distinct nulls" opt-out on the index is actively
-- destructive here — it would collapse every unnumbered policy for a
-- broker into a single row. See proposal.md P5 for the full comparison.
-- See test/migrations/policy-number-unique-index.test.ts (structural) and
-- test/migrations/live-policy-number-unique-index.test.ts (live proof).
CREATE UNIQUE INDEX "policies_broker_id_policy_number_index" ON "policies" USING btree ("broker_id","policy_number") WHERE "policies"."policy_number" IS NOT NULL;

-- Down path (documented, not scripted as a separate file — this migration
-- sequence has no down-migration runner; see 0004_tenant_resolver.sql's
-- same convention). Proposal Rollback Plan: "The index is additive;
-- dropping it cannot lose data, only permit duplicates that did not exist
-- before."
--
--   DROP INDEX "policies_broker_id_policy_number_index";