// Versioned electrolysis acknowledgement: RETIRED, kept as the legacy READ
// contract.
//
// RETIREMENT (this PR). #518 was a temporary stand-in for the studio's own
// consent documents. #529 shipped the real thing: the studio's live
// treatment/photo consent forms, completed inside the intake, so this
// acknowledgement is no longer collected: the question is gone from
// INTAKE_STEPS, the wizard sends no claim, the public sanitizer admits no
// carve-out for it, and the submit gate no longer requires or builds one.
//
// WHAT REMAINS, AND WHY. Every intake that already recorded an
// acknowledgement must stay readable forever, showing the wording snapshot
// and version the client actually read. So the constant, the claim parser and
// readElectrolysisAcknowledgement all stay. The three WRITE-side helpers
// (claim builder, draft-record builder, submit validator) are gone with the
// collection they served: leaving them would be an invitation to re-wire a
// retired write path.
//
// Nothing here is backfilled, rewritten or deleted from stored history.
//
// Both the public client wizard (app/intake/[token]/IntakeWizard.tsx, a
// client component) and the practitioner review surface
// (app/(app)/clients/[id]/intake/page.tsx, a server component) read the
// wording from here. There is deliberately NO second copy of the string
// anywhere in the tree; tests/lib/intake/electrolysis-acknowledgement.test.ts
// pins that.
//
// NOT server-only, and NO node:crypto. This module is imported into the
// public wizard's client bundle, so it must stay pure and isomorphic. That
// is also why the stored provenance record carries the literal wording
// snapshot rather than a hash: it mirrors the
// `client_consent_signatures.template_body_snapshot` convention (docs/05),
// where the frozen text itself is the evidence and a hash is only a
// convenience.
//
// WHAT THIS IS NOT
// ----------------
// This is an acknowledgement checkbox inside the health intake. It is NOT
// a consent form, NOT an electronic signature, and NOT a replacement for
// the studio's own informed-consent documents or policies (those live in
// `consent_form_templates` / `client_consent_signatures` and are signed in
// the client portal with a typed name: an entirely separate system that
// this module must never touch). No typed signature is collected here and
// none may be added.
//
// WORDING APPROVAL STATUS
// -----------------------
// This exact v1 wording and help text were reviewed and APPROVED by Chloe
// on 2026-08-06 for the initial Hone rollout. No wording change was
// requested at approval.
//
// That approval is PRODUCT AND CLINICAL, not legal. This module does not
// claim the wording is legally approved or reviewed by counsel, and it must
// never be described that way. What the client ticks remains an
// acknowledgement of what electrolysis involves. It is NOT informed
// consent, NOT a consent form, NOT an electronic signature, and NOT any
// form of clearance to treat. The studio's own informed-consent documents
// and policies are separate and unaffected.
//
// The approval is scoped to the wording exactly as it stands at v1. Any
// future edit requires a version bump (see CHANGING THE WORDING below) AND
// fresh review: approving v1 says nothing about v2. Neither approving nor
// bumping a version reaches backwards: intakes already submitted keep the
// wording snapshot their client actually read.
//
// Per the posture established by lib/consent/card-authorization-draft.ts,
// any statement about approval status lives in THIS comment and in the
// PR/docs record, never in the string the client reads.
//
// CHANGING THE WORDING
// --------------------
// `wording` and `version` move together. Any edit to `wording` MUST bump
// `version`. The submit boundary compares the client-asserted version and
// wording against these constants by exact equality, so a wording edit
// without a version bump would silently let an older-version acceptance
// look current. tests/lib/intake/electrolysis-acknowledgement.test.ts pins
// both literals so an edit to one without the other turns the suite red.
//
// Bumping the version does NOT rewrite history: already-submitted intakes
// keep the snapshot of the wording their client actually read, and the
// practitioner review surface renders that stored snapshot, not the
// current constant.

