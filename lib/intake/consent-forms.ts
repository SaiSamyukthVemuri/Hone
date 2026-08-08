// The studio's real, live consent forms, completed inside the health intake.
//
// WHAT THIS IS
// ------------
// The client reads the studio's OWN consent text — the same
// `consent_form_templates` rows the portal renders — and completes each form
// with a control appropriate to its type:
//
//   treatment_consent : a required checkbox, "I have read and agree to this
//                       form." Unchecked by default. The intake cannot be
//                       submitted until every live treatment consent is
//                       checked.
//   photo_consent     : an Accept / Deny choice with NO default. BOTH answers
//                       complete the form. Denying photo use must never block
//                       an intake submission — the requirement is that the
//                       client ANSWERS the question, not that they agree.
//
// WHAT THIS IS NOT
// ----------------
// This is NOT an electronic signature and must never be described as one. No
// typed name is collected here and none may be added. The portal's formal
// signing ceremony (`client_consent_signatures`, a typed name, and
// lib/consent/sign-consent-form.ts) continues to exist as a SEPARATE system
// that this module never writes to. That table's `signature_name` column is
// NOT NULL with a 1..200 length CHECK, so routing an intake checkbox through
// it would require fabricating a name — which is exactly why intake responses
// live in the intake's own record instead.
//
// This module is deliberately ISOMORPHIC — no `server-only`, no `node:crypto`
// — because the public wizard is a client component and imports the claim
// builder and the response constants from here. Everything that needs the
// canonical hash or the database lives in lib/intake/consent-gate.ts, which IS
// server-only. Keep it that way: importing the hash helper here would drag
// node:crypto into the public client bundle.

// The form types the intake surfaces. Deliberately NOT every type in the
// `consent_form_templates` CHECK constraint: card_authorization is a payment
// artefact, and general / policy_acknowledgement have no product contract
// requiring them inside intake. Widening this set is a product decision, not a
// refactor.
export const INTAKE_CONSENT_FORM_TYPES = [
  "treatment_consent",
  "photo_consent",
] as const;

export type IntakeConsentFormType = (typeof INTAKE_CONSENT_FORM_TYPES)[number];

export function isIntakeConsentFormType(
  value: unknown,
): value is IntakeConsentFormType {
  return (
    typeof value === "string" &&
    (INTAKE_CONSENT_FORM_TYPES as ReadonlyArray<string>).includes(value)
  );
}

// The reserved key the responses object is stored under in
// `client_intake_forms.responses`, and the shape version. Same storage
// convention as the versioned electrolysis acknowledgement (#518) and the
// practitioner-assisted provenance record (#525): a reserved non-question key
// inside the existing jsonb column, so no migration is required.
export const INTAKE_CONSENT_RESPONSES = {
  id: "intake_consent_responses",
  version: 1,
} as const;

// A completed response. `accepted` is the only valid answer for a treatment
// consent; a photo consent may be either. There is deliberately no third
// "skipped" state — an unanswered form is an ABSENT entry, not a stored one.
export type IntakeConsentResponse = "accepted" | "denied";

// What the SERVER stores per form. Every field except `response` is derived
// from the database row the server itself re-read; the client's claim is only
// ever evidence that its browser rendered that exact text.
export type IntakeConsentFormRecord = {
  template_id: string;
  form_type: IntakeConsentFormType;
  template_version: number;
  title_snapshot: string;
  body_snapshot: string;
  template_hash: string;
  response: IntakeConsentResponse;
  // Photo consent only: the server-owned label matching the chosen response,
  // reusing lib/consent/sign-consent-form.ts's exact constants so an audit
  // reads the same words the portal would have recorded. null for treatment.
  response_label_snapshot: string | null;
  // Stamped by the server at SUBMIT only. A draft carries the record WITHOUT
  // it, mirroring the acknowledgement record's `accepted_at` semantics: a
  // draft records what the client has chosen so far, not a completion.
  responded_at?: string;
};

export type IntakeConsentResponsesRecord = {
  version: number;
  forms: IntakeConsentFormRecord[];
};

