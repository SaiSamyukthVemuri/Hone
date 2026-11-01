import type { Studio } from "@/lib/types/database";
import type { NewClientReadiness } from "@/lib/booking/new-client-readiness";

// WS-D (settings redesign), decision D4: the launch checklist is shown as the owner-only "Setup" destination WHILE INCOMPLETE and is gone
// after completion. Completion is DERIVED, never stored: there is no persisted completion flag today (a flag would need a migration, which is
// held), and the underlying settings and any completion records are never touched by hiding the page.
//
// COMPLETE means every fact the checklist treats as a must-have is ready:
//   * the canonical booking-readiness authority answers `ready` (studio name, booking link, booking settings, consultation service,
//     availability, bookable window, WAIT admission and treatment consent all live inside it, so this file does not restate them);
//   * confirmation emails are on, the postcare aftercare text is set, and both policies are set (the facts the checklist page owns itself).
// The optional calendar-feed row never gates completion. An authority that could not answer (`unknown`, or `not_ready` with unavailable
// authorities) is NOT complete: an unreadable studio keeps its checklist, it is never hidden by a failed read.
// The checklist page uses `hasAftercare` and `hasBothPolicies` from here, so the page and this predicate cannot disagree.

type Text = string | null | undefined;
const nonEmpty = (s: Text): boolean => typeof s === "string" && s.trim().length > 0;

export type LaunchStudioFacts = Pick<
  Studio,
  "send_confirmation_emails" | "postcare_aftercare_text" | "cancellation_policy_text" | "no_show_policy_text"
>;

export const hasAftercare = (studio: Pick<LaunchStudioFacts, "postcare_aftercare_text">): boolean => nonEmpty(studio.postcare_aftercare_text);
export const hasBothPolicies = (studio: Pick<LaunchStudioFacts, "cancellation_policy_text" | "no_show_policy_text">): boolean =>
  nonEmpty(studio.cancellation_policy_text) && nonEmpty(studio.no_show_policy_text);

export function isLaunchComplete(readiness: NewClientReadiness, studio: LaunchStudioFacts): boolean {
  return (
    readiness.status === "ready" &&
    studio.send_confirmation_emails === true &&
    hasAftercare(studio) &&
    hasBothPolicies(studio)
  );
}

/** The one rule the nav, the page and search all use: owner-only, and only while setup is incomplete. */
export function launchDestinationVisible(role: string, complete: boolean): boolean {
  return role === "owner" && !complete;
}
