// How the practitioner review surface should present ONE questionnaire answer.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The review grid iterates the CURRENT question catalogue (INTAKE_STEPS) and
// looks up each key in the stored responses. That is the right shape. It keeps
// labels and option wording in one place, but it means the grid asks a
// question of every record, including records written before that question
// existed. Until now it answered with a single string, "Not answered", for four
// genuinely different situations:
//
//   * the client answered it                        → show the answer
//   * the client was never SHOWN it, because its
//     parent condition does not apply to them       → not applicable
//   * the record predates the question entirely     → never collected
//   * the client can still answer it (in progress)  → not answered yet
//
// Collapsing those is not a cosmetic problem on a clinical surface. "Not
// answered" against a question the client was never asked attributes an
// omission to them, and (the case this module was written for) a stale child
// answer left behind when its parent was unselected would be rendered as if it
// were still the client's answer. A practitioner reading "Which type of
// diabetes? Type 1" has no way to see that this client unchecked diabetes.
//
// The electrolysis acknowledgement card already refuses to borrow the grid's
// "Not answered" for exactly this reason (see the comment above
// ElectrolysisAcknowledgementSummary). This module generalises that care to the
// grid itself.
//
// WHAT MAKES "never collected" TRUTHFUL RATHER THAN A GUESS
// --------------------------------------------------------
// Hone stores no questionnaire version or question snapshot on an intake row,
// there is no field that records which form a client answered. So we cannot
// read the answer off the record. What we CAN do is reason from an invariant
// the system enforces:
//
//   submitIntakeAction refuses to submit while any required, applicable
//   question is unanswered, and a submitted/reviewed intake is terminal and
//   never re-validated or rewritten.
//
// Therefore a TERMINAL record that is missing a REQUIRED, APPLICABLE answer
// cannot be a client who skipped it: the submit gate would have refused. It
// can only be a record completed under an earlier version of the form. That is
// a fact about our own gate, not an inference about the client, and it is the
// narrowest truthful claim available without a version snapshot.
//
// Nothing here invents a value, backfills, or mutates a stored response. It is
// a pure read-time projection.

import { isConditionalSatisfied, type Question } from "@/lib/intake/questions";
import type { IntakeLifecycleStatus } from "@/lib/intake/acknowledgements";

export type ReviewAnswerState =
  // Show the stored answer.
  | "answered"
  // The question's parent condition is not satisfied by this record, so the
  // client was never shown it. Any value still stored under this key is stale
  // and is NOT the client's answer: callers must not render it.
  | "not_applicable"
  // Applicable and required, but absent from a terminal record: this intake
  // predates the question. Never collected: do not imply the client declined.
  | "not_collected"
  // Applicable and absent, and the record can still change (or the question is
  // optional and was skipped).
  | "unanswered";

// Copy for the three non-answer states. Kept here so every surface says the
// same thing and no one re-phrases "never collected" into something that reads
// like a client refusal.
export const REVIEW_ANSWER_COPY: Record<
  Exclude<ReviewAnswerState, "answered">,
  string
> = {
  not_applicable: "Not applicable",
  not_collected: "Not collected on this intake",
  unanswered: "Not answered",
};

// Is there a stored answer at all?
//
// Deliberately NOT isAnswerProvided: that function answers "does this satisfy
// the required rule?", which is a different question. A checkbox storing
// `false` fails that test but IS an answer (the client left it unticked) and
// the grid has always rendered it as "Not confirmed". Treating it as missing
// here would relabel a real answer as never collected.
function hasStoredAnswer(q: Question, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (q.type === "multi_select") {
    return Array.isArray(value) && value.length > 0;
  }
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function reviewAnswerState(
  q: Question,
  responses: Record<string, unknown>,
  status: IntakeLifecycleStatus,
): ReviewAnswerState {
  // Applicability first, and it is decided by the SAME predicate the wizard
  // uses to decide what to show the client. A question the client never saw
  // cannot have an answer worth rendering, and this is the branch that makes a
  // stale child value non-authoritative at read time.
  if (!isConditionalSatisfied(responses, q.conditional)) return "not_applicable";

  if (hasStoredAnswer(q, responses[q.key])) return "answered";

  const terminal = status === "submitted" || status === "reviewed";
  if (terminal && q.required) return "not_collected";

  return "unanswered";
}
