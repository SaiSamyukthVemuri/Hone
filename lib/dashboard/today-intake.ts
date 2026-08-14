// Today's intake affordance. PURE: no I/O, no clock, no mutation.
//
// WHY THIS EXISTS
// ---------------
// Chloe works out of Today. Reviewing a client's intake before an appointment
// meant leaving that flow entirely:
//
//   Today -> client profile -> Health & Forms -> intake -> review
//
// The Today row already KNEW the intake status (it renders the "Intake
// awaiting review" pill) but stated it as inert text, so the fact was visible
// and the action was four navigations away. This module turns the status the
// dashboard has already loaded into the ONE navigation Chloe actually wants,
// and refuses to offer it when there is nothing reviewable.
//
// TWO RULES LIVE HERE, AND NOTHING ELSE:
//
//   1. WHICH intake is "the" intake for a client (selectCurrentIntakeByClient)
//   2. WHAT action that intake's status justifies (resolveTodayIntakeAction)
//
// Both are pure so they can be tested directly; the dashboard wiring is
// source-pinned by tests/lib/dashboard/today-intake.test.ts.

import type { IntakeStatus } from "@/lib/types/database";

// The canonical practitioner intake-review surface. This is the SAME route the
// client profile's Health & Forms tab deep-links to and the appointment
// briefing links to: app/(app)/clients/[id]/intake/page.tsx. It is
// session-authenticated and re-derives the studio from
// getCurrentPractitionerWithStudio(), so the client id in the path is a
// pointer, never a credential.
//
// It is deliberately NOT the public /intake/<token> questionnaire. That route
// is the CLIENT's bearer-token surface; a practitioner must never be routed
// onto it, and no token, token hash or magic link is involved in anything
// below.
export function practitionerIntakeReviewHref(clientId: string): string {
  return `/clients/${clientId}/intake`;
}

// One row of the dashboard's narrow intake projection. Deliberately the
// SMALLEST shape that can answer "which row, and what state", no `responses`,
// no medical answers, no acknowledgement or consent text. Those belong on the
// review page, which is where the practitioner has actually asked for them.
export type TodayIntakeRow = {
  client_id: string;
  status: IntakeStatus;
  created_at: string;
};

// The current intake per client, for MANY clients, in ONE pass.
//
// THE RULE IS NOT NEW. It is the in-memory equivalent of Hone's canonical
// single-client selection: lib/intake/queries.ts:
//
//     .is("deleted_at", null).order("created_at", { ascending: false }).limit(1)
//
// which is what getLatestIntakeForClient returns and what
// getIntakeHistoryForClient[0] resolves to; the practitioner review page
// (app/(app)/clients/[id]/intake/page.tsx) defaults to exactly that row.
//
// THE CASE THIS EXISTS FOR: a client with an older REVIEWED intake and a newer
// IN-PROGRESS reissue. The newer row is the current record, so Today must say
// "Intake in progress" and must NOT offer to review the stale one. Selecting
// by status precedence, or by "the newest reviewed row", would silently
// disagree with the page the link opens: the practitioner would click
// "Review intake" and land on a different record than the one Today described.
//
// Deleted rows are excluded by the CALLER's query (`deleted_at is null`),
// matching the canonical rule; this helper never sees them.
//
// Strictly-later `created_at` wins. An exact tie keeps the first row in input
// order: the canonical `.limit(1)` resolves a tie arbitrarily too, so this
// adds no guarantee the rest of Hone does not already make.
export function selectCurrentIntakeByClient(
  rows: ReadonlyArray<TodayIntakeRow>,
): Map<string, IntakeStatus> {
  const bestAt = new Map<string, string>();
  const out = new Map<string, IntakeStatus>();
  for (const row of rows) {
    const current = bestAt.get(row.client_id);
    if (current !== undefined && row.created_at <= current) continue;
    bestAt.set(row.client_id, row.created_at);
    out.set(row.client_id, row.status);
  }
  return out;
}

// The ONE action a given intake state justifies. `null` means "offer nothing":
// the row's existing intake pill already states the truth, and a button is
// only added when there is genuinely a completed intake to read.
export type TodayIntakeAction = {
  label: "Review intake";
  href: string;
};

// STATE MATRIX: the CTA must be truthful.
//
//   submitted   -> Review intake   (awaiting her review; this is the point)
//   reviewed    -> Review intake   (already reviewed; re-reading is normal
//                                   pre-appointment preparation)
//   in_progress -> null            (the client has not finished it. Calling
//                                   that "Review intake" would promise a
//                                   completed record that does not exist. The
//                                   row's pill says "Intake in progress".)
//   none        -> null            (nothing to review, and nothing is created
//                                   from Today: intake creation belongs to
//                                   Health & Forms' "Start intake with
//                                   client", PR #527. The pill says "No intake
//                                   on file".)
export function resolveTodayIntakeAction(input: {
  status: IntakeStatus | null;
  clientId: string;
}): TodayIntakeAction | null {
  if (input.status !== "submitted" && input.status !== "reviewed") return null;
  return {
    label: "Review intake",
    href: practitionerIntakeReviewHref(input.clientId),
  };
}
