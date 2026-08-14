// The studio's real, live consent forms, completed inside the health intake.
//
// WHAT THIS IS
// ------------
// The client reads the studio's OWN consent text: the same
// `consent_form_templates` rows the portal renders, and completes each form
// with a control appropriate to its type:
//
//   treatment_consent : a required checkbox, "I have read and agree to this
//                       form." Unchecked by default. The intake cannot be
//                       submitted until every live treatment consent is
//                       checked.
//
// PHOTO CONSENT IS NO LONGER COLLECTED HERE (Chloe, 2026-08-09). It was, from
// #529 until this change. It moved to the client portal: its Accept/Deny
// ceremony is unchanged there, and both answers still complete the form: for
// a product reason, not a technical one: no photographs are taken at the
// consultation, and asking on the intake made clients fear otherwise.
//
// The module still READS photo records, because intakes submitted in that
// window hold real answers. See the two form-type sets below.
//
// WHAT THIS IS NOT
// ----------------
// This is NOT an electronic signature and must never be described as one. No
// typed name is collected here and none may be added. The portal's formal
// signing ceremony (`client_consent_signatures`, a typed name, and
// lib/consent/sign-consent-form.ts) continues to exist as a SEPARATE system
// that this module never writes to. That table's `signature_name` column is
// NOT NULL with a 1..200 length CHECK, so routing an intake checkbox through
// it would require fabricating a name, which is exactly why intake responses
// live in the intake's own record instead.
//
// This module is deliberately ISOMORPHIC, no `server-only`, no `node:crypto`
// because the public wizard is a client component and imports the claim
// builder and the response constants from here. Everything that needs the
// canonical hash or the database lives in lib/intake/consent-gate.ts, which IS
// server-only. Keep it that way: importing the hash helper here would drag
// node:crypto into the public client bundle.

// TWO SETS, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE POINT.
//
// These started as one constant doing two jobs: deciding what the intake
// COLLECTS, and deciding what a stored record may be READ BACK as. That is
// safe only while the two never diverge, and they diverged the moment photo
// consent moved to the portal. Narrowing the single constant would have
// silently deleted every historical photo answer from the practitioner's
// review, because the read-back parser rejects an unknown form_type.
//
// So: COLLECTED may narrow freely. READABLE may only ever grow.

// What the intake asks the client for, TODAY.
//
// Photo consent was removed here (Chloe, 2026-08-09): photos are not taken at
// the consultation, and asking for photo consent on the intake implied to
// clients that they might be. It is NOT retired. It lives in the client
// portal, which is now its only collection surface, with explicit Accept/Deny.
//
// Deliberately NOT every type in the `consent_form_templates` CHECK
// constraint: card_authorization is a payment artefact, and general /
// policy_acknowledgement have no product contract requiring them inside
// intake. Widening this set is a product decision, not a refactor.
export const INTAKE_CONSENT_COLLECTED_FORM_TYPES = [
  "treatment_consent",
] as const;

// Every form type an intake record may LEGITIMATELY contain, including types
// the intake has stopped collecting. Read-back only, never used to decide
// what to show a client.
//
// `photo_consent` stays here forever: intakes submitted while photo consent
// was collected in the intake (PR #529 → this PR) hold real client answers,
// and an "Accepted"/"Denied" a client actually gave must keep rendering.
// REMOVING A TYPE FROM THIS LIST DESTROYS HISTORY.
export const INTAKE_CONSENT_FORM_TYPES = [
  "treatment_consent",
  "photo_consent",
] as const;

export type IntakeConsentFormType = (typeof INTAKE_CONSENT_FORM_TYPES)[number];

// Readable: is this a form type a STORED record may carry? Used by the parsers.
export function isIntakeConsentFormType(
  value: unknown,
): value is IntakeConsentFormType {
  return (
    typeof value === "string" &&
    (INTAKE_CONSENT_FORM_TYPES as ReadonlyArray<string>).includes(value)
  );
}

