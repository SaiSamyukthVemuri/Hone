# 22 Agentic readiness and safety

**Status: design and safety plan only. No AI runtime is added by this document. No model is called anywhere in the product. This file defines the rules an agentic capability MUST satisfy before any of it is built.**

This is the plan a future contributor (human or AI) reads first before writing a single line of agentic code for Hone. If a proposed feature violates anything here, the feature is wrong, not the plan.

Read alongside:
- `docs/03_SECURITY_AND_PRIVACY.md` (RLS model, token surfaces, sensitive data)
- `docs/09_DATABASE_AND_RLS.md` (studio-scoped access, exposure-incident owner tier)
- `docs/16_LIVE_PAYMENTS_READINESS.md` and `docs/18_LIVE_PAYMENTS_AUDIT.md` (controlled live-payment posture and payment safety boundaries)
- `docs/14_AI_HANDOFF.md` (non-negotiables a future AI must keep)

## Why Hone should become agentic, and why carefully

Hone is an operating memory system for electrologists. Its value is the recorded treatment history it already holds: what was treated, with what settings, how the client responded, what to remember for next time, and what is missing from the record. The Before Today briefing (`lib/sessions/before-today.ts`), Treatment Intelligence (`lib/sessions/treatment-intelligence.ts`), the clients-needing-attention list (`lib/dashboard/clients-needing-attention.ts`), and the record-keeping completeness reminders (`lib/record-keeping/queries.ts`) already turn that history into something a practitioner reads before working.

The agentic direction is to let Hone do more of that preparation work for the practitioner: assemble the daily brief, surface what is missing, draft the follow-up message, and explain why it surfaced each item, all from recorded fields. The goal is NOT a generic chatbot, and NOT a system that decides anything clinical, sends anything, or moves any money.

The risk is equally clear. This is health-adjacent personal data under per-studio RLS, with an owner-tiered exposure-incident surface, a payments backend that is **live for two approved studios and production-exercised** (Willow Electrolysis: 6 succeeded live-mode charges through 2026-07-26) — no longer dormant, so agentic restraint around it matters more, and a single supervised pilot (Chloe at Willow; Laura planned). An agent that oversteps could leak sensitive data across studios, expose owner-only incident details, invent a clinical fact, silently change a record, send a client an unreviewed message, or touch money. None of that is acceptable. This plan exists so the agentic build is additive and supervised from the first commit.

## Product principle

Hone's agentic direction is bounded by these principles. Every future agentic PR must restate which of these it honors.

