// Practitioner consent review: ONE current answer per consent question, prior
// answers as clearly-labelled history.
//
// WHY THIS MODULE EXISTS
// ===========================================================================
// Chloe, immediately after #545 shipped: "consent was both accepted and
// denied", "this should not be possible", "very confusing".
//
// Both records were real. Her intake carried a photo answer of Accepted
// (3:56 PM) and her portal carried Consent denied (3:57 PM). #545 rendered the
// intake record first — title, answer, and the FULL legal body inline — and the
// current portal status underneath, so the screen presented two answers with
// equal authority and buried the operative one below a wall of legal text.
//
// The defect is presentation and authority, never storage. Nothing here
// deletes, rewrites or reorders a stored record. This module is a pure
// projection that answers two questions the UI could not previously answer:
//
//   1. which answer is CURRENT for each consent question, and
//   2. for a prior answer, can we PROVE what superseded it?
//
// It is deliberately pure and DB-free so the current-vs-history rule is unit
// testable without a browser or a database.
//
// AUTHORITY MODEL
// ===========================================================================
// Photo consent moved to the portal in #545, so:
//
//   * a consent type the intake STILL COLLECTS (`INTAKE_CONSENT_COLLECTED_
//     FORM_TYPES` — treatment consent) is intake-owned, and its stored intake
//     record IS the current answer;
//   * a consent type the intake NO LONGER COLLECTS (photo consent) is
//     portal-owned. The live portal form is the current answer and the stored
//     intake record is history — even when the intake record says "Accepted"
//     and the portal says "Consent denied".
//
// The partition keys off the existing COLLECTED constant rather than testing
// for "photo_consent" by name. That constant already means exactly "does the
// intake still own this?", so if another type ever moves to the portal the
// information architecture follows it automatically instead of silently
// leaving a second stale answer on screen.
import {
  isIntakeConsentCollectedFormType,
  type IntakeConsentFormView,
} from "./consent-forms";
import type { PortalPhotoConsentView } from "@/lib/consent/queries";

// How a prior intake answer relates to what the portal holds today. Every value
// is a claim we can defend from the records themselves.
export type HistoricalConsentProvenance =
  // Same template_id, and the portal answer is demonstrably the later of the
  // two. This is the only state that may say "superseded".
  | "superseded_by_portal"
  // Same template_id and a portal answer exists, but the intake record carries
  // no responded_at, so which came first is NOT provable. Weaker, honest claim.
  | "also_answered_in_portal"
  // No live portal form shares this template_id. The intake simply stopped
  // collecting this type. Nothing superseded it; nothing may say so.
  | "no_longer_collected";

export type HistoricalConsentEntry = {
  form: IntakeConsentFormView;
  provenance: HistoricalConsentProvenance;
};

export type ConsentReviewModel = {
  // Intake-owned consent that is still current (treatment consent).
  currentIntakeForms: IntakeConsentFormView[];
  // Portal-owned consent that is current. One entry per LIVE template — #545's
  // multi-form correction, preserved verbatim: two live photo forms are two
  // separate questions and are never collapsed into one status.
  currentPortalPhotos: PortalPhotoConsentView[];
  // Prior intake answers for types the intake no longer collects. Immutable,
  // never merged into the current block, never relabelled.
  history: HistoricalConsentEntry[];
};

// Is `portalIso` provably later than `intakeIso`?
//
// Returns false when either timestamp is missing or unparseable. "Cannot prove"
// must never render as "superseded" — that would be the same category of
// overclaim the whole fix exists to remove, just in the other direction.
function portalIsProvablyNewer(
  portalIso: string | null | undefined,
  intakeIso: string | null | undefined,
): boolean {
  if (!portalIso || !intakeIso) return false;
  const portal = Date.parse(portalIso);
  const intake = Date.parse(intakeIso);
  if (!Number.isFinite(portal) || !Number.isFinite(intake)) return false;
  return portal >= intake;
}

export function buildConsentReviewModel(args: {
  intakeForms: IntakeConsentFormView[];
  portalPhotos: PortalPhotoConsentView[];
}): ConsentReviewModel {
  const { intakeForms, portalPhotos } = args;

  const currentIntakeForms: IntakeConsentFormView[] = [];
  const history: HistoricalConsentEntry[] = [];

  for (const form of intakeForms) {
    if (isIntakeConsentCollectedFormType(form.formType)) {
      currentIntakeForms.push(form);
      continue;
    }

    // LINEAGE, PROVEN — not assumed.
    //
    // A consent template is versioned in place: `update consent_form_templates
    // set version = version + 1 where id = $id`. So template_id is the stable
    // identity of a logical consent question across all its versions, and
    // matching on it is a real provenance claim rather than a guess. A portal
    // form with a DIFFERENT template_id is a different question and cannot
    // supersede this answer, however recent it is.
    const sameTemplate = portalPhotos.find(
      (p) => p.templateId === form.templateId && p.record !== null,
    );

    let provenance: HistoricalConsentProvenance = "no_longer_collected";
    if (sameTemplate?.record) {
      provenance = portalIsProvablyNewer(
        sameTemplate.record.signed_at,
        form.respondedAtIso,
      )
        ? "superseded_by_portal"
        : "also_answered_in_portal";
    }

    history.push({ form, provenance });
  }

  return { currentIntakeForms, currentPortalPhotos: portalPhotos, history };
}
