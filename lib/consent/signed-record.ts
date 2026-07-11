// Pure, client-safe helpers for the practitioner "View signed form" record and
// the photo-consent summary. No server-only, no DB — unit-tested without a DOM.
// P1-A (signed-consent visibility).

import type { ConsentRowState } from "./signature-status";

// The photo-consent choices Hone stores per signature (0060). Anything else is
// treated as malformed → "needs review", never silently shown as consented.
export type PhotoConsentResponse = "accepted" | "denied";

// The immutable fields of a signed record the practitioner may review.
export type SignedConsentRecordLike = {
  template_title_snapshot: string;
  template_body_snapshot: string;
  template_version: number;
  template_hash: string | null;
  signature_name: string;
  signed_at: string;
  response: string | null;
  response_label_snapshot: string | null;
};

// A signed record is REVIEWABLE-BUT-INCOMPLETE (show a warning, never pretend
// it is valid) when the agreed content or the affirmation is missing/malformed:
//   * the exact form copy the client agreed to is blank, or
//   * the typed signature (the affirmation) is blank, or
//   * a photo-consent form's response is not one of the known choices.
export type SignedRecordReview = { ok: true } | { ok: false; warning: string };

export function reviewSignedRecord(
  record: SignedConsentRecordLike,
  formType: string,
): SignedRecordReview {
  if (!record.template_body_snapshot || record.template_body_snapshot.trim().length === 0) {
    return { ok: false, warning: "This signed record is missing its form text and needs review." };
  }
  if (!record.signature_name || record.signature_name.trim().length === 0) {
    return { ok: false, warning: "This signed record is missing the client's signature and needs review." };
  }
  if (formType === "photo_consent") {
    if (record.response !== "accepted" && record.response !== "denied") {
      return {
        ok: false,
        warning: "This photo-consent response is unavailable or unrecognized and needs review.",
      };
    }
  }
  return { ok: true };
}

// The at-a-glance photo-consent summary shown near the image workflow. Maps the
// centralized consent state to the four required, immediately-understandable
// outcomes — a DENIED response is a valid, answered choice (not "missing").
export type PhotoConsentSummary = {
  label: "Photo use consented" | "Photo use not consented" | "Photo consent not completed" | "Consent response unavailable — needs review";
  tone: "ok" | "warn" | "neutral";
};

export function photoConsentSummary(
  state: ConsentRowState | null,
): PhotoConsentSummary {
  switch (state) {
    case "granted":
      return { label: "Photo use consented", tone: "ok" };
    case "denied":
      return { label: "Photo use not consented", tone: "warn" };
    case "not_answered":
    case "not_signed":
      return { label: "Photo consent not completed", tone: "neutral" };
    // "outdated" (re-sign needed) or any unexpected/absent state is treated as
    // unverifiable — surface a review prompt rather than an implied grant.
    default:
      return { label: "Consent response unavailable — needs review", tone: "warn" };
  }
}
