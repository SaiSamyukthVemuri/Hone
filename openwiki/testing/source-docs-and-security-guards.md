---
type: test infrastructure
title: Source, docs and security guard tests
description: The static guard tests that pin Hone's architecture and its written truth — security censuses (direct DML, grants, service-role allowlist, route privacy, secret logging), source guards over boundaries, canonical-production-facts and docs-drift guards, dependency and lint boundaries — with what each family parses, what it pins, how it can pass vacuously, and the anti-vacuity controls that answer that.
tags: [guards, static-analysis, security-tests, docs-tests, lint, testing]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-eb10efb7264b39a67076cb7b
    resource: repo://docs/09_DATABASE_AND_RLS.md
  - id: openwiki-source-3ad934bbd2c1fea4924f842a
    resource: repo://ENGINEERING_STANDARDS.md
  - id: openwiki-source-2fda883e9b76745f69f487f7
    resource: repo://eslint.config.mjs
  - id: openwiki-source-42990f8f33dbeb405bfb38a5
    resource: repo://lib/export/resource-registry.ts
  - id: openwiki-source-307b89c0dd174ad458e73fdb
    resource: repo://tests/dependencies/server-only-explicit.test.ts
  - id: openwiki-source-84ee60a98182dfa16e1f3603
    resource: repo://tests/docs/canonical-production-facts.test.ts
  - id: openwiki-source-68fb49d65cba642bd3811eda
    resource: repo://tests/docs/helpers/canonical-facts.ts
  - id: openwiki-source-dea5ed3bec7535c7dde9ac02
    resource: repo://tests/docs/reminder-cadence-truthfulness.test.ts
  - id: openwiki-source-746caa4127e2db9c4b34e509
    resource: repo://tests/security/appointment-direct-dml-guard.test.ts
  - id: openwiki-source-dfb951c77b8f835845bbc3a0
    resource: repo://tests/security/clinical-rpc-grant-guard.test.ts
  - id: openwiki-source-25c359515eaed4aba01f2d9c
    resource: repo://tests/security/helpers/supabase-write-census.ts
  - id: openwiki-source-b475a8a037794f6f3e2a246e
    resource: repo://tests/security/public-booking-command-guard.test.ts
  - id: openwiki-source-4630651917db5ef9e829d6c5
    resource: repo://tests/security/public-reschedule-command-guard.test.ts
  - id: openwiki-source-21736b3c0410191d83269329
    resource: repo://tests/security/service-role-allowlist.test.ts
  - id: openwiki-source-833044c4d4591cb2eabb5a7e
    resource: repo://tests/security/service-role-allowlist.ts
  - id: openwiki-source-ba868632e8464a6577a469da
    resource: repo://tests/security/waitlist-delivery-secret-logging.test.ts
  - id: openwiki-source-ebe7fa1cf3266063612132b7
    resource: repo://tests/source-guards/client-facing-email-identity.test.ts
  - id: openwiki-source-0582c36203d5768a46494c0c
    resource: repo://tests/source-guards/export-copy-truth-guards.test.ts
  - id: openwiki-source-ed2c861e3dc9090b42cc7f1c
    resource: repo://tests/source-guards/lease-fencing-family.test.ts
  - id: openwiki-source-b34eea9e5fa2a5bfe2e56d48
    resource: repo://tests/source-guards/sms-adoption-boundary.test.ts
  - id: openwiki-source-80bc5185d95430a1f19fc11d
    resource: repo://tests/source-guards/supabase-temp-untracked.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Source, docs and security guard tests

`ENGINEERING_STANDARDS.md` ranks proof in this order:

1. real database behaviour;
2. server actions;
3. components;
4. browser;
5. **source and static contract tests** (last).

