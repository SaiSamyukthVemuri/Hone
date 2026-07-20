# Wave 1 Design — SAFE-WILLOW + SAFE-SYNTH

**Purpose:** the test foundation every later tenant/provider P1 closure depends on.
No later tenant/provider P1 may be classified closed without the relevant Studio A/B/C
(SAFE-SYNTH) and Willow-contract (SAFE-WILLOW) evidence.

## Architecture decision — TWO dependency-ordered PRs

The two deliverables live on different existing test layers, so each is independently useful
and reviewable. Coupling them would make one large PR that mixes DB/RLS integration with
browser E2E for no benefit.

- **PR 1 — SAFE-SYNTH** (this slice; foundation, partially delivered). Run-unique Studio A/B/C synthetic tenants
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

## PR 1 — SAFE-SYNTH — PARTIALLY DELIVERED (this slice)

**Files:** `tests/db/helpers/synth-fleet.ts`, `tests/db/synth-fleet-isolation.db.test.ts`,
`tests/db/synth-fleet-cleanup.db.test.ts` (the `.db.test.ts` suffix routes them to the
db-integration lane, `vitest.db.config.ts`; excluded from the fast unit lane).

**Delivered in this slice:**
- **Studio A** — solo (owner). **Studio B** — owner + 2 practitioners. **Studio C** —
  failure/recovery shell that carries an **INERT `SynthFailureMode` label** (`provisioning |
  payment | revoked_oauth | provider_rejection | export | cancellation | legal_hold | purge |
  stale_worker_claim | retry_dead_letter`) — **vocabulary only; there is NO executable failure
  injection yet.**
- **Identifiers:** studio name `SYNTH-<A|B|C>`, emails `*@synth.local`; all ids are
  `randomUUID()` — **run-unique and parallel-safe** (they differ every run; this is NOT
  deterministic/stable-across-runs seeding). Never shares an id space with production.
- **Cleanup by id** (`dropSynthStudio`; studio cascade + fake auth.users; never truncates),
  **proven** by `synth-fleet-cleanup.db.test.ts` (zero residual rows across studios/
  practitioners/clients/auth.users; dropping A cannot touch B).
- **Isolation matrix:** Studio A's owner cannot read / update / insert into Studio B's rows
  through RLS; positive control that B's owner reads B's own data.
- **No providers/secrets** — pure local SQL via the harness.

**NOT yet delivered (named remaining scope for SAFE-SYNTH):**
- richer per-domain seeding (appointments, intake/consent, sessions/clinical, treatment-photo
  metadata, payment/provider test state);
- **executable failure injection for Studio C** — each `SynthFailureMode` wired to a real forced
  error / revoked token / rejected provider call / stale worker claim / dead-letter path.

**Runs in:** the `db integration (local supabase)` lane (real migrated schema). Not runnable
without a local Supabase stack; behaviour is CI-validated.

**Rollback:** test-only additions; revert the two files. No runtime/migration/flag impact.

## SAFE-WILLOW — dependency-ordered slice roadmap

SAFE-WILLOW is delivered as a sequence of behavioural-contract slices, each on `seedE2eStudio()`
(synthetic, local stack, never Willow) + fake providers. Status:

1. **Activation loop — MERGED** (`e2e/safe-willow-contract.spec.ts`, PR #454). book → intake/
   consent → chart chips+narrative → save → reload persistence → second visit → Before Today.
2. **Appointment lifecycle — THIS PR** (`e2e/safe-willow-appointment-lifecycle.spec.ts`). Owner
   Move (same-record / no-duplicate / scheduling-only / tenant-scoped) + owner authorization
   (non-owner denied) + cancel/reschedule/manage token **resolution** + cross-tenant token
   isolation. *Deferred within this area to a follow-up:* exercising cancel/reschedule **submit**
   + immutable policy/evidence snapshots.
3. **Client portal** — separate auth realm (portal magic-link via Mailpit → own-data-only →
   rebooking preserves studio context; another synthetic tenant cannot resolve the session).
   Its own slice because there is no existing portal E2E helper.
4. **Communications** — reminder + postcare intents; Mailpit delivery; no duplicate sends;
   consent + opt-out behaviour; **no real email/SMS**.
5. **Payments** — fake-Stripe card save → charge → refund; test/live mode isolation; persisted
   Hone canonical state; **analytics failure cannot affect the payment result**.
6. **Photos & records** — treatment-photo metadata; same-parent ownership; signed-URL behaviour
   on the local harness; records / print / export consistency.
7. **Clinical finalization** — enable finalization only on a synthetic tenant; immutable
   snapshot; direct mutation denied; attributable amendment/correction; observation + narrative
   agreement after finalization.
8. **Practitioner access & provider gates** — approved practitioner access; removed practitioner
   denied; Google / SMS / experimental controls remain off; no worker claims synthetic or Willow
   work unexpectedly.

Each slice must use synthetic IDs only, deterministic cleanup by captured IDs, and MUST NOT
connect to or mutate Willow (enforced by the harness localhost pin + synthetic seed). A slice
that exposes a real P1 defect is documented + classified against the master register and fixed in
a separate narrowly-scoped PR — the contract is never weakened to make CI green.

## What Wave 1 does NOT do

No production change, no migration, no flag, no provider call, no Willow mutation. It builds the
evidence substrate; it does not itself close a tenant/provider P1 (those close in later waves
that consume this fleet). Gate A remains failing; no external studio is onboarded.
