---
type: product workflow
title: Intake forms, review and assisted intake
description: How a client completes a health intake through the signed /intake/<token> link (rate limit, generic token refusal, whitelisted answers, server-derived consent records, conditional status transitions, fill-blank client sync), how a practitioner requests, resends and reviews intakes through one conditional update, how practitioner-assisted entry works with client-owned answers and an optimistic-concurrency token, and which boundaries the database does and does not enforce.
tags: [intake, health-data, public-routes, review, assisted-intake, consent, rls]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
sources:
  - id: openwiki-source-214e9cc45cdc65a84aae5716
    resource: repo://app/(app)/clients/%5Bid%5D/intake/actions.ts
  - id: openwiki-source-152ca6bc1c0369adf4ec2083
    resource: repo://app/intake/%5Btoken%5D/actions.ts
  - id: openwiki-source-e2ff2d5ec8ce9ed68fec4e72
    resource: repo://docs/production/migration-state.json
  - id: openwiki-source-190b11b80bde3dcefe448e64
    resource: repo://e2e/intake-live-consent-forms.spec.ts
  - id: openwiki-source-fbcbcfd05036ee2b2f2b51ca
    resource: repo://e2e/intake-review-integrity.spec.ts
  - id: openwiki-source-32ad79c0910a770e9fa03135
    resource: repo://lib/intake/link-status.ts
  - id: openwiki-source-b9326e1bc2eb6a5b5e3885d6
    resource: repo://lib/intake/questions.ts
  - id: openwiki-source-66ac403a533e942bc169ae26
    resource: repo://lib/intake/tokens.ts
  - id: openwiki-source-22357df38d5495ba294853b3
    resource: repo://tests/db/practitioner-assisted-intake.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
---

# Intake forms, review and assisted intake

An **intake** (`client_intake_forms`) is a client's health questionnaire. It moves
`in_progress → submitted → reviewed`. Clients fill it in through a signed public link. Practitioners
request, resend, review and, when needed, enter answers with the client present. The integrity
boundaries are summarised on [Client portal, intake and consent](client-portal-intake-and-consent.md):
`0118` terminal immutability, `0162` review transition and `0163` no authenticated insert. The token
route's privacy headers are on [Public token routes](../security/public-token-routes-and-privacy.md).

Answers are health data. Nothing below copies an answer, and the code never logs them.

## 1. The public link (`/intake/<token>`)

- **Token.** A token is an HMAC-SHA256-signed `{intake_id, expires_at}` under a dedicated
  `INTAKE_SIGNING_SECRET`. Verification uses a timing-safe compare
  ([`lib/intake/tokens.ts`](../../lib/intake/tokens.ts)).
- **Opaque refusal.** An expired, malformed or forged token gets **one** generic message, so the
  response cannot reveal whether a token was real.