// What the BROWSER sends. Four fields, all of them claims or comparands:
//
//   template_id            — which form this answers
//   form_type              — what the browser believes it rendered
//   rendered_template_hash — the canonical hash of the EXACT (title, body,
//                            version) the browser displayed
//   response               — the client's checkbox / radio choice
//
// None of these is authority. The server re-resolves the template, recomputes
// the hash from its own row, and refuses when they disagree — which is what
// stops a studio edit between render and submit from recording agreement to
// text the client never read.
export type IntakeConsentFormClaim = {
  template_id: string;
  form_type: IntakeConsentFormType;
  rendered_template_hash: string;
  response: IntakeConsentResponse;
};

export type IntakeConsentClaims = {
  version: number;
  forms: IntakeConsentFormClaim[];
};

// Upper bounds on claimed strings, so a forged payload cannot make the server
// hold megabytes in memory just to fail an equality check. Same posture as
// MAX_CLAIM_FIELD_CHARS in lib/intake/acknowledgements.ts.
const MAX_ID_CHARS = 200;
const MAX_HASH_CHARS = 200;
// A studio may legitimately run several treatment and photo forms; this is a
// sanity ceiling on a forged array, not a product limit.
const MAX_CLAIM_FORMS = 50;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  return value;
}

function normalizeFormClaim(value: unknown): IntakeConsentFormClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const templateId = boundedString(raw.template_id, MAX_ID_CHARS);
  const renderedHash = boundedString(raw.rendered_template_hash, MAX_HASH_CHARS);
  if (templateId === null || renderedHash === null) return null;
  if (!isIntakeConsentFormType(raw.form_type)) return null;
  if (raw.response !== "accepted" && raw.response !== "denied") return null;
  return {
    template_id: templateId,
    form_type: raw.form_type,
    rendered_template_hash: renderedHash,
    response: raw.response,
  };
}

// Narrow an untrusted inbound value to the claims shape, or null. Applied by
// the public action's sanitizer before the value goes anywhere near storage:
// unknown fields dropped, malformed entries dropped, oversize strings
// rejected, and a duplicate template_id collapsed to its FIRST entry so a
// payload cannot smuggle two conflicting answers for one form past a
// first-match lookup.
export function normalizeIntakeConsentClaims(
  value: unknown,
): IntakeConsentClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.forms)) return null;
  const seen = new Set<string>();
  const forms: IntakeConsentFormClaim[] = [];
  for (const entry of raw.forms.slice(0, MAX_CLAIM_FORMS)) {
    const claim = normalizeFormClaim(entry);
    if (!claim) continue;
    if (seen.has(claim.template_id)) continue;
    seen.add(claim.template_id);
    forms.push(claim);
  }
  return { version: INTAKE_CONSENT_RESPONSES.version, forms };
}

// ---------------------------------------------------------------------------
// Read side (practitioner review)
// ---------------------------------------------------------------------------

// A stored form as the practitioner review surface should render it. Always
// built from the SNAPSHOT the client actually read — never from today's
// template row, which the studio may have edited since.
export type IntakeConsentFormView = {
  formType: IntakeConsentFormType;
  titleSnapshot: string;
  bodySnapshot: string;
  templateVersion: number;
  response: IntakeConsentResponse;
  responseLabelSnapshot: string | null;
  respondedAtIso: string | null;
};

export type IntakeConsentView =
  // Forms were completed and stored.
  | { state: "recorded"; forms: IntakeConsentFormView[] }
  // No record on a draft. Says nothing about how far the client got.
  | { state: "no_record" }
  // No record on a submitted/reviewed intake: it was submitted before live
  // consent forms were part of intake, or the studio had none live at the
  // time. Either way the client was never shown a form here.
  | { state: "none_recorded" }
  // A record exists but does not match the shape we write. Reported as-is
  // rather than dressed up as a completion.
  | { state: "unreadable" };

export type IntakeLifecycleStatus = "in_progress" | "submitted" | "reviewed";

