# Hone — Current Production State

**Canonical snapshot of what Hone is today.** This document is deliberately concise. It is
not a PR diary — per-capability evidence lives in
[capability-register.md](./capability-register.md), migration facts in
[migration-ledger.md](./migration-ledger.md), residual gaps in
[known-limitations.md](./known-limitations.md), and dated chronology in
[../14_AI_HANDOFF.md](../14_AI_HANDOFF.md).

> **No capability is described as "live" merely because a table, migration, component,
> route or flag exists.** Read the status words precisely — *designed*, *implemented*,
> *merged*, *DB applied*, *deployed*, *enabled*, *production exercised*, *human accepted*,
> *dormant*, *held*, *deferred*, *retired* are distinct, and a capability normally holds several
> at once. **Retired is terminal** — not a later phase, not a gate someone can grant.

> **This document pins the last runtime-bearing baseline, not its own documentation commit.**
> Later documentation-only commits may move the branch HEAD **above** the SHA below without
> changing anything Hone *does*.

---

## Reconciliation header

| Field | Value |
|---|---|
| **Reconciliation date** | 2026-07-27 |
| **Production branch** | `claude/build-hone-saas-hOex7` |
| **Current Git branch HEAD** | `96b28d62a5f3b9acd67d00b24c80caebd6a66e5d` at reconciliation. Query GitHub for the live value — documentation commits may have advanced it since. |
| **Last runtime-bearing application HEAD** | **`96b28d62a5f3b9acd67d00b24c80caebd6a66e5d`** — the PR #478 merge (whole-session copy). This is the baseline for every claim in this document. |
| **Last runtime-bearing Vercel Production deployment** | `dpl_nZ6UBkGhK8vTAs8butVWwqNFXqmb` — status **Ready**, target production, built from `96b28d6…` on branch `claude/build-hone-saas-hOex7`, aliased to `hone.care` and `www.hone.care`. |
| **Production migration max** | **0157** — 157 migrations applied, each exactly once, **no `0158`+ applied**. Hosted `0157`; **repo max is now `0160`** — two migrations in-tree and **neither applied**: `0159` (clinical-finalization retirement) and `0160` (immutable clinical lineage, which depends on 0159 and must be applied after it). `0158` is intentionally skipped — see §3 and the decision record. |
| **Production Supabase project** | The single production project. Always re-read the linked ref from `supabase/.temp/project-ref` (gitignored) and verify with `supabase migration list --linked` before trusting any number here. **No credentials are recorded in documentation.** (The project ref itself appears in at least one older repo document, so treat it as an operational identifier rather than a secret — but do not add new copies of it.) |
| **Health** | `hone.care` **200** · `/login` **200** · `/dashboard` **307** (auth redirect) · `/api/health` **307**. All non-5xx. `ops_alerts` unresolved: **0**. |
| **Customer / studio posture** | **One live studio with real clients: Willow Electrolysis** (2 practitioners, 24 clients, 75 appointments). Plus one controlled test studio used for validation, and three empty studios. Five studios total. |
| **Next operational gate** | The **deep production / security / code audit** (not yet performed against this baseline). **Chloe's human acceptance testing** of the Phase A charting correction and whole-session copy is also outstanding, but it is **independent and does not block the audit** — see §16. |

### Immediately preceding runtime baseline

`3cabdcaa9e196afc45db63e98eb8ca72ef0a5051` — the PR #479 merge (Phase A charting
correction), merged 2026-07-26T23:27:30Z and deployed. Its deployment has since been
**superseded** by PR #478's, but its code remains live because #478 was built on top of it.

---

## 1. Charting and treatment memory

**Deployed · enabled for all studios · human acceptance pending.**

Session blocks, observation chips, treatment areas, probe-lot suggestion, and the
*Before Today* / *Treatment Intelligence* surfaces are in continuous operator use
(49 `session_blocks`, 33 `electrolysis_entries` in production).