- **Rate limit first.** Each save and submit is rate-limited (`intake_save` / `intake_submit`) before
  token verification. The limiter fails open by design
  ([public intake actions L38-L104](../../app/intake/[token]/actions.ts#L38-L104)).

**Saving a step** (`saveIntakeStepAction`):

- **Whitelisted answers.** Responses are reduced to known question keys and their `_notes` siblings.
- **One bounded consent claim** is admitted per form. It is evidence to check, not content: every stored
  consent snapshot field is re-derived from the studio's own live template row, and a stale or forged
  claim is dropped.
- **Merged updates.** Saves merge with the stored answers. The update is conditional on
  `status = 'in_progress'`, so a race with submit writes nothing
  ([L45-L186](../../app/intake/[token]/actions.ts#L45-L186)).

**Submitting** (`submitIntakeAction`) ([L187-L392](../../app/intake/[token]/actions.ts#L187-L392)):

- **Already submitted.** An intake that is already submitted or reviewed returns success idempotently.
- **Answer checks.** Missing required answers or an invalid choice value refuse the submit.
- **Consent checks.** `validateIntakeConsentResponses` checks the live consent forms against a fresh
  read, so a template edited mid-form is refused until answered against the current version.
- **One transition.** A single update moves `in_progress → submitted`. Zero rows (a lost race) also
  reads as success.
- **Fill-blank sync.** Afterwards the action copies emergency contact, date of birth, pronouns,
  address and allergy text onto the client **only where the client field is empty**. It never
  overwrites practitioner-entered data.
- **Notification.** It records an `intake_submitted` practitioner notification.

**Retired acknowledgement (#518).** The electrolysis acknowledgement is no longer collected. Its keys
are stripped on the way in, so no new record can be authored from a browser. A historical record
cannot be overwritten, because the merge keeps stored keys. The practitioner view renders the
**stored** wording and version, and says "no record" neutrally when none exists
(`e2e/intake-electrolysis-acknowledgement.spec.ts`).

## 2. Requesting, resending and link status

- **Request update.** `requestIntakeUpdateAction` always creates a **new** `in_progress` intake.
  Earlier submitted and reviewed rows are preserved verbatim. It optionally emails the link, behind a
  per-practitioner, per-client email rate limit
  (`app/(app)/clients/[id]/intake/actions.ts` L401-L470).
- **Copy link and resend.** "Copy link" mints a fresh tokenized URL only for an `in_progress` row and
  does not touch the row. Resend applies the same ownership and status guards, mints a fresh token and
  emails it.
- **Link status.** `lib/intake/link-status.ts` turns the `0097` link metadata into a display status
  (expires when, days left, which call to action). It says plainly that the **signed token remains
  the authoritative expiry**. Legacy rows fall back to a heuristic flagged `usingFallback`.

## 3. Review: one conditional update

`markIntakeReviewedAction` is a single `UPDATE … SET status='reviewed', reviewed_at, reviewed_by`. It
matches only `(id, studio_id, client_id)` with `deleted_at is null`, `status = 'submitted'` and a
non-null `submitted_at`. It then requires `.select()` to show exactly one row
(`app/(app)/clients/[id]/intake/actions.ts` L144-L246):

- **One opaque refusal.** Absent, cross-client, cross-studio, deleted, already-reviewed and
  in-progress outcomes all return the same message, so there is no existence oracle.
- **No raw errors.** Database errors are logged server-side and never returned.

At the database boundary, `0162` makes `reviewed` reachable only from a genuinely submitted row, by
the caller's own active practitioner, at a database time. The browser proof is
`e2e/intake-review-integrity.spec.ts`:

- an in-progress intake shows no review action;
- confirm, cancel and Escape behave correctly;
- a forged cross-client review changes nothing;
- two concurrent confirms produce exactly one transition.

## 4. Practitioner-assisted intake

A practitioner can fill the questionnaire **with the client present**, then hand it back for the
client's own acknowledgements (`app/(app)/clients/[id]/intake/actions.ts` L734-L1059):

- **Practitioner-enterable steps.** Only `PRACTITIONER_ENTERABLE_STEPS` can be addressed, which is
  every step except acknowledgements.
- **Client-owned keys.** `CLIENT_OWNED_RESPONSE_KEYS` are the acknowledgement questions plus *every*
  checkbox question anywhere, with their `_notes`. A save that would change one is refused loudly,
  not silently stripped ([`questions.ts` L980-L1023](../../lib/intake/questions.ts#L980-L1023)).
- **Merge order.** Stored answers come first, so the client's own answers survive.
- **Choice checks.** The same invalid-choice check as the public submit runs over the merged map.
- **Optimistic concurrency.** The update requires the `updated_at` the editor last saw. A concurrent
  save, most likely the client's own link, makes the second writer **refresh** rather than overwrite.
- **Server-derived provenance.** Provenance (`started_at/by`, later `handoff_at/by`) comes from the
  session. A second practitioner never overwrites who started.
- **Hand-off.** Hand-off stamps provenance only when assisted entry actually happened, advances to the
  acknowledgements step and returns a fresh client link. It never submits. **Only the client's own
  submit reaches `submitted`.**

Database proof (`tests/db/practitioner-assisted-intake.db.test.ts`):

- a member may write a draft's answers;
- a member **cannot** move an intake to `submitted` or attach review metadata;
- submitted and reviewed answers and provenance are frozen;
- other studios can neither write nor read the intake.

The browser journey, including "live consent forms appear only on the client side of the hand-off",
is `e2e/practitioner-assisted-intake.spec.ts`.

## 5. Contradictions and open questions

1. **Provenance is not database-enforced.** The same DB suite proves that a member *can* write
   provenance naming a colleague by direct SQL. The `client_intake_forms` member update policy checks
   only studio membership, with no column or actor predicate
   ([test L309-L331](../../tests/db/practitioner-assisted-intake.db.test.ts#L309-L331)). The app
   derives provenance from the session, but the record is not unforgeable.
2. **Stale "not applied" comment.** The review action's header still says `0162` "is NOT YET APPLIED
   to production (hosted migration max is still 0161)". The declared hosted maximum in
   `docs/production/migration-state.json` is now beyond `0162`. Treat the comment as history.
3. **Service-role paths rely on application checks.** The public save and submit run as the service
   role, which `0118`'s trigger exempts. Their safety rests on the conditional `status` predicates
   above, as the portal page also records.