// Collected: does the intake still ask for this form type? Used by the
// server-side resolver and by the carry-forward rule below.
export function isIntakeConsentCollectedFormType(
  value: unknown,
): value is IntakeConsentFormType {
  return (
    typeof value === "string" &&
    (INTAKE_CONSENT_COLLECTED_FORM_TYPES as ReadonlyArray<string>).includes(
      value,
    )
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
// "skipped" state: an unanswered form is an ABSENT entry, not a stored one.
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

// CARRY-FORWARD: the stored records this intake must keep even though it no
// longer collects them.
//
// Both consent writers REBUILD the stored record by iterating the studio's
// currently-live intake forms. That is what keeps the snapshot server-owned,
// and it also means anything no longer resolved simply stops being written.
// Without this, the first draft save or submit after photo consent moved to
// the portal would silently erase a photo answer the client had already given,
// which is exactly the "history quietly disappears" failure this whole feature
// is supposed to prevent.
//
// So: any well-formed stored form whose type is no longer COLLECTED is
// returned verbatim and re-attached by the writer. Verbatim matters: the
// snapshot is the text the client actually read, and re-deriving it from
// today's template would rewrite history. Nothing here validates against a
// live template, because there deliberately is no longer one to validate
// against.
//
// Only NON-collected types are carried. A treatment record still goes through
// the full live-template + hash check every time; this is not a bypass.
export function retainedHistoricalConsentForms(
  storedResponses: Record<string, unknown> | null | undefined,
): IntakeConsentFormRecord[] {
  const map =
    storedResponses &&
    typeof storedResponses === "object" &&
    !Array.isArray(storedResponses)
      ? (storedResponses as Record<string, unknown>)
      : {};
  const raw = map[INTAKE_CONSENT_RESPONSES.id];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const formsRaw = (raw as Record<string, unknown>).forms;
  if (!Array.isArray(formsRaw)) return [];

  const out: IntakeConsentFormRecord[] = [];
  for (const entry of formsRaw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const r = entry as Record<string, unknown>;
    // Readable but no longer collected: that is precisely the carry-forward
    // set. A record the intake still collects is rebuilt normally.
    if (!isIntakeConsentFormType(r.form_type)) continue;
    if (isIntakeConsentCollectedFormType(r.form_type)) continue;
    // Shape-check every field we re-store, so a malformed entry is dropped
    // rather than carried forward as though it were a real answer.
    if (typeof r.template_id !== "string") continue;
    if (r.response !== "accepted" && r.response !== "denied") continue;
    if (typeof r.title_snapshot !== "string") continue;
    if (typeof r.body_snapshot !== "string") continue;
    if (typeof r.template_hash !== "string") continue;
    if (!Number.isFinite(Number(r.template_version))) continue;
    const record: IntakeConsentFormRecord = {
      template_id: r.template_id,
      form_type: r.form_type,
      template_version: Number(r.template_version),
      title_snapshot: r.title_snapshot,
      body_snapshot: r.body_snapshot,
      template_hash: r.template_hash,
      response: r.response,
      response_label_snapshot:
        typeof r.response_label_snapshot === "string"
          ? r.response_label_snapshot
          : null,
    };
    // Preserve the completion stamp exactly. Re-stamping it with "now" would
    // turn a months-old answer into one given today.
    if (typeof r.responded_at === "string") record.responded_at = r.responded_at;
    out.push(record);
  }
  return out;
}

// What the BROWSER sends. Four fields, all of them claims or comparands:
//
//   template_id           , which form this answers
//   form_type             , what the browser believes it rendered
//   rendered_template_hash, the canonical hash of the EXACT (title, body,
//                            version) the browser displayed
//   response              : the client's checkbox / radio choice
//
// None of these is authority. The server re-resolves the template, recomputes
// the hash from its own row, and refuses when they disagree, which is what
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
// built from the SNAPSHOT the client actually read, never from today's
// template row, which the studio may have edited since.
export type IntakeConsentFormView = {
  // The template this answer was given against. Carried through to the review
  // surface because it is the ONLY honest evidence of consent LINEAGE: editing
  // a consent template is `update ... where id = $id` with `version + 1` on the
  // SAME row (app/(app)/settings/consent/actions.ts), so a template_id is a
  // stable logical consent question across every version, and a DIFFERENT
  // template_id is a genuinely different question. Supersession is decided on
  // this and never on "a portal answer exists, therefore this is old".
  templateId: string;
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
  // template_id is REQUIRED by the stored shape (IntakeConsentFormRecord) and
  // by the carry-forward rule, both of which reject a record without it. A
  // record missing it cannot have its lineage reasoned about, so it is not a
  // record we can render an honest provenance claim for.
  if (typeof raw.template_id !== "string" || raw.template_id.length === 0) {
    return null;
  }
  return {
    templateId: raw.template_id,
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
  // An EMPTY forms array is not malformed. It is the honest record of an
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
    // One malformed entry does not discard the rest, but it must not be
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
  // States plainly what these records are, and are not.
  caveat:
    "Recorded inside the intake as the client's response to the studio's forms. This is not a signature; the portal's signed records are separate.",
  // Shown against the stored version so a practitioner reading history knows
  // they are looking at the text the client actually read.
  historicalNote:
    "Shows the form text and version the client read at the time, not the current version.",
  // Provenance. The two consent sources are never merged into one claim: an
  // answer given inside the intake and an answer signed in the portal are
  // different events, and a practitioner reading a contradiction must be able
  // to see which is which.
  recordedInIntake: "Recorded with this intake",

  // ---- CURRENT-FIRST INFORMATION ARCHITECTURE (Chloe, 2026-08-09) ----------
  //
  // #545 put the historical intake answer FIRST, with its full legal body
  // expanded inline, and the current portal status underneath. A client who
  // accepted photos at intake and then denied them in the portal therefore read
  // as "Photo Consent (Accepted ... <legal text> ... Photo Consent) Consent
  // denied": two answers with equal visual authority. Chloe: "consent was both
  // accepted and denied", "this should not be possible".
  //
  // The records are both real and BOTH ARE KEPT. What changes is authority and
  // order: exactly one CURRENT answer per consent question at the top, prior
  // answers demoted into a collapsed history, and legal wording on demand.
  currentHeading: "Current consent",
  historyHeading: "Previous consent history",
  // Sits under the current block so the practitioner knows the history exists
  // without it competing for attention.
  historyToggle: "Show previous consent history",
  // Provenance for a prior intake answer. Never says "current".
  previousResponse: "Previous response",
  // ONLY rendered when lineage is proven: the same template_id carries a newer
  // portal answer. Never inferred from "some portal answer exists".
  supersededByPortal: "Superseded by a newer portal response",
  // Same template_id, but we cannot prove the portal answer is the newer of the
  // two (the intake record carries no responded_at). Truthful and weaker.
  alsoAnsweredInPortal: "Also answered in the client portal",
  // A prior answer to a form the portal does not currently run, or to a
  // different template entirely. Not superseded, just no longer collected here.
  noLongerCollected: "Photo consent is no longer collected in the intake",
  // Disclosure labels. The review page is a scan surface, not a document
  // viewer, so every full body sits behind one of these.
  // Native <details>/<summary> supplies the open/closed affordance, so one
  // static label each, no second "Hide …" string to keep in sync.
  viewRecordedForm: "View recorded form",
  viewPreviousForm: "View previous form",
} as const;

// Practitioner copy for the CURRENT portal photo-consent status. Same
// vocabulary discipline as the intake copy: a denial is a completed answer,
// never "unsigned" or "missing", and nothing here says "approved".
export const PORTAL_PHOTO_CONSENT_COPY = {
  granted: "Consent granted",
  denied: "Consent denied",
  notCompleted: "Not completed",
  // Signed an older version than the studio's current template: a real answer,
  // but not to the text now in force.
  needsReview: "Needs review",
  completedInPortal: "Completed in client portal",
  // Provenance line for the CURRENT block. Deliberately shorter and more
  // operational than "Completed in client portal": the practitioner is not
  // being told where a form lives, they are being told this is the answer that
  // stands right now.
  currentPortalResponse: "Current portal response",
  notCompletedHint: "The client has not answered this form in their portal yet.",
  needsReviewHint:
    "The client answered an earlier version of this form. Ask them to complete the current one.",
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