The **Phase A charting correction** (PR #479, merge `3cabdca`, **code-only — no migration**)
is deployed and reachable:

- **One unified `Treatment observations & skin response` box.** What were previously two
  separate concepts — *Treatment observations* and *Client / skin response* — are now a
  single multi-select. The canonical constants live in `lib/sessions/charting-labels.ts`.
- **Reaction-driven analytics consume the unified representation.** The dashboard
  *Clients needing attention* card and the treatment-intelligence surfaces read the unified
  chip set, not a separate response field.
- **Legacy `reaction_type` compatibility is preserved.** `session_blocks.reaction_type` is
  folded into the unified set on load and display, so historical rows still surface on
  every reaction-aware surface. Nothing was migrated or rewritten.
- **Galvanic intensity is retired** from current writes and ordinary display.
  `galvanic_intensity_percent` is no longer supplied by any form, is never emitted by the
  write path, and is ignored if a forged spec supplies it. **Historical values are
  preserved** — the column was not dropped and existing rows were not modified.
  *`galvanic_ma` and `galvanic_duration_seconds` remain active galvanic readings.*
- **Exact thermolysis precision.** A stored `0.733` displays as **`0.733 seconds`** — never
  a lossily rounded `0.73`. Trailing zeros are trimmed (`lib/sessions/format-seconds.ts`).
- **Pulse is labeled `Thermolysis pulse count`** and sits inside the thermolysis section,
  in both the block setup form and the simplified entry form.
- **Larger `Additional notes`** field.

**Chloe has not yet performed on-device acceptance of any of the above.**

Also deployed on this baseline: conditional numbing notes (0156, kept only when
`numbing_status='used'`), inventory-backed probe-lot linkage (0155), and the in-form
"Copy settings" prefill (PR #473).

## 2. Whole-session copy

**DB applied · merged · deployed · enabled · NOT production exercised · human acceptance pending.**

Migration **0157** was applied to production **2026-07-27T02:01:29Z**, *before* PR #478
merged at 13:12:34Z — migration-first. The application (PR #478, merge `96b28d6`) is
deployed and there is no feature flag.

Behaviour:

- **Editable ephemeral preview.** "Copy areas & settings from last session" renders a
  preview the practitioner can edit and remove cards from. The preview is component memory
  only.
- **Zero writes before the explicit commit.** Opening, editing or abandoning the preview
  creates nothing.
- **One atomic commit.** A single CTA reaches the server, which validates canonically and
  calls `copy_session_setup` — one transaction creating the reviewed destination records.
- **Source locking and stale-source rejection.** The commit carries an expected source
  session id and fingerprint; a source that changed underneath is refused.
- **Idempotency and a provenance ledger.** `session_copy_operations` records each operation
  under a `(target_session_id, idempotency_key)` UNIQUE, so a retry or double-submit is an
  at-most-once no-op.
- **Reusable setup only.** **Minutes and outcomes are never copied.**
- **Galvanic intensity is forced to a literal `NULL`** at the destination, and is excluded
  from the source fingerprint — so a forged spec cannot reintroduce it.

**Production exercise: none.** `session_copy_operations` holds **0 rows**. Deployment
verification was source-inspection plus browser testing and **deliberately performed zero
copy operations**. Do not describe whole-session copy as production-exercised merely because
the deployment succeeded.

## 3. Clinical finalization, corrections and amendments — RETIRED

**RETIRED by product decision (2026-07-29) and enforced by migration 0159.** Signed and
cryptographically finalized clinical records are **not a Hone product capability**. Treatment
sessions are ordinary, editable operational records, and practitioners correct charting mistakes
by editing them through the normal charting commands. Full reasoning, the retained legacy
artifact and the reintroduction bar:
**[../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md)**.

| | State |
|---|---|
| Phase 1 — finalization boundary (0119) | **RETIRED.** `clinical_finalization_enabled` is **false on all 5 studios** and is now pinned false by CHECK constraint `studios_clinical_finalization_retired` — no role can turn it on. `EXECUTE` on `finalize_session` is revoked from every runtime role, and `sessions_guard_retired_finalization` refuses any transition into `finalized`/`void`. Historically production-exercised **exactly once**, on the controlled non-Willow test studio (1 finalized session + 1 snapshot, hash still re-deriving, retained unchanged). **Willow: 0 non-draft sessions, ever.** |
| Phase 2 — corrections & amendments backend (0120) | **RETIRED.** `clinical_corrections_enabled` is **false on all studios** and pinned false by `studios_clinical_corrections_retired`. **Never production-exercised** — 0 amendments, 0 clinical audit events, and `INSERT` is now refused on all three signed-record ledgers, so none can ever be produced. The generic 3-field correction UX was never approved, and no full-chart correction workspace will be built. |
| Reliability/observability (PR #402) | **RETIRED with Phase 2.** The amendment path it instrumented is unreachable. |
| Practitioner-facing Finalize / signed-record Correction controls | **REMOVED from the application.** There is no Finalize or signed-Correction surface. |
| Append-only clinical notes (0126/0127) | **Live for all studios, no flag** — 1 production row. **Unrelated to the above and NOT retired** — a correction here is a new row (`supersedes_note_id`), never a signed snapshot. |

**Migration 0159 drops nothing.** The 0119/0120 objects stay in place so those migrations remain
replayable, and the guards that protect the one legacy artifact are deliberately kept on. The
deployed backend — immutable snapshots, version lineage, `clinical_audit_events`, append-only RLS
and the narrow session-scoped correction permit — **is preserved and must not be weakened**, but
**not** so finalization can be enabled later: it is preserved because it keeps the legacy
evidence immutable, keeps the retirement fail-closed, and forbids `authenticated` `TRUNCATE` and
any write to the three signed-record ledgers. It does NOT stop ordinary direct DML:
`authenticated` still holds row INSERT/UPDATE/DELETE on `sessions`, `session_blocks`,
`electrolysis_entries`, `laser_entries` and `treatment_images`, restricted only by RLS to
same-studio rows — see known-limitations L18. Ordinary operational audit trails
(`session_audit`, `record_keeping_audit_events`, `session_copy_operations`,
`admin_action_events`, `client_portal_access_events`), actor attribution, timestamps,
treatment-history integrity, whole-session-copy provenance and tenant isolation are all
**retained**. `clinical_audit_events` is **not** one of those — despite its name it records only
signed-record corrections/amendments and is retired with the rest.

Reintroducing finalization is **not a backlog item**. It would require a new explicit product
decision, an architecture review, a legal/privacy review, a migration plan and fresh acceptance.

## 4. Probe inventory and record keeping

**Deployed · enabled · in use.** Sterile items, disinfectants and exposure incidents with
audit (8 `record_keeping_sterile_items` rows). Exposure-incident history is **owner-only**.
Overdue-disinfectant "Replace now" alerts are computed at read time and auto-resolve.

Migration 0155 adds a durable, probe-specific, same-studio link from a charted block to a
sterile-inventory item (pointer-only, `ON DELETE SET NULL`, frozen snapshot). No production
block carries a link yet. The legacy `probe_lots` table stays **dormant**.

## 5. Booking and calendar

**Deployed · enabled · in continuous use** — 101 appointments in production.

Public booking (service selection, availability scan, intake gating, hashed-token
manage/cancel/reschedule), the practitioner calendar (mobile single-day timeline; desktop
week/month with preview drawer), atomic same-record **Move appointment** (0133), and
backward-packed slot anchoring with source-aware conflicts.

**Migration 0152** makes actual treatment overlap a **HARD** database constraint while the
configured buffer becomes a **SOFT** constraint an authenticated internal owner may
override. An owner override bypasses the buffer only — never a real overlap.

**The direct new-client consultation booking route is `Deferred by product decision`
(2026-07-27).** It is not built, not a launch blocker, and not the next engineering task.

## 6. Client portal and intake

**Deployed · enabled · in use.** Magic-link portal login with an append-only access-event
log (21 portal sessions), portal messages and replies (11 messages), intake forms with
reminders and terminal-state immutability (29 forms), and versioned consent with
e-signatures (19 signatures).

⚠️ Consent template wording is **draft**. Lawyer review is required before relying on
enforceability. Hone's documentation does not claim signatures are legally binding.

## 7. Payments and Stripe

**Live-capable and genuinely production-exercised for two approved studios — but not broadly ready.**

- **Willow Electrolysis is live and charging.** 6 succeeded **live-mode** charges, most
  recent **2026-07-26**. Her live Connect account has `charges_enabled` and
  `payouts_enabled` true. This is the strongest production-exercise evidence in the system.
- The controlled test studio also holds a live account with 2 succeeded live charges.
- **Card-on-file** (SetupIntent) with live/test isolation is in use — 8 stored payment
  methods. `require_card_on_file` is **false** on every studio.
- **Receipts** are live. **Refunds** are deployed but have **zero production rows on this
  baseline**. **Disputes** are **alert-only** — 0 have occurred.
- **Live manual no-show / late-cancellation fees are HELD** by a server-side allow-list;
  only `session_payment` charges live. The 2 fee charges that exist are test-mode.
- **Public-booking card collection is OFF and unwired.**
- **Deposits, packages and partial payments are not built.**
- **Broad self-serve live payments are not ready** — a new studio starts in test mode and is
  enabled only after supervised onboarding and approval.
- **No automatic, background, batch or public-triggered charge path exists.** Charging is one
  manual practitioner click.

## 8. Communications

Transactional email via Resend (confirmation, reminder, postcare, portal) is live and
fail-soft. **Postcare auto-send is deployed but defaults to `manual`** — opt-in per studio,
skipped if the Resend key or postcare text is missing.

**SMS is pilot scale only**, env-gated on `TWILIO_*` with a per-studio toggle and per-client
consent, STOP/HELP handled. Broad-SaaS SMS (A2P/10DLC registration, sender strategy, rate
limiting) is **not built**.

Marketing conversion tracking is deployed but **inert per studio** — no studio has configured
a provider token, and configuring one is an enablement step, not a default.

## 9. Google Calendar

**DB applied · deployed · production-exercised exactly once · currently DORMANT.**

- **Willow Electrolysis is not connected to Google Calendar** and has never had an event
  synced.
- One connection exists, on the **controlled test studio only** (connected 2026-07-12,
  `destination_mode='dedicated_app_created'`). Granted scopes are least-privilege:
  `calendar.app.created` — **no** `events.owned`, **no** broad `calendar.events`.
- **Exactly one real outbound Google event has ever been created**, on 2026-07-18, on that
  test studio: one `calendar_sync_outbox` row (`op_type='event.create'`, `status='done'`,
  1 attempt) and one `calendar_event_links` row (`sync_status='synced'`,
  `last_sync_direction='hone_to_google'`).
  *This corrects earlier documentation that described both tables as empty.*
- **Every outbound / inbound-busy / two-way sync flag is `false` on every studio.** No worker
  is draining the queue, and no studio is intent-eligible.
- **The calendar cron routes ARE registered and DO run daily** — `vercel.json` schedules
  `/api/cron/calendar-reconcile` at `0 9 * * *` and `/api/cron/calendar-sync` at `30 9 * * *`.
  They authenticate, find zero eligible studios and zero claimable jobs, and exit having done
  nothing. **Dormancy comes from the flags being off, not from the absence of a schedule.**
- Inbound busy import and two-way edits are **designed, not built**.

Deployed ≠ enabled. Each of the following needs **separate authorization**: connecting
Willow, enabling any outbound flag, activating the worker, and starting inbound/two-way work.

## 10. Multi-practitioner and practitioner capacity

**Deployed · enabled only on the controlled test studio · public assignment held off everywhere.**

- Tenant isolation is enforced by RLS (`is_studio_member`) plus composite same-studio
  foreign keys; migration **0151** closed the appointments cross-studio-reference gap.
- Multi-studio users are supported (studio switcher + re-validated httpOnly cookie).
- The practitioner roster is real: 6 practitioners across 5 studios, 2 at Willow.
- **`practitioner_capacity_enabled` is true only on the controlled test studio, and FALSE on
  Willow Electrolysis.**
- **`practitioner_capacity_booking_enabled` — the public-booking kill switch — is FALSE on
  every studio.** Public practitioner selection and assignment is not active anywhere.
- Per-practitioner availability, scoped blocks and breaks, and the atomic internal
  booking / move / reassign commands (0135–0150) are deployed and follow the capacity flag.

**Schema and code existing is not launch readiness.** Broad multi-practitioner rollout
requires the deep audit and explicit authorization.

## 11. Studio onboarding and self-service

Practitioner signup is **invite-only** — magic-link login creates an account only for an
email with a pending team invitation. Invitation reconciliation (0141) ensures nothing
fabricates consent and no membership activates merely because an Auth user was created
(11 pending invitations).

**Onboarding v2** (0140) is deployed with `onboarding_v2_enabled` true on the **controlled
test studio only**. Nudges and analytics remain deferred.

**Self-serve studio creation is not built.** New studios are provisioned through the
operator runbook.

## 12. Files, treatment photos and exports

Private `treatment-images` bucket, service-role-only access with short-TTL signed URLs,
per-file EXIF stripping, tenant-scoped paths, multi-file upload (3 images in production).
Per-client procedure record pull with filtered print is live.

Finalized-record photo **content** immutability was never implemented, and is now **moot**:
signed/finalized clinical records are retired (§3), so no record is ever finalized and there is
no finalized-photo integrity claim to make. This is **not** a scheduled phase. The live
protections — private bucket, service-role-only access, path/identity CHECKs and the integrity
trigger that freezes identity columns after insert — are unaffected and remain in force.

## 13. Operations, alerts and observability

- `ops_alerts` — redacted, never-throws. **0 unresolved alerts** at reconciliation. *(That
  is 0 unresolved rows, not a claim of zero incidents ever.)*
- Admin action audit log (0113) at `/admin/audit` — append-only, service-role-only, no
  token/URL/IP/PII columns (5 events).
- `scripts/verify-production.mjs` — read-only health check that **derives** the expected
  migration max from `supabase/migrations/` rather than hardcoding it.
- `scripts/check-stripe-gates.mjs` — a gate suite. **Passing gates is not proof of security.**
- Sentry and PostHog are merged and deployed with hardened settings. **Whether either
  console is receiving events, and whether `NEXT_PUBLIC_POSTHOG_*` is set in Vercel, is
  unknown pending verification** — it cannot be confirmed from code or the CLI.
- Rate limiting via Upstash **fails OPEN** — if it is down or unset, portal and booking rate
  limits bypass.

## 14. Known limitations and held capabilities

Full register with impact, mitigation, owner and next gate:
**[known-limitations.md](./known-limitations.md)**.

**Held behind a deliberate server-side gate** (do not enable without a dedicated PR + approval):
live manual no-show / late-cancellation fees · public-booking card collection · public
practitioner selection and assignment.

**Dormant** (deployed but structurally unable to act): all Google Calendar sync phases ·
practitioner capacity at Willow · onboarding v2 at Willow.

**Retired by product decision (2026-07-29), enforced by migration 0159:** signed / finalized
clinical records · signed-record corrections and amendments · practitioner-facing Finalize and
signed-Correction controls · any "snapshot v2". These are **not dormant and not held** — they
cannot be enabled by any role. See
[../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md).

**Not built:** deposits / packages / partial payments · broad self-serve live payments ·
inbound-busy and two-way calendar · broad-SaaS SMS · self-serve studio creation.

**Deferred by product decision (2026-07-27):** the direct new-client consultation booking route.

## 15. Human acceptance still pending

**Chloe has not yet accepted, on-device, any of the following:**

1. The unified **Treatment observations & skin response** box.
2. Galvanic intensity being absent from new charting.
3. `0.733` displaying as **`0.733 seconds`**.
4. The **Thermolysis pulse count** label and its placement inside the thermolysis section.
5. The larger **Additional notes** field.
6. **One real whole-session copy** — no production copy has ever been performed.
7. Conditional numbing notes (0156) and inventory-backed probe-lot linkage (0155).

Engineering deployment for all of the above is **complete**. Human acceptance is **not**.
Do not describe any of it as accepted, validated by Chloe, or signed off.

## 16. Next work

1. **Chloe's human acceptance testing** — may happen separately and later; it does not block
   the audit.
2. **The deep production / security / code audit.** Not yet performed against this baseline.
   This is the next substantive engineering and governance work.
3. **Broader second-studio and multi-practitioner rollout** — only after the audit and
   explicit authorization.

The direct new-client consultation booking route is **not** on this list. It is deferred by
product decision.

---

## How to re-verify this document

Never trust a number here without re-checking it. Nothing in this document is evidence for
any other document.

```bash
# 1. Production branch head
gh api repos/SaiSamyukthVemuri/Hone/branches/claude/build-hone-saas-hOex7 --jq .commit.sha

# 2. Hosted vs repo migrations (guard the project ref FIRST)
cat supabase/.temp/project-ref          # must be the production project
supabase migration list --linked        # Local and Remote must reconcile

# 3. Read-only production state
supabase db query --linked "<verification sql>"   # never `db execute`

# 4. Health
curl -s -o /dev/null -w '%{http_code}\n' https://hone.care

# 5. Read-only health script
node scripts/verify-production.mjs
```

Source-of-truth order: production Git graph → Vercel deployment record →
`supabase migration list --linked` → read-only production queries → code and migrations at
the exact production SHA → merged PR metadata and CI → deployment/runbook reports →
existing documentation (as claims to verify, never as evidence).

See also: [capability-register.md](./capability-register.md) ·
[known-limitations.md](./known-limitations.md) · [migration-ledger.md](./migration-ledger.md) ·
[release-changelog.md](./release-changelog.md) ·
[../runbooks/migration-first-process.md](../runbooks/migration-first-process.md)