- **Assistant, not decider.** The agent prepares the practitioner; the practitioner decides.
- **Draft, not send.** The agent drafts; a human reviews and sends.
- **Flag, not diagnose.** The agent surfaces recorded items that may want review; it never diagnoses.
- **Summarize recorded history, do not invent.** Every statement traces to a recorded field or an already-visible derived view. Missing values stay "not recorded"; nothing is fabricated.
- **Prepare the practitioner, do not prescribe treatment.** The agent never tells a practitioner what settings to use or what to do clinically.
- **Require human confirmation before any external action.** Nothing leaves the studio, changes a record, or touches money without an explicit human confirmation step.
- **Never silently mutate clinical history.** The agent is not a hidden write path. Treatment memory is the product moat and is preserved (`docs/09`, PR #217 delete posture).
- **Never auto-charge.** No agent path creates, captures, or refunds a payment. *(The prohibition stands and is unconditional. The trailing "live payments remain disabled" in earlier revisions is false — live payments ARE enabled for approved studios, which makes this rule MORE important, not less.)*
- **Never auto-message clients.** No agent path sends an email or SMS to a client without practitioner approval.

## What AI can read (safe read surfaces, V1)

The agent reads only what the practitioner can already see for their own studio, through the same studio-scoped access model. The safe read surfaces are:

- today's appointments (the Dashboard Today roster)
- client profile basics (name, contact fields the practitioner already sees, intake status)
- Before Today memory (the pre-treatment briefing already assembled per client)
- Treatment Intelligence (recorded-history summary: areas, minutes, latest setup, reactions)
- session blocks (treatment areas charted on a session)
- treatment area history (per-area recorded history)
- probe and probe lot records (as recorded)
- tolerance, reaction, and caution notes (as recorded)
- next-session notes (the "for next visit" watch/plan note)
- missing record reminders (the same completeness reminders already shown)
- intake completion status (complete / awaiting review / missing)
- Record Keeping gaps that are already visible to the practitioner

These are read-only views the product already computes. The agent gets no new or wider data access than the logged-in practitioner already has.

## What AI must not read or expose in V1 (excluded sensitive surfaces)

The agent must not read, summarize, embed, log, or expose any of the following. This list mirrors the Global Search V1 exclusions (PR #232) and the exposure-incident owner tier (PR #222, migration 0088).

- exposure incident details (`record_keeping_exposure_incidents`: exposed person's name, address, phone, exposure details, action taken, staff involved)
- exposure incident audit payloads (`record_keeping_audit_events` rows for exposure incidents, whose `changes` carry old/new field values; owner-only)
- payment internals (payment charge attempts, manual fee charge attempts, amounts/state machine internals)
- Stripe ids (`stripe_payment_intent_id`, `stripe_events`, any Stripe object id)
- raw appointment tokens (cancellation / reschedule tokens)
- raw calendar feed tokens (the feed token and its at-rest hash)
- auth and session data (cookies, magic-link tokens, GoTrue session rows)
- full audit JSON, unless a specific future feature explicitly requires it AND scopes it to non-sensitive record types with owner-tiering preserved
- cross-studio data of any kind
- anything outside the current studio's RLS scope

Exposure incidents remain owner-tiered for reads and edits exactly as today. An agent acting for a non-owner member must behave as if exposure incident history does not exist.

## What AI can do (allowed future behavior, V1)

Within the read surfaces above and with no external action, the agent may:

- prepare a daily brief for the practitioner
- summarize recorded treatment history for a client
- highlight a missing probe lot, missing aftercare mark, or missing intake
- flag clients needing attention from recorded signals
- suggest records the practitioner may want to review
- draft a client message for the practitioner to review (draft only, never sent)
- explain why it surfaced an item, citing the recorded fields it used

All outputs are presentational or draft. None of them change data or leave the studio on their own.

## What AI cannot do (hard prohibitions)

These are absolute. A feature that does any of them is rejected.

- recommend treatment settings as medical advice
- claim that anything is safe or unsafe
- diagnose a condition
- infer or assert causation
- modify clinical records silently (no hidden write path)
- delete records
- send a message (email or SMS) without explicit confirmation
- charge a card
- create or refund a payment
- create or change an appointment without explicit confirmation
- expose sensitive incident details to non-owners
- read or act across studio boundaries
- call a payment, booking, intake, charting, Calendar, or Record Keeping write path on its own

## Human confirmation rules

Any action with an effect outside generating text on screen requires an explicit human confirmation step, with the practitioner seeing exactly what will happen before it happens. Confirmation is required for, at minimum:

- sending any client message (email or SMS)
- creating an appointment
- changing an appointment (time, status, assignment)
- editing any record (clinical, client, or record-keeping)
- marking aftercare / risks explained
- changing client information
- exporting or sending records
- any payment-related action (agentic capabilities must never initiate or mutate a charge/refund in ANY mode — this rule is independent of live-payment status, which is now enabled for approved studios)

Confirmation is per action and specific. A blanket "approve everything" mode is not allowed in V1. Declining a confirmation is always a no-op with no side effects.

## Safe wording rules

Agent-authored text uses the same recorded-history vocabulary the product already uses (Before Today, Treatment Intelligence, the next-action resolver in `lib/dashboard/next-action.ts`).

Use:
- recorded
- last recorded
- not recorded
- for next visit
- caution noted
- reaction recorded
- tolerance recorded
- may want to review
- missing from record

Avoid (these words must not appear in agent-authored output as assertions about a client):
- recommended
- safe
- unsafe
- caused
- diagnosis
- medically necessary
- should treat
- clinical advice

The boundary is the same one the codebase already enforces in its safe-wording test pins (`recommend|score|monitor|unsafe|caused|diagnos`): the agent reports what is recorded and what is missing, and it never gives clinical direction or makes outcome or causation claims.

## First agentic workflows

When the agentic build starts, these are the first three workflows, in order. Each is read-and-draft only and obeys every rule above. None is implemented by this document.

### 1. Daily Prep Brief V1

A read-only brief the practitioner opens before the day. Assembled from existing surfaces:

- today's appointments
- prior treatment memory per client (Before Today)
- watch / caution notes
- next-session notes
- missing intake
- missing probe lot
- aftercare not marked
- clients needing attention

Output is a presentational brief. It sends nothing and changes nothing. It is the most likely first agentic PR after this plan.

**Status: implemented in PR #241, rules-based only.** No AI, no model call, no provider integration, no chatbot, no autonomous action. The pure helper `lib/dashboard/daily-prep-brief.ts` turns facts the Dashboard already loads (today's appointments, the Before Today preview pipeline, the linked-session charting state, and intake status) into a deterministic, priority-ordered prep list rendered as a compact card under Today. It reads no sensitive surface and links only to existing client routes; nothing is sent, charged, or mutated. Missing Records / Follow-up Assistant V1 below has since shipped (PR #249); only the Draft-only Client Message Assistant remains a future PR.

### 2. Missing Records / Follow-up Assistant

A read-only assistant that surfaces record-keeping and follow-up gaps already computable today:

- completed appointment not charted
- missing probe lot
- aftercare not marked
- intake incomplete
- a next-session note exists but there is no future appointment booked

It suggests what the practitioner may want to review. It marks nothing and books nothing; acting on any item still goes through the normal UI with its existing confirmation.

**Status: implemented in PR #249, rules-based only.** No AI, no model call, no provider integration, no chatbot, no autonomous action, no writes/sends/charges. The pure helper `buildMissingRecordsAssistant` + bounded loader `getMissingRecordsAssistant` (`lib/dashboard/missing-records-assistant.ts`) turn already-recorded facts into a deterministic, priority-ordered, capped list of recorded gaps (completed-but-uncharted, aftercare/risks not marked, probe lot missing, intake `in_progress`, for-next-visit note with no upcoming appointment), rendered as a compact "Follow-up assistant" card under Practice Snapshot. The gap rules mirror the existing surfaces (`lib/sessions/before-today.ts`, `lib/dashboard/next-action.ts`) so they never disagree. The caution/watch-note item type was deliberately deferred because "Clients needing attention" (PR #214) already covers it. It reads only studio-scoped, RLS-backed tables (no exposure incidents, no payment internals, no Stripe ids, no raw tokens, no audit JSON) and links only to existing client/session routes; nothing is sent, charged, or mutated. Only the Draft-only Client Message Assistant below remains a future PR.

### 3. Draft-only Client Message Assistant

Drafts a client message for practitioner review. Templates:

- intake reminder
- appointment prep note
- aftercare follow-up
- rebooking reminder

The draft is always shown to the practitioner first. It is never sent without practitioner approval. Sending continues to go through the existing send path with its existing consent and opt-out checks (`docs/08`).

## Audit and traceability

The agent must be inspectable, never a hidden layer.

- AI outputs cite the recorded fields or source sections they were derived from, where feasible, so a practitioner can trace any surfaced item back to recorded data.
- AI-generated drafts are visibly distinguishable from sent messages. A draft is clearly a draft until a human sends it.
- Any accepted AI-assisted action is auditable later through the same audit trail the manual action would have produced. An agent-assisted edit is recorded the same way a manual edit is.
- The agent does not become a hidden mutation layer. It never writes clinical, client, record-keeping, booking, calendar, or payment data on its own. Every mutation continues to flow through the existing, audited, confirmed write paths.

## Security and RLS posture

The agentic capability inherits, and may not weaken, Hone's existing security model.

- The agent uses the same studio-scoped access model as the logged-in practitioner. It runs as the practitioner, within their studio's RLS scope.
- No service-role broad AI search. The agent never uses the service role to read across the database. Studio scoping is enforced by RLS, not by the agent's good behavior.
- No cross-studio memory. The agent never reads, caches, embeds, or carries data from one studio into another.
- No public AI endpoints. There is no anonymous or public agentic surface. All agentic features sit behind the authenticated app, like the rest of `app/(app)`.
- No AI access to the excluded sensitive surfaces listed above.
- Exposure incidents remain owner-tiered. A non-owner member's agent behaves as if exposure incident history is not present.
- Payments stay off. No agentic path can enable live payments, set `STRIPE_ALLOW_LIVE_MODE`, remove a `stripe_livemode=false` check, or call a Stripe write. The Stripe grep gates (`scripts/check-stripe-gates.mjs`) continue to apply to any future agentic code.

## What this document does and does not change

This document changes no runtime behavior. It adds no AI runtime, no model call, no endpoint, no migration, no schema, no RLS change, and no payment capability. It is a plan and a set of constraints. The first capability it could justify is the Daily Prep Brief V1, which would be its own PR, built read-and-draft only, under every rule above.

**Superseded (2026-07-27): controlled live payment enablement COMPLETED.** Live owner-run session payments are **enabled for approved studios** only (two today) and have been **production-exercised** — Willow Electrolysis has 6 succeeded live-mode charges, most recent 2026-07-26. **Broad self-serve live payments remain not ready**: a new studio starts in test mode and is enabled per-studio only after supervised onboarding and approval. Live manual no-show / late-cancel fees remain on a server-side hard hold. **None of this relaxes the agentic rule: no agent path creates, captures, or refunds a payment, in any mode, and explicit human control remains mandatory.**
