# Wave 1 Design — SAFE-WILLOW + SAFE-SYNTH

**Purpose:** the test foundation every later tenant/provider P1 closure depends on.
No later tenant/provider P1 may be classified closed without the relevant Studio A/B/C
(SAFE-SYNTH) and Willow-contract (SAFE-WILLOW) evidence.

## Architecture decision — TWO dependency-ordered PRs

The two deliverables live on different existing test layers, so each is independently useful
and reviewable. Coupling them would make one large PR that mixes DB/RLS integration with
browser E2E for no benefit.

- **PR 1 — SAFE-SYNTH** (this slice; foundation). Deterministic Studio A/B/C synthetic tenants
  on the **local-only DB/RLS harness** (`tests/db/helpers/harness.ts`, localhost-pinned, never
  production/Willow), plus the cross-tenant **isolation matrix** — the negative-boundary
  primitive Wave 6 and every provider wave reuse.
- **PR 2 — SAFE-WILLOW** (follow-up). Willow's approved-workflow **behavioural contract** on the
  **browser E2E layer** (`e2e/helpers/seed.ts` + fake Stripe/Google + Mailpit), asserting the
  pilot workflow does not regress — using SYNTHETIC fixtures only; the suite never connects to or
  mutates Willow.

Dependency: PR 2 is conceptually downstream of PR 1's tenant model but uses the E2E seed layer,
so it does not import PR 1 code. Order is PR 1 first because it is the isolation foundation the
later waves block on.

## PR 1 — SAFE-SYNTH (implemented in this slice)

**Files:** `tests/db/helpers/synth-fleet.ts`, `tests/db/synth-fleet-isolation.db.test.ts` (the
`.db.test.ts` suffix routes it to the db-integration lane, `vitest.db.config.ts`; it is excluded
from the fast unit lane).

- **Studio A** — solo (owner). **Studio B** — owner + 2 practitioners. **Studio C** —
  failure/recovery, carries an inert `SynthFailureMode` switch (`provisioning | payment |
  revoked_oauth | provider_rejection | export | cancellation | legal_hold | purge |
  stale_worker_claim | retry_dead_letter`) consumed by later tests.
- **Identifiers:** studio name `SYNTH-<A|B|C>`, emails `*@synth.local`; all ids random UUIDs
  (parallel-safe, safe to recreate). Never shares an id space with production.
- **Cleanup:** `dropSynthStudio` deletes by id (studio cascade + fake auth.users); never truncates.
- **No providers/secrets** — pure local SQL via the harness `adminQuery`/`asUser`.
- **Isolation matrix (foundational negative test):** Studio A's owner cannot read / update /
  insert into Studio B's rows through RLS; positive control that B's owner reads B's own data.

**Runs in:** the `db integration (local supabase)` CI lane (real migrated schema). Not runnable
without a local Supabase stack; behaviour is CI-validated.

**Rollback:** test-only additions; revert the two files. No runtime/migration/flag impact.

## PR 2 — SAFE-WILLOW (design; next slice)

**File:** `e2e/safe-willow-contract.spec.ts`, on `seedE2eStudio()` + fake providers.

Behavioural contract scenarios (synthetic data), each asserting the approved outcome:
public booking · intake + consent (signed-consent visibility) · reminders/postcare (Mailpit
capture, no real send) · calendar + Move appointment · portal access · charting · observation/
narrative persistence + reload · Before Today treatment memory · treatment-photos metadata ·
approved payment/refund via **fake Stripe** · records/export · practitioner access · all Willow
provider gates unchanged. The suite MUST NOT connect to or mutate Willow (enforced by the
harness's localhost pin + synthetic seed).

## What Wave 1 does NOT do

No production change, no migration, no flag, no provider call, no Willow mutation. It builds the
evidence substrate; it does not itself close a tenant/provider P1 (those close in later waves
that consume this fleet). Gate A remains failing; no external studio is onboarded.