function readFormRecord(value: unknown): IntakeConsentFormView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isIntakeConsentFormType(raw.form_type)) return null;
  if (raw.response !== "accepted" && raw.response !== "denied") return null;
  if (typeof raw.title_snapshot !== "string") return null;
  if (typeof raw.body_snapshot !== "string") return null;
  const version = Number(raw.template_version);
  if (!Number.isFinite(version)) return null;
  return {
    formType: raw.form_type,
    titleSnapshot: raw.title_snapshot,
    bodySnapshot: raw.body_snapshot,
    templateVersion: version,
    response: raw.response,
    responseLabelSnapshot:
      typeof raw.response_label_snapshot === "string"
        ? raw.response_label_snapshot
        : null,
    respondedAtIso:
      typeof raw.responded_at === "string" && raw.responded_at.length > 0
        ? raw.responded_at
        : null,
  };
}

// Pure projection over a stored responses map. Tolerates a missing key, a
// malformed record and a legacy row; never throws and never writes. Mirrors
// the read-path posture of readElectrolysisAcknowledgement.
export function readIntakeConsentResponses(
  responses: Record<string, unknown> | null | undefined,
  status: IntakeLifecycleStatus,
): IntakeConsentView {
  const map =
    responses && typeof responses === "object" && !Array.isArray(responses)
      ? (responses as Record<string, unknown>)
      : {};
  const raw = map[INTAKE_CONSENT_RESPONSES.id];
  if (raw === undefined || raw === null) {
    return status === "in_progress"
      ? { state: "no_record" }
      : { state: "none_recorded" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { state: "unreadable" };
  }
  const formsRaw = (raw as Record<string, unknown>).forms;
  if (!Array.isArray(formsRaw)) return { state: "unreadable" };
  // An EMPTY forms array is not malformed — it is the honest record of an
  // intake in which nothing was completed here, which is exactly what happens
  // when every live form was already completed in the portal. Reporting it as
  // "unreadable" told the practitioner the entry "could not be read" and to
  // "treat these forms as not completed", both of which are false and
  // alarming. Found by the portal-precompletion browser journey.
  if (formsRaw.length === 0) {
    return status === "in_progress"
      ? { state: "no_record" }
      : { state: "none_recorded" };
  }
  const forms: IntakeConsentFormView[] = [];
  for (const entry of formsRaw) {
    const view = readFormRecord(entry);
    // One malformed entry does not discard the rest — but it must not be
    // silently counted as a completion either, so it is simply not rendered.
    if (view) forms.push(view);
  }
  // Entries were present but none could be read: that IS malformed.
  if (forms.length === 0) return { state: "unreadable" };
  return { state: "recorded", forms };
}

// Practitioner-facing copy, centralized so the review surface never
// hand-writes a claim about what a client agreed to.
//
// BANNED VOCABULARY: "Signed", "Signature", "Legally signed", "Approved",
// "Cleared". None of those is true of a checkbox or an Accept/Deny radio, and
// only the portal's own signature records may be described as signed.
export const INTAKE_CONSENT_REVIEW_COPY = {
  heading: "Consent forms",
  // Treatment consent: the client ticked "I have read and agree to this form."
  acknowledged: "Acknowledged",
  // Photo consent outcomes. Denied is a COMPLETE answer, not a failure, and
  // the copy must not imply the client did something wrong.
  accepted: "Accepted",
  denied: "Denied",
  notCompleted: "Not completed",
  noRecord: "No consent forms recorded. This intake is still in progress.",
  noneRecorded:
    "No consent forms were recorded with this intake. The studio may have had no live forms at the time.",
  unreadable:
    "A consent entry is present but could not be read. Treat these forms as not completed.",
  // States plainly what these records are — and are not.
  caveat:
    "Recorded inside the intake as the client's response to the studio's forms. This is not a signature; the portal's signed records are separate.",
  // Shown against the stored version so a practitioner reading history knows
  // they are looking at the text the client actually read.
  historicalNote:
    "Shows the form text and version the client read at the time, not the current version.",
} as const;

// Display label for one stored form. Treatment consent reads "Acknowledged";
// photo consent reads its actual answer. Never "Signed".
export function intakeConsentResponseLabel(
  view: Pick<IntakeConsentFormView, "formType" | "response">,
): string {
  if (view.formType === "photo_consent") {
    return view.response === "accepted"
      ? INTAKE_CONSENT_REVIEW_COPY.accepted
      : INTAKE_CONSENT_REVIEW_COPY.denied;
  }
  return INTAKE_CONSENT_REVIEW_COPY.acknowledged;
}
