# Cancellation fee tiers — prepared, not released

The owner requested configurable cancellation notice and same-day rates, with self-service availability for all studios. The separate real Stripe TEST-mode smoke was explicitly waived for this change. Automated payment, duplicate-prevention, database and browser coverage remain required. No live card charge is part of verification.

## Product behaviour

- The studio owner sets a notice window (1–168 whole hours; starts at 48) and independently chooses percentage or fixed amount for each of two rates.
- A cancellation on the appointment's local calendar date uses the same-day rate. Otherwise strictly less than the notice window uses the notice rate. Exactly the notice threshold or earlier has no cancellation fee. Missing/invalid timing, timezone, or an after-start cancellation refuses; it never guesses a no-show.
- A studio can keep an existing published notice-window and same-day policy as it is. No policy text, client acknowledgement or authorization signature is rewritten. Existing single-rate settings do not enroll a studio in the new model.
- Saving valid rules against the reviewed, current policy leaves cancellation fees OFF. A separate owner confirmation turns them on. Every studio can use this command; there is no per-studio cancellation-release environment list. No-show release controls and settings remain independent.
- A current signed card authorization, the appointment's matching acknowledged policy, ready Stripe connection, verified jurisdiction, usable session price and deliberate charge confirmation are still required. Saving/enabling never charges a card.
- Every settings command uses the owner's session, re-derives owner authority in the database and checks the exact revision. Changes are recorded. Prepared fees freeze their selected tier and timing; changes to policy, timing or rules block sending and require cancellation/re-preparation. Already sent attempts retain reconciliation/refund access.

## Database boundary and deployment order

Migration `supabase/migrations/0357_cancellation_fee_tiers.sql` is new. Whether it is applied is recorded only in `docs/production/migration-state.json` and `docs/production/migration-ledger.md`. It adds two tables (owner-readable rules and history), two owner-only commands and an immutable attempt snapshot guarded at prepare/claim. No studio row is inserted and no fee is enabled by the migration. Runtime roles cannot directly write the new tables. Session-payment and no-show attempts retain their existing path.

This release includes no schema unrelated to cancellation tiers.

1. Complete required CI, the real fresh-chain database lane, browser/payment lanes and an independent review at the final application/migration head.
2. Prepare the isolated **0357-only** reviewed migration package and hashes. Run a read-only production preflight: verify current migration history/catalog, 0357 absent, new objects absent, existing payment attempts and outstanding work, and that only 0357 would be pushed. Record exact results; this document is not evidence that the preflight ran.
3. Obtain explicit authorization naming that package. Old 0351–0354 approvals do not cover 0357. Do not push the entire checkout or use `--include-all`.
4. Apply/read back/reconcile **0357 only**. Verify grants, trigger, empty enrollment and unchanged pre-existing settings/policy evidence. Record the actual hosted result in the canonical record.
5. Release the application only after schema read-back. With a new app on the old schema, cancellation configuration is unavailable and charging refuses; no session payment query depends on the new table. With an old app on the new schema, the original live-release gate remains. Once a studio adopts tiers, its old prepared attempts cannot bypass the new claim guard.
6. Each studio owner reviews the published policy, saves the two rates, then turns the cancellation switch on. Confirm server-derived **Active** only when payment readiness also passes. Existing legacy ON flags do not make this Active. After a studio adopts tiers, obsolete single-rate settings writes refuse rather than falsely reporting that an older tab disabled or changed the active rules. This step is not performed by a migration or deployment.

## Verification and rollback

Focused pure timing tests cover exact thresholds, local midnight and both DST edges. Action/component tests cover owner-only RPCs, valid rate parsing, policy review, separate enablement, stale results, saved-versus-active state and retained drafts. The full-chain DB suite includes cross-studio authority, direct-write privilege closure, concurrent revision CAS, audit history and stale prepared-attempt refusal. The browser spec verifies persistence and zero attempt creation during setup. Existing money-movement call-site gates and full payment regressions remain required.

Local database proof used the real PostgreSQL engine (PGlite with pgcrypto) with a synthetic dependency fixture and this exact migration: authority, CAS, grant refusal, distinct rates, immutable timing, changed-rule refusal, same-day claim and policy changes passed. This is **not** a full Supabase fresh-chain run. This workspace has no Docker; the owned fresh Supabase chain and browser coverage must run in CI. No hosted database was changed for testing.

Rollback is a redeploy of the last reviewed application that retains the empty late-cancellation rollout list, not deletion of audit tables, policy acknowledgements or payment history. In-flight attempts are reconciled with their original provider identity; an uncertain charge is never retried to test rollback. Owners can turn cancellation fees OFF at any time, including after a policy change. Do not drop schema with financial evidence as routine cleanup.