Static tests are **tripwires**: right for "no forbidden writer or symbol exists", wrong as a substitute for
behaviour that can be tested. An important *absence* claim must also prove the detector works
([§ 4. Proof](../../ENGINEERING_STANDARDS.md#4-proof)). Each family below is described by what it reads, what it
pins and where it can go silent.

All of these run in the ordinary unit lane (`npm test`), so CI runs them in the `validate` job. That job does
**not** run for a docs-only diff — see [CI workflows and risk lanes](ci-workflows-and-risk-lanes.md).

## 1. Security guards (`tests/security/`)

| Guard | Parses | Pins | Vacuity risk and its control |
|---|---|---|---|
| **Supabase write census** ([`helpers/supabase-write-census.ts` L5-L46](../../tests/security/helpers/supabase-write-census.ts#L5-L46)) | runtime TypeScript under `app`, `lib`, `components`, `scripts` and `middleware`, using the **TypeScript compiler API** and resolving table and payload through same-scope bindings | every `.from(t).insert/update/upsert/delete` site | an analyzer that finds nothing looks like a clean tree. It **fails closed**: unresolvable tables or payloads are reported, never skipped |
| **Appointment direct-DML guard** ([`appointment-direct-dml-guard.test.ts` L518-L580](../../tests/security/appointment-direct-dml-guard.test.ts#L518-L580)) | the census | **zero** direct `appointments` writers since B8 (`0177`), no runtime writer of `appointment_audit`, no cookie-client writer | zero is only asserted alongside positive controls: more than 100 write sites overall and more than 20 resolved writes to other tables |
| **Entry direct-DML guard** (`entry-direct-dml-guard.test.ts`) | the census | no direct runtime DML on the charting tables after L18 | same census controls |
| **Clinical RPC grant guard** ([`clinical-rpc-grant-guard.test.ts` L5-L49](../../tests/security/clinical-rpc-grant-guard.test.ts#L5-L49)) | migration SQL **text** | authenticated-only commands revoke from `public`, `anon` and `service_role`; helpers stay ungranted | textual and deliberately narrow — it only looks at functions that require `auth.uid()`, and trigger functions are excluded by design |
| **Service-role allowlist** ([`service-role-allowlist.test.ts` L49-L117](../../tests/security/service-role-allowlist.test.ts#L49-L117)) | `grep` for `createAdminClient()` under `app/` and `lib/` | the call-site set equals the allowlist; each entry's scope-guard string is present in its file | proves a guard **symbol** exists, not that every query is scoped ([`service-role-allowlist.ts` L1-L11](../../tests/security/service-role-allowlist.ts#L1-L11)) |
| **Command guards for public booking and reschedule** ([`public-booking-command-guard.test.ts`](../../tests/security/public-booking-command-guard.test.ts#L1-L20), [`public-reschedule-command-guard.test.ts`](../../tests/security/public-reschedule-command-guard.test.ts#L1-L20)) | route source text | each route mutates only through its reviewed command; no caller-supplied duration, detached policy insert or post-commit re-read | textual; the behavioural DB suites prove the commands themselves |
| **Practitioner embed guard** (`appointment-practitioner-embed-guard.test.ts`) | PostgREST select strings | every `appointments → practitioners` embed names its FK, after `0174` added a second FK | textual |
| **Route privacy** ([`waitlist-invitation-route-privacy.test.ts` L317-L438](../../tests/security/waitlist-invitation-route-privacy.test.ts#L317-L438)) | **every** dynamic route directory under `app/` | each is a registered token route or explicitly classified as non-bearer | inverted default — an unknown route **fails** |
| **Secret logging** ([`waitlist-delivery-secret-logging.test.ts`](../../tests/security/waitlist-delivery-secret-logging.test.ts#L1-L12)) | delivery source | the invitation token and the proof code never reach a log, alert or telemetry payload, in any hashed, truncated or prefixed form | — |

What these protect is described on [RLS, grants and SECURITY DEFINER commands](../security/rls-grants-and-security-definer.md)
and [Public token routes and privacy](../security/public-token-routes-and-privacy.md).

## 2. Source guards (`tests/source-guards/`, 25 files)

Each pins one boundary in source. Each typically states that the behavioural suite proves the runtime outcome
while this file proves the **source cannot** do the forbidden thing. Representative families:

- **Provider boundaries.** SMS adoption, provider and status-read-only boundaries, and mobile-verification
  provider guards. An example: no code path can purchase, create, attach, or fall back to a deployment-wide
  sender ([`sms-adoption-boundary.test.ts`](../../tests/source-guards/sms-adoption-boundary.test.ts#L1-L7)).
- **Lease fencing** ([`lease-fencing-family.test.ts`](../../tests/source-guards/lease-fencing-family.test.ts#L1-L8)).
  Every write in a provider-lease family is fenced and its `lease_lost` answer honoured. It is a family guard
  because three reviews found the same defect in three places.
- **Identity families.** Client-facing email identity, studio email identity and portal rebook identity. These
  guards assert every **caller** uses the shared identity, after a change that wired only one file passed
  everything ([`client-facing-email-identity.test.ts`](../../tests/source-guards/client-facing-email-identity.test.ts#L1-L8)).
- **Workflow shape.** Move-appointment, appointment prep, assisted intake, clinical and pinned notes, and the
  waitlist invitation boundary (the recipient surface cannot mutate at all).
- **Truthful copy.** Export copy, owner-capacity copy and payment messaging, so the UI never claims more than
  the system does.
- **Privacy and assets.** Perf-timing telemetry privacy, self-hosted fonts and the middleware matcher, and
  `supabase/.temp` never being tracked. The last one checks Git's tracked path set (`git ls-files`), not just
  `.gitignore` ([`supabase-temp-untracked.test.ts` L1-L46](../../tests/source-guards/supabase-temp-untracked.test.ts#L1-L46)).

**Common blind spot:** a guard written as a text match sees only the shapes its author anticipated. The repository
answers this with negative controls — fixtures that must turn the guard red — and by preferring census and
compiler-API walks over regexes where it matters.

## 3. Docs and canonical-facts guards (`tests/docs/`)

**`canonical-production-facts.test.ts`** is the anti-drift guard for the production records
([L8-L75](../../tests/docs/canonical-production-facts.test.ts#L8-L75)).

What it reads:

- the five canonical documents: current-state, capability register, known limitations, release changelog and
  the migration ledger;
- the canonical record `migration-state.json`;
- the **derived** state from `scripts/migration-state.mjs`.

What it pins:

- **Rule 1.** No current-state sentence may assert a migration maximum or a next-free number except in the
  ledger's `## Current state` block, and that block must agree with the record and the derivation. The guard
  matches **assertive sentence shapes** — "max is …", table cells, and closed sets of present-tense position
  verbs — not bare numbers, so historical literals stay legal
  ([L185-L257](../../tests/docs/canonical-production-facts.test.ts#L185-L257)).
- **Frozen text** is exempt only inside an explicit `canonical-facts:ignore-start reason=… / ignore-end` region.
  Every marker needs a reason and must be closed
  ([`helpers/canonical-facts.ts` L13-L39](../../tests/docs/helpers/canonical-facts.ts#L13-L39)).
- **Further rules** cover whole-session-copy exercise wording; synthetic rows never being called customer
  activity; the durable-waitlist activation record; the append-only apply history in `migration-state.json`;
  and cross-document agreement.
- **Negative controls** prove each banned shape is caught and each historical shape is not.

**Rule A** — current-state.md pins a real, current runtime SHA
([L1650-L1752](../../tests/docs/canonical-production-facts.test.ts#L1650-L1752)):

| Check | Requirement |
|---|---|
| A1 | every SHA in current-state is a real commit |
| A1b | an "At `<sha>`" claim matches the pin |
| A2 | the pin is an ancestor of `HEAD` |
| A3 | **no file changed since the pin is runtime-bearing** |
| A4 | only `current-state.md` carries the runtime-bearing pin; a copy in another canonical document fails ([L1872-L1880](../../tests/docs/canonical-production-facts.test.ts#L1872-L1880)) |
| A5 | the recorded "Current Git branch HEAD" equals the production branch ref, resolved locally without network ([L2531-L2575](../../tests/docs/canonical-production-facts.test.ts#L2531-L2575)) |

A3 decides "runtime-bearing" with the repository's own classifier: not `docs_only` **and** not under a
non-shipping root (`tests/`, `e2e*/`, `.github/`, `scripts/` except scripts the production build runs, and test
and lint configs) ([L99-L170](../../tests/docs/canonical-production-facts.test.ts#L99-L170)).

**The A rules need full Git history.** CI's test job checks out shallowly, so in CI they **skip** and record that
they skipped. They are enforced only in full-history local checkouts. The test says so itself.

Other docs guards pin single facts or past corrections:

- the deleted `CRON_SETUP.md` footgun and the 15-minute reminder cadence, asserted from shipped code
  ([`reminder-cadence-truthfulness.test.ts` L11-L140](../../tests/docs/reminder-cadence-truthfulness.test.ts#L11-L140));
- retired clinical finalization;
- the import operator-assisted docs;
- the live-payments and payment-reconciliation readiness docs;
- the new-studio runbook;
- the session payment model.

The production-truth vocabulary these guards enforce is on
[Production truth and lifecycle states](../architecture/production-truth-and-lifecycle-states.md).

## 4. Dependency and lint boundaries

- **`server-only` is an explicit dependency.** It must be in `dependencies`, not `devDependencies`, and resolved
  in the lockfile. Spot-checked boundary modules must keep `import "server-only"`, so a Next upgrade that dropped
  its vendored alias cannot silently weaken the boundary
  ([`server-only-explicit.test.ts` L5-L54](../../tests/dependencies/server-only-explicit.test.ts#L5-L54)).
- **ESLint native-dialog ban.** `confirm`, `alert` and `prompt` are banned as globals **and** as `window.*`
  properties, because iOS Safari can suppress a native confirm and silently skip the mutation. Flat config
  replaces rule options rather than merging them, so the shared array is repeated into every overlapping block
  ([`eslint.config.mjs` L12-L40](../../eslint.config.mjs#L12-L40)).
- **ESLint `FIN-01A`.** The finance modules are ESM-only and cannot acquire `require`, `module` or `node:module`.

Component-level source tests (`tests/components/`), which pin the UI primitives, dialogs and the
native-dialog lint ban, are described on
[UI components and interaction standards](../architecture/ui-components-and-interaction-standards.md#6-how-the-rules-are-proved).

## 5. Contradictions and open questions

1. **`docs/09` still describes seven direct appointment writers.** It says seven direct `service_role` UPDATEs
   remain in the calendar actions and postcare auto-send, frozen by the appointment DML guard
   ([`docs/09` § RLS principles](../../docs/09_DATABASE_AND_RLS.md#rls-principles)). The guard now asserts **zero**: all seven
   were retired by B8 / `0177`
   ([`appointment-direct-dml-guard.test.ts` L533-L578](../../tests/security/appointment-direct-dml-guard.test.ts#L533-L578)).
2. **The export-copy guard's comment states a stale payload size.** It says "The export carries fifteen files"
   ([`export-copy-truth-guards.test.ts` L24](../../tests/source-guards/export-copy-truth-guards.test.ts#L24-L24)).
   The registry currently declares 20 `exported` entries, and its own header refuses to state a payload size
   because such counts go stale ([`resource-registry.ts` L50-L54](../../lib/export/resource-registry.ts#L50-L54)).
3. **Rule A3 is unenforced in CI and sensitive to non-doc, non-shipping files.**
   - It skips on CI's shallow clone.
   - Locally it treats any committed path that is neither docs-classified nor under a listed non-shipping root
     as runtime-bearing.
   - Generated machine files outside those roots therefore fail A3 in a full-history run even though they never
     ship. An example is JSON sidecars under a new top-level directory such as `openwiki/`.
   - Whether to add such roots is a guard-policy decision, not one a documentation change can make.
   - On a full-history clone of this source head, A3 and A5 already fail because the canonical record's pins lag
     production; that is an observation of this generation run, recorded on
     [Production truth and lifecycle states](../architecture/production-truth-and-lifecycle-states.md#7-contradictions-and-open-questions).
4. **The canonical-facts guard covers only the five canonical documents.** Current-state assertions elsewhere —
   other `docs/` files, code comments, or this wiki — are not checked by it.