export const ELECTROLYSIS_ACKNOWLEDGEMENT = {
  // Stable identifier for the acknowledgement itself. Also the key the
  // provenance record is stored under in client_intake_forms.responses.
  id: "electrolysis_acknowledgement",

  // Bump on ANY wording edit. See "CHANGING THE WORDING" above.
  version: "v1",

  // The intake question key the checkbox answer is stored under. This is
  // deliberately DIFFERENT from `id`: the boolean answer and the
  // provenance record occupy two distinct keys in the responses map. If
  // they collided, the object would overwrite the boolean and
  // findMissingRequiredAnswers (which requires `value === true` for a
  // checkbox) would reject every submission forever.
  questionKey: "ack_electrolysis_nature",

  // The exact text displayed to the client, and the exact text snapshotted
  // into the stored record.
  wording:
    "I understand that electrolysis is a course of treatment rather than a single appointment: hair is treated one follicle at a time, permanent results build over a series of sessions spaced across months, and the number of sessions varies from person to person. I understand that treatment involves some sensation, that temporary skin reactions such as redness or swelling can follow a session, and that my electrologist will talk through what to expect for my own skin and hair.",

  // Sub-text under the checkbox. Carries the two boundaries this feature
  // must never blur: it is not a signature, and it is not the studio's
  // consent form.
  helpText:
    "Ticking this box is not a signature and is not a consent form. Your electrologist will still go through consent and aftercare with you in person.",
} as const;

// The provenance record persisted under
// `client_intake_forms.responses[ELECTROLYSIS_ACKNOWLEDGEMENT.id]`.
//
// `accepted_at` is present only once the intake has been submitted; it is
// stamped by the server from its own clock and is never taken from the
// browser. Draft rows carry the record WITHOUT `accepted_at`, because a
// draft records what the client has ticked so far, not an acceptance.
export type ElectrolysisAcknowledgementRecord = {
  id: string;
  version: string;
  wording: string;
  accepted: boolean;
  accepted_at?: string;
};

// What the browser asserts it saw and agreed to. The submit boundary
// compares every field of this claim against the canonical constant; it is
// never persisted verbatim.
export type ElectrolysisAcknowledgementClaim = {
  id: string;
  version: string;
  wording: string;
  accepted: boolean;
};

// Upper bound on the claimed strings we are willing to hold in memory
// before comparing them. The canonical wording is well under this; the cap
// exists so a forged payload cannot make the server retain a multi-megabyte
// string just to fail an equality check against it.
const MAX_CLAIM_FIELD_CHARS = 4000;

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > MAX_CLAIM_FIELD_CHARS) return null;
  return value;
}

// Narrow an untrusted inbound value to the claim shape, or `null`. Applied
// by the public actions' sanitizer before the value is allowed anywhere
// near storage: unknown fields are dropped, non-strings rejected, oversize
// strings rejected, and `accepted` is coerced to a strict boolean (only a
// literal `true` counts as accepted).
export function normalizeElectrolysisAcknowledgementClaim(
  value: unknown,
): ElectrolysisAcknowledgementClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = boundedString(raw.id);
  const version = boundedString(raw.version);
  const wording = boundedString(raw.wording);
  if (id === null || version === null || wording === null) return null;
  return { id, version, wording, accepted: raw.accepted === true };
}

// ---------------------------------------------------------------------------
// Read side (practitioner review)
// ---------------------------------------------------------------------------

// Intake lifecycle status, as stored on client_intake_forms.status. Passed
// in for ONE inference, and only that one: an absent record on a
// submitted/reviewed intake proves the intake predates this feature,
// because submission now requires the record. An absent record on a draft
// proves nothing further: the client may not have got to the step, or may
// have read the wording and chosen not to tick it (the wizard writes no
// record until the checkbox is touched). The read side must therefore
// report "no record" for a draft and MUST NOT narrate the client's
// progress; see ACKNOWLEDGEMENT_REVIEW_COPY.noRecord.
export type IntakeLifecycleStatus = "in_progress" | "submitted" | "reviewed";

