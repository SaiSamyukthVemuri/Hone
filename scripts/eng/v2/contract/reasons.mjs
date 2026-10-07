// ---------------------------------------------------------------------------
// ENG-LOOP V1: the closed set of UNKNOWN reasons.
//
// Every UNKNOWN names exactly one of these. A reason outside the set is a
// defect, and the collector fails closed to `read_failed` rather than pass an
// open-set string downstream.
//
// PRECEDENCE (V1 rule; resolves #800 P2 4211046602 in the implementation, not in
// ARCH-01's prose): a specialized typed reader or binder keeps the reason it
// specifies; the generic `read_failed` and `malformed` apply only where no
// specialized reader owns the failure. See scripts/eng/v2/README.md.
// ---------------------------------------------------------------------------

export const UNKNOWN_REASONS = Object.freeze([
  // generic: only where no specialized reader owns the failure
  "read_failed",
  "malformed",
  // pass coherence (PR-SNAPSHOT-01) and the confirming re-read (ARCH-01 §15)
  "pr_key_moved",
  "unstable_snapshot",
  // the V1 CI evidence profile (README: "V1 rules that differ")
  "base_ref",
  "base_ref_changed",
  "shared_head",
  "base_history_unverified",
  // single-response completeness (CAP-01 §4, §15, §17)
  "ci_candidate_listing_too_large",
  "review_evidence_too_large",
  "external_contexts_too_large",
  // closed value tables
  "unrecognized_ci_status",
  "unrecognized_ci_conclusion",
  "unrecognized_context_state",
]);

const SET = new Set(UNKNOWN_REASONS);

/** Is `reason` one of the closed UNKNOWN reasons? */
export function isUnknownReason(reason) {
  return typeof reason === "string" && SET.has(reason);
}
