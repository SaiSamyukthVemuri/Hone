// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A, rows 4-5: normalize review evidence for K0.headSha
// (ARCH-01 §17-§21, §24). Pure.
//
// Two artifact channels:
//   A — a PR review object: `commit_id == K0.headSha` AND exactly one 10-hex
//       Reviewed-commit marker equal to the head's first 10 characters;
//   B — a PR issue comment whose body BEGINS with the clean verdict, with the
//       same single-marker rule. Channel B is a 10-hex V1 binding, not a
//       full-SHA binding (ARCH-01 §17 channel B, §41).
// 05A computes `qualifiesAtHead`; it does not decide trust. The actor's
// numeric id and type travel with every artifact, and 05B checks them against
// policy. Logins never enter the evidence.
// ---------------------------------------------------------------------------

import { fail, okValue } from "../../../contract/strict.mjs";

export const REVIEW_POLICY = Object.freeze({
  codex: Object.freeze({ id: 199175422, type: "Bot" }),
  humanResolvers: Object.freeze([Object.freeze({ id: 26781116, type: "User" })]),
  acceptedReviewStates: Object.freeze(["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]),
  cleanPrefix: "Codex Review: Didn't find any major issues.",
});

/** GitHub's PullRequestReviewState, closed. */
const REVIEW_STATES = ["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

const MARKER_ANY = /\*\*Reviewed commit:\*\*/g;
const MARKER_10 = /\*\*Reviewed commit:\*\* `([0-9a-f]{10})`/;

/** Exactly one marker, of exactly 10 lowercase hex, equal to the head's first 10. */
function markerQualifies(body, headSha) {
  if ((body.match(MARKER_ANY) ?? []).length !== 1) return false;
  const m = body.match(MARKER_10);
  return m !== null && m[1] === headSha.slice(0, 10);
}

export function bindReviews({ key, evidence, policy = REVIEW_POLICY }) {
  try {
    const reviews = [];
    for (const r of evidence.reviews) {
      if (!REVIEW_STATES.includes(r.state)) return fail("malformed", `review state ${r.state} is outside GitHub's set`);
      reviews.push({
        id: r.id,
        channel: "PR_REVIEW",
        actor: r.author,
        verdict: r.state,
        qualifiesAtHead: r.commitOid === key.headSha && markerQualifies(r.body, key.headSha),
      });
    }
    for (const c of evidence.comments) {
      if (!c.body.startsWith(policy.cleanPrefix)) continue;
      reviews.push({
        id: c.id,
        channel: "CLEAN_COMMENT",
        actor: c.author,
        verdict: "CLEAN",
        qualifiesAtHead: markerQualifies(c.body, key.headSha),
      });
    }
    const threads = evidence.threads.map((t) => ({
      opener: t.opener,
      resolved: t.isResolved,
      resolver: t.resolver,
      outdated: t.isOutdated,
    }));
    return okValue({ reviews, threads });
  } catch {
    return fail("malformed", "bindReviews received an input outside its contract");
  }
}
