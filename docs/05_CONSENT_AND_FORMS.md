# 05 Consent and forms

## Overview

Migration 0057 (PR #134) installed the consent + e-sign foundation. Migration 0060 (PR #137) added the photo-consent accept/deny response. The system stores an immutable, append-only record of every client signature with a full snapshot of what the client saw.

This document describes the mechanism. It does **not** make legal claims. Enforceability under Ontario law depends on lawyer-reviewed wording. See §5 below.

## Tables

### `consent_form_templates`
- Studio-authored.
- Columns: `id`, `studio_id`, `title`, `description`, `body`, `form_type`, `version`, `status`, `is_live`, `created_by_practitioner_id`, timestamps.
- `form_type` ∈ `general / treatment_consent / policy_acknowledgement / card_authorization / photo_consent`.
- `status` ∈ `active / draft / archived`. Templates are never hard-deleted because `client_consent_signatures` references via ON DELETE RESTRICT.
- `is_live` (PR #167, migration 0072) ∈ `true / false`, default `false`. The explicit client-portal visibility gate, decoupled from `status`. The portal query requires `is_live = true AND status = 'active'`; the practitioner's Settings UI sees every row regardless of `is_live`. A DB CHECK constraint (`consent_form_templates_live_requires_active_check`) guarantees `is_live = true` implies `status = 'active'`, so a draft or archived row can never be live. Existing rows were backfilled to `is_live = (status = 'active')` to preserve pre-PR behavior; new rows land as `(status='draft', is_live=false)` because `createConsentTemplateAction` now forces both values on insert.

### `client_consent_signatures`
- Immutable append-only.
- Columns: `id`, `studio_id`, `client_id`, `template_id`, `template_title_snapshot`, `template_body_snapshot`, `template_version`, `template_hash` (SHA-256 hex of canonical `(title, body, version)`), `signature_name` (typed by the client), `signed_at`, `ip_hash`, `user_agent_hash`, `created_at`.
- Multiple signatures for the same `(client, template)` pair are preserved; re-signing after an edit is a new row, not an overwrite.
- PR #137 added: `response` ∈ `accepted / denied` (default `accepted`), `response_label_snapshot`. Photo consent's "deny" is a signed record, not an absence.

## Form types in use

| `form_type` | Used in | Notes |
|---|---|---|
| `general` | Catch-all studio form. | |
| `treatment_consent` | Required consent for first treatment. | Draft wording exists; **lawyer review required before any live use.** |
| `policy_acknowledgement` | Standalone studio policies surface. | Separate from `appointment_policy_acknowledgements` (which is appointment-scoped). |
| `card_authorization` | Required before saving a card. | The `client_payment_methods.card_authorization_signature_id` FK enforces the link. |
| `photo_consent` | Asks whether the studio may take and store photos. | PR #137 added the deny response; storing a deny is still a signed record. |

## How signing works

Surface: `/portal` → "Needs you" zone → form card → "Read and sign" flow.

```
client opens the unsigned form in /portal
  -> server renders title + body + version from the template row, and derives
       renderedTemplateHash = sha256(canonical((title, body, version)))
       via withRenderedTemplateHash (lib/consent/template-snapshot.ts)
  -> client types their full name + agrees
  -> POST -> signConsentFormAction (app/portal/consent-actions.ts)
       THIN WRAPPER. Owns only what is portal-specific:
         resolves the portal session (studio_id, client_id)
         constructs the service-role client
         card_authorization pointer refresh (fail-soft, PR #177)
         revalidatePath("/portal")
       -> recordConsentSignature (lib/consent/sign-consent-form.ts)
            THE ONE CEREMONY. Reused by any future signing surface.
            reads the template by id; refuses unless
              studio_id matches AND is_live=true AND status='active'
              (PR #167; before PR #167 the gate was only status='active')
            optional allowedFormTypes narrowing for restricted callers
            re-checks the client row is non-archived
            snapshots (title, body, version) onto the new signature row
            computes template_hash = sha256(canonical((title, body, version)))
            REFUSES if template_hash != the hash the client rendered, or if
              form_type changed since render  <-- stale-form gate
            writes ip_hash / ua_hash via hashFingerprint (returns null in prod
              if PORTAL_FINGERPRINT_SALT is missing; that is intentional;
              the columns are nullable, the signature row still writes)
            INSERT into client_consent_signatures
            returns generic ok
```

### The stale-form gate

A studio can edit a live template between the moment a client renders it and
the moment they submit: `updateConsentTemplateAction` rewrites title/body and
bumps `version` while touching **neither `status` nor `is_live`**, so the row
stays signable. Before this gate existed the ceremony snapshotted the
**current** row, attaching the client's typed name to text they never read —
and for a `photo_consent` form it could record an acceptance for a client who
chose to deny.

The browser therefore returns two **comparands**: the hash of what it rendered
and the `form_type` it rendered. The server re-resolves the template, rebuilds
the snapshot from its own row, and compares. Any difference (or a missing
comparand) writes **nothing** and returns:

> This form changed while you were reviewing it. Please refresh and review the
> current version before signing.

The comparands are never stored, never echoed onto the row, and never trusted
as data — every stored field is still re-derived server-side. `form_type` is
carried separately rather than folded into the hash because `template_hash` is
a persisted column whose canonical format is a stored contract; widening it
would invalidate hash-vs-history verification for every existing row.

The guarantee is anchored to the single template read: an edit landing between
that read and the INSERT cannot corrupt the stored snapshot, but a signature
may be recorded against a template that has just been superseded. That is the
accepted residual.

## Live / Draft client visibility (PR #167)

Practitioners hit this control from `Settings -> Consent forms`. Each template carries a `Live` or `Draft` badge in the list and one of two action buttons:

- `Make live in client portal` -- appears when `status='active'` AND `is_live=false`. Flips `is_live=true`. The DB CHECK constraint rejects the flip if the row is not active, so the server action also pre-flights and surfaces a clear "Mark the template active first" message.
- `Hide from client portal` -- appears when `is_live=true`. Flips `is_live=false`. The template stays in the practitioner-side `Live in client portal` group disappears; the row moves to the `Active (not live)` group.

Lifecycle (each transition is a deliberate practitioner click):

```
Draft (new) -> Active (ready for use in the studio) -> Live (clients can see and sign)
```

- New templates land as `(status='draft', is_live=false)`. `createConsentTemplateAction` forces both server-side, so a hand-crafted form post cannot land in `active` either.
- Moving back to Draft or Archive auto-flips `is_live=false` so a careless Archive cannot leave a row live in the portal.
- Moving forward to Active does NOT auto-flip `is_live=true`. The practitioner has to confirm with the explicit Live toggle.

The portal query (`getActiveConsentTemplatesForPortal`) requires both `is_live=true` and `status='active'`. The redundancy is defense-in-depth: the CHECK constraint guarantees the second clause given the first, but if a future migration drops the CHECK the explicit filter keeps draft legal text off the wire. The signing action (`createConsentSignatureAction`) applies the same two-clause gate so a malicious client who guessed a draft template id still gets the generic "no longer available" error.

Card authorization (`form_type='card_authorization'`) and photo consent (`form_type='photo_consent'`) are normal `consent_form_templates` rows. The same Live / Draft control gates them. Willow's currently-active `card_authorization` template was backfilled to `is_live=true` so PR #158's Add card guidance keeps working without operator intervention.

Audience targeting (per-modality / per-service / new-vs-existing-client) is **deferred**. The portal query has no appointment or service context today; adding targeting requires a separate column on templates, a portal-side context resolution, and a fail-open rule (show the live form if context is unknown). PR #167 ships only the Live / Draft gate.

Historical signatures are untouched. `client_consent_signatures` rows snapshot `template_title_snapshot`, `template_body_snapshot`, and `template_version` at sign time (migration 0057); the portal "Completed forms" surface reads signatures directly and never joins the templates table. Flipping a template to draft or archived cannot hide or delete a signed record.

Photo consent (PR #137) extends the form with two buttons ("Accept" / "Deny") and writes the matching `response` + `response_label_snapshot` onto the row. A deny is not unsigned; it is a signed record that the client said no.

## What the snapshot guarantees

When Chloe later looks at a signed form, she sees **exactly the text the client saw at signing time**; not the current template body. Even if she edits the template tomorrow, the signature row's snapshot is frozen.

`template_hash` makes verification cheap: SHA-256 hex of `canonicalize(title) + canonicalize(body) + version`. Comparing the hash on the signature row to the hash of the current template row tells you instantly whether the template has changed since the signing.

## Where signatures are surfaced

| Surface | What is shown |
|---|---|
| `/portal` → "Your info" | Read-only list of forms the client has signed (title + version + signed-at + response if photo consent). |
| `/clients/<id>` (practitioner) | Pinned-notes-style display of latest signatures with the snapshot text expandable. |
| `/settings/consent` (practitioner) | Template author + signed-history list per template. |

**CORRECTION (2026-07-27): the signed-consent viewer SHIPPED** (PR #405) — `components/signed-consent-viewer.tsx` exists at the production SHA and practitioners can open the full signed form plus the photo-consent choice. The earlier "still on the backlog" note is superseded; the historical display rationalely minimal.

## Card authorization specifically

`form_type = 'card_authorization'`. Required before the portal Stripe Elements form will show. The portal action `createCardSetupIntentAction` looks up the latest signed authorization for `(studio, client)`; if none exists or it is older than the current template version, the form is not offered.

### Current-version signature gate (PR #170)

PR #170 introduced a shared helper `lib/consent/current-card-authorization.ts:getCardAuthorizationStatus` that is the single source of truth for "is the client's card_authorization signature current?". The helper returns one of four discriminated kinds:

| kind | Meaning | Portal surface | Practitioner surface |
|---|---|---|---|
| `no_live_template` | Studio has not authored a live card_authorization template | "Card setup is not available yet" (PR #158) | "Card authorization template not configured" |
| `unsigned` | Live template exists; client never signed | "Card authorization needed before adding a card" (PR #158) | "Card authorization not signed" |
| `signed_out_of_date` | Client signed an older version; studio has since updated the template | "Card authorization was updated. Please review and sign the new version." (PR #170) | "Card authorization on file is out of date" (no active card) OR "Authorization needs re-signing" (active card present) |
| `signed_current` | Client signed the current live version | Add Card surface available | "Card authorization signed" with timestamp |

The gate is enforced at three sites, all reading the same helper or the same predicate:

- `app/portal/payment-method-actions.ts:createCardSetupIntentAction` -- refuses the SetupIntent unless `kind === "signed_current"`.
- `lib/billing/manual-fee-eligibility.ts` -- surfaces "Card authorization on file is out of date" as a blocking reason when the signature's `template_version` differs from the live template's current version.
- `components/payment-method-card.tsx` (practitioner) and `app/portal/page.tsx` (client portal) -- render the dedicated re-sign state when out-of-date.

The portal's `unsignedConsentTemplates` filter includes the live `card_authorization` template when the latest signature is at an older version, so the existing Review and sign UI handles re-signing without a separate code path. The signing action (`createConsentSignatureAction`, PR #167 `is_live=true` gated) writes a new signature row with the current `template_version`, which immediately satisfies the gate.

The historical signature is preserved (the snapshot model in migration 0057 is immutable). Only NEW live work (SetupIntent, manual fee charge) is gated.

### Production state and the placeholder body (PR #170)

Before PR #170, both production studios (Willow Electrolysis and Sam's "My Studio") had `card_authorization` rows with `title="test"` and `body="test"` (4 chars). PR #170 ships:

- The product-ready DRAFT body in `lib/consent/card-authorization-draft.ts:CARD_AUTHORIZATION_DRAFT_V1_BODY` (around 2.5 kB, covers all 7 spec topics: card on file, completed-session off-session charges, late cancellation, no-show, receipts/refunds/disputes, payment processing + privacy, scope + revocation).
- The recommended product-ready TITLE `"Card on file authorization"`.
- The current-version gate (above) so that once an owner updates the production template via Settings → Consent forms (which bumps `version` from 1 to 2 via the existing `updateConsentTemplateAction`), all historical signatures against `body="test"` stop satisfying the authorization clause until each client re-signs.

**The DRAFT is NOT legally approved.** It is a product-ready draft suitable for Chloe + legal counsel to review. The Hone codebase deliberately does NOT claim approval. The legal review track is separate from this PR; once approved (or edited), the owner pastes the final body into Settings → Consent forms, which bumps the version and triggers the re-sign UI.

**Operator step after PR #170 deploys** (Chloe-driven, not part of the PR's runtime):
1. Sign in to `/settings/consent`.
2. Find the `card_authorization` row titled `"test"`.
3. Click Edit; change the title to `"Card on file authorization"`; paste the canonical body from `lib/consent/card-authorization-draft.ts:CARD_AUTHORIZATION_DRAFT_V1_BODY` (or the lawyer-approved final wording).
4. Click Save. The action bumps `version` from 1 to 2.
5. Verify via `supabase db query --linked` that title, body length, version, status, and is_live look right.
6. Any client who had signed the placeholder body will now see the "Card authorization was updated" block in their portal and must re-sign before Add Card or new manual fees can proceed.

Sam can repeat the same step for the "My Studio" dev row from his own owner session.

**Completed forms surface (PR #159).** The portal's prior "Signed forms" section is now called "Completed forms" and renders as a quiet record list (soft border-top dividers, no bordered cards). Caption verb is `"Completed "` for treatment_consent / general / card_authorization; photo_consent rows keep `"Consent granted · "` / `"Consent denied · "` because the response itself is the record. A small footnote sets honest expectations: a viewable copy of the signed form is a future PR.

**Portal guidance when authorization is missing (PR #158).** Until the client signs `card_authorization`, the portal does NOT silently hide the card section. The "Needs you" zone surfaces a calm placeholder: `"Card authorization needed before adding a card. Before you can add a card on file, please review and sign the card authorization form above. Once that form is signed, the secure card form will appear here. No charge will be made when you add a card."` plus a `Review card authorization` button that deep-links to the existing "Review and sign forms" block (anchor `#forms-to-sign`). The matching practitioner-side card on `app/(app)/clients/[id]/page.tsx` renders one of three explanatory branches (`Card authorization template not configured` / `Card authorization not signed` / `Card authorization signed, but no card is on file yet`) so the practitioner can read out the exact next step to the client.

On successful SetupIntent webhook (`setup_intent.succeeded`), the new `client_payment_methods` row records `card_authorization_signature_id = <the signature row's id>`. The PR #145 manual fee charge eligibility helper re-checks this FK still resolves to a signature scoped to the same `(studio, client)` before allowing prepare.

## Photo consent allow/deny (PR #137)

Photo consent was originally a single-button "Sign" flow. PR #137 introduced an explicit binary:

- **Accept** → signature row with `response='accepted'`, `response_label_snapshot='I agree to photographs being taken and stored.'` (or whatever the template body says).
- **Deny** → signature row with `response='denied'`, `response_label_snapshot='I do not agree to photographs being taken or stored.'`

`template_hash` is computed over the same `(title, body, version)` tuple; it is NOT widened with the response. Reason: the response is a client choice about the SAME template, not a different template.

## Legal draft status

Per Sam's instruction: do not claim signatures are legally binding. The Hone-side data is evidence-friendly; title/body/version snapshot, typed name, signed-at timestamp, hash, hashed IP/UA. Whether a signed record holds up in a fee dispute, an insurance claim, or a regulator inquiry depends on lawyer-reviewed wording.

| Document | Draft wording exists | Reviewed by Ontario counsel |
|---|---|---|
| Treatment consent | Yes (in studio settings) | **No** |
| Photo consent | Yes | **No** |
| Card authorization | Yes | **No** |
| Cancellation policy text | Studio writes their own; default empty | **No** |
| No-show policy text | Studio writes their own; default empty | **No** |
| Session-payment receipt email | **Drafted and sent in test mode (PR #175)**: `lib/email/templates/payment-receipt.ts` is dispatched on a successful test session-payment charge. | **No** |
| Manual-fee charge notice email | **Not drafted; not sent.** The legacy manual cancellation/no-show fee path sends no receipt or charge notice today. | N/A |

All of the above require Ontario legal review before live use of any fee charging.