export type AcknowledgementView =
  // Recorded and valid against the version the client actually saw.
  | {
      state: "acknowledged";
      version: string;
      wording: string;
      acceptedAtIso: string | null;
    }
  // Record present, client has not ticked the box. It used to be true that
  // this was "only reachable on a draft, because submission is refused
  // without an acceptance", retirement removed that gate, so a draft left
  // unticked before retirement can now be submitted and arrive here with
  // status `submitted`/`reviewed`. The copy below must therefore claim
  // nothing about submission being blocked.
  | { state: "not_acknowledged"; version: string; wording: string }
  // No record, and the intake is still being filled in. Deliberately
  // says nothing about how far the client got.
  | { state: "no_record" }
  // No record on a submitted/reviewed intake. RENAMED from "predates" at
  // retirement: that word asserted the intake was submitted BEFORE this
  // acknowledgement existed, which the database cannot prove any more. Now
  // that #518 is retired, an intake submitted TODAY also carries no record,
  // and calling that "predates" would be a plain falsehood on a clinical
  // surface. The state now reports only what is true: nothing was recorded.
  | { state: "not_recorded" }
  // A record exists but does not match the shape we write. Shown as-is
  // rather than dressed up as an acceptance.
  | { state: "unreadable" };

// Pure projection over a stored responses map. Tolerates a missing key,
// a malformed record and a legacy row; never throws, never validates
// required-ness, and never writes. Mirrors the read-path posture of
// deriveIntakeReviewFlags / computeFitzpatrickEstimate.
export function readElectrolysisAcknowledgement(
  responses: Record<string, unknown> | null | undefined,
  status: IntakeLifecycleStatus,
): AcknowledgementView {
  const map =
    responses && typeof responses === "object" && !Array.isArray(responses)
      ? (responses as Record<string, unknown>)
      : {};
  const raw = map[ELECTROLYSIS_ACKNOWLEDGEMENT.id];
  if (raw === undefined || raw === null) {
    return status === "in_progress"
      ? { state: "no_record" }
      : { state: "not_recorded" };
  }
  const claim = normalizeElectrolysisAcknowledgementClaim(raw);
  if (!claim || claim.id !== ELECTROLYSIS_ACKNOWLEDGEMENT.id) {
    return { state: "unreadable" };
  }
  if (claim.accepted !== true) {
    return {
      state: "not_acknowledged",
      version: claim.version,
      wording: claim.wording,
    };
  }
  const acceptedAtRaw = (raw as Record<string, unknown>).accepted_at;
  return {
    state: "acknowledged",
    version: claim.version,
    wording: claim.wording,
    acceptedAtIso:
      typeof acceptedAtRaw === "string" && acceptedAtRaw.length > 0
        ? acceptedAtRaw
        : null,
  };
}

// Practitioner-facing copy, centralized so the review surface never
// hand-writes a claim about what a client did or did not agree to. Kept
// free of any "safe / approved / cleared" framing: Hone surfaces the
// record, it does not render a verdict.
export const ACKNOWLEDGEMENT_REVIEW_COPY = {
  heading: "Electrolysis acknowledgement",
  acknowledged: "Acknowledged by the client.",
  // States only what the stored row proves. The trailing clause "an intake
  // cannot be submitted until they do" was TRUE while #518 gated submission
  // and became FALSE at retirement: a pre-retirement draft left unticked now
  // submits, so a practitioner reading a submitted intake would have been
  // told a plain falsehood on a clinical surface. Same defect class as the
  // "predates" copy retired alongside it.
  notAcknowledged: "Not acknowledged. The client did not tick this box.",
  // States only what the stored row proves. An earlier draft of this copy
  // said the client "has not got to the acknowledgement step", which is
  // false for a client who read the wording and chose not to tick it,
  // both cases store no record at all.
  noRecord: "No acknowledgement recorded. This intake is still in progress.",
  // Neutral and provable. Says what the row shows and claims nothing about
  // when the intake was submitted relative to the retired acknowledgement.
  notRecorded:
    "No versioned electrolysis acknowledgement was recorded with this intake.",
  unreadable:
    "An acknowledgement entry is present but could not be read. Treat this intake as not acknowledged.",
  caveat:
    "An acknowledgement of what electrolysis involves. It is not a signature and not a consent form.",
} as const;
