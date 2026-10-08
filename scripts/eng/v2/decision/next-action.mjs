// ---------------------------------------------------------------------------
// ENG-LOOP V1 05B: the bounded next action. A closed table of fixed strings,
// one per decision and one per UNKNOWN reason: nothing GitHub says is ever
// copied into an instruction. None of them merges, and none tells anyone to.
// ---------------------------------------------------------------------------

import { UNKNOWN_REASONS } from "../contract/reasons.mjs";

export const NEXT_ACTION = Object.freeze({
  NOT_OPEN: "None: the pull request is not open.",
  DRAFT_HOLD: "None while it is a draft. When the author marks it ready for review, re-run the shepherd.",
  NEEDS_REFRESH:
    "Merge production into the head branch with a normal merge (no rebase, no force push), push, and re-run the shepherd after CI settles.",
  CI_FAILED: "Inspect the failed CI run, push a fix, and re-run the shepherd after CI settles.",
  CI_INCOMPLETE:
    "A required CI job did not succeed in an otherwise successful run. Inspect that job; re-run it if it was skipped or cancelled.",
  EXTERNAL_BLOCKED: "Inspect the failing external check and resolve it, then re-run the shepherd.",
  CI_NOT_STARTED: "No pull_request CI run exists at this head yet. Wait for it to start, then re-run the shepherd once.",
  CI_PENDING: "Wait for CI to settle, then re-run the shepherd once.",
  EXTERNAL_PENDING: "Wait for the external check to settle, then re-run the shepherd once.",
  REVIEW_MISSING: "Request a Codex review of this exact head, and re-run the shepherd after the review arrives.",
  FINDINGS_OPEN:
    "Address the open trusted review findings; the human resolver resolves each thread. Then request a review of the new head.",
  CANDIDATE_READY_FOR_HUMAN_REVIEW: "A human reviews and decides whether to merge. This is advisory, not merge permission.",
});

export const NEXT_ACTION_FOR_UNKNOWN = Object.freeze({
  read_failed: "Re-run once. If it repeats, check the read-only token and the permission the detail names.",
  malformed: "Do not act on this result. Report the detail: GitHub's answer was outside the contract.",
  pr_key_moved: "The pull request changed during collection. Re-run once it is quiet.",
  unstable_snapshot: "Evidence changed during collection. Re-run once CI and reviews have settled.",
  base_ref: "The pull request does not target production. Retarget it or close it.",
  base_ref_changed:
    "The base was changed, so no run binds to production. Open a new pull request from a new branch with a new head commit.",
  shared_head: "Another pull request shares this head branch or head commit. Use a new branch with a new head commit.",
  base_history_unverified:
    "Production's recorded history cannot prove a safe base. Its rules must block force pushes and deletion, and its recorded year must contain neither.",
  fork_head: "Fork heads are not evaluated in V1. A human evaluates this pull request directly.",
  diff_too_large: "The changed files exceed what one compare proves (300). Split the pull request, or a human evaluates it directly.",
  ci_definition_changed:
    "The pull request changes CI's own definition, so its own CI cannot certify it. A human reviews the CI change directly.",
  ci_definition_mismatch: "Run the shepherd from a checkout whose classifier and ci.yml are production's.",
  ci_candidate_listing_too_large: "Too many CI runs or jobs to prove complete in one response. A human checks CI directly.",
  review_evidence_too_large: "Review evidence exceeds one complete response. A human checks the reviews directly.",
  external_contexts_too_large: "Too many external checks to prove complete in one response. A human checks them directly.",
  unrecognized_ci_status: "GitHub reported a CI status outside the closed table. Do not act on this result; report it.",
  unrecognized_ci_conclusion: "GitHub reported a CI conclusion outside the closed table. Do not act on this result; report it.",
  unrecognized_context_state: "GitHub reported a check state outside the closed tables. Do not act on this result; report it.",
});

/** Every closed reason has exactly one action: a reason added without one fails here, at import. */
for (const r of UNKNOWN_REASONS) {
  if (typeof NEXT_ACTION_FOR_UNKNOWN[r] !== "string") throw new Error(`no next action for UNKNOWN reason ${r}`);
}

export function nextActionFor(decision, reasonCodes) {
  if (decision === "UNKNOWN") return NEXT_ACTION_FOR_UNKNOWN[reasonCodes[0]] ?? NEXT_ACTION_FOR_UNKNOWN.malformed;
  return NEXT_ACTION[decision];
}
