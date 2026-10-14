// ===========================================================================
// PUBLIC NEW-CLIENT SURFACES — CLIENT-SAFE ON PURPOSE
// ===========================================================================
//
// These two functions decide WHAT A VISITOR IS SHOWN. They are pure: a mode, a
// service count, a readiness boolean in; a surface name out. No database, no
// env, no request.
//
// THEY LIVE HERE RATHER THAN IN new-client-admission.ts BECAUSE THAT MODULE IS
// `server-only`, AND ONE OF THESE CALLERS IS A CLIENT COMPONENT.
// `app/book/[slug]/PublicBookForm.tsx` is "use client"; importing the server-only
// module from it fails the Next build with
//
//   You're importing a component that needs "server-only"
//
// and neither `tsc` nor the unit lane can see that - the vitest config aliases
// `server-only` to a stub so server modules stay testable, and TypeScript does
// not police the server/client boundary at all. Only `next build` does, which is
// why this surfaced in CI and not locally.
//
// new-client-admission.ts RE-EXPORTS both, so every server-side caller and every
// existing test import keeps working unchanged.
//
// PRESENTATION ONLY. Every mode is re-derived server-side by the booking and
// waitlist actions on submit, so nothing here grants or withholds authority, and
// nothing here may read admission PROVENANCE: a visitor must not be able to tell
// a bridged waitlist from a persisted one.
// ===========================================================================

import type { NewClientAdmissionMode } from "@/lib/booking/new-client-admission";

/**
 * WHAT A NEW CLIENT IS SHOWN on the public booking page, given the studio's
 * admission mode and whether the studio is structurally bookable (it has an
 * active service AND an open availability day).
 *
 * THE ORDERING IS THE POINT. Structural readiness used to gate the whole
 * region, so a CLOSED or UNREADABLE studio that also had no service and no open
 * day showed the generic setup copy and its real admission state vanished.
 * Readiness is the right answer for exactly one mode:
 *
 *   OPEN      the surface IS the booking form, so readiness decides it.
 *   WAITLIST  a waitlist exists FOR a studio that cannot offer slots. Gating it
 *             on bookability inverts its purpose, so it always shows.
 *   CLOSED    an intentional studio state. It is true whether or not the
 *             calendar happens to be set up, and saying "still being set up"
 *             instead would be false.
 *   UNKNOWN   a real state, not an absence. The honest answer is that we cannot
 *             tell right now; collapsing it into either READY or a setup notice
 *             asserts something unproven in both directions.
 *
 * PRESENTATION ONLY. Every mode is re-derived server-side by the booking and
 * waitlist actions on submit, so nothing here grants or withholds authority.
 * EXISTING-client rights are outside this function entirely.
 */
export type PublicNewClientSurface =
  | "booking_form"
  | "waitlist_journey"
  | "closed_notice"
  | "unknown_notice"
  | "setup_notice";

export function publicNewClientSurface(input: {
  mode: NewClientAdmissionMode | "unknown";
  structurallyBookable: boolean;
}): PublicNewClientSurface {
  switch (input.mode) {
    case "closed":
      return "closed_notice";
    case "unknown":
      return "unknown_notice";
    case "waitlist":
      return "waitlist_journey";
    case "open":
      return input.structurallyBookable ? "booking_form" : "setup_notice";
  }
}

/**
 * WHAT THE PUBLIC BOOKING FORM RENDERS, once a visitor has (or has not) said
 * whether they are new or existing.
 *
 * WHY THIS IS A FUNCTION AND NOT A CHAIN OF BOOLEANS. The component used to ask
 * `services.length === 0` at the very top — ahead of the new/existing chooser
 * and ahead of every admission branch — and returned the generic setup copy. So
 * the page correctly resolved WAITLIST / CLOSED / UNKNOWN, correctly chose the
 * admission-aware component, and the component discarded it. No single
 * condition was wrong; the ORDER was, which is invisible per-branch and obvious
 * once the whole decision is in one place.
 *
 * SERVICE COUNT IS A FACT ABOUT BOOKING, so it is asked only where booking is
 * what the visitor is being offered: OPEN for a new client, and the existing
 * client path. It is never asked before a client type exists, because the
 * chooser is how an existing client reaches their own route and returning an
 * admission surface ahead of it would strand them.
 *
 * ADMISSION NEVER GOVERNS AN EXISTING CLIENT. `newClientAdmission` is not read
 * on that branch at all, so no later edit can quietly make it matter there.
 *
 * OUT OF SCOPE, deliberately: the post-submit `done` state and the
 * consultation-only sub-case of a booking form. Both are orthogonal to this
 * ordering and stay where they are.
 */
export type PublicBookFormSurface =
  | "chooser"
  | "existing_no_services"
  | "existing_unavailable"
  | "existing_portal"
  | "closed_notice"
  | "unknown_notice"
  | "waitlist_journey"
  | "no_services_notice"
  | "booking_form";

export function publicBookFormSurface(input: {
  clientType: "new" | "existing" | null;
  newClientAdmission: NewClientAdmissionMode | "unknown";
  servicesCount: number;
  structurallyBookable: boolean;
}): PublicBookFormSurface {
  // Before a choice exists there is exactly one honest thing to show, and it is
  // the choice itself.
  if (input.clientType == null) return "chooser";

  if (input.clientType === "existing") {
    if (input.servicesCount === 0) return "existing_no_services";
    if (!input.structurallyBookable) return "existing_unavailable";
    return "existing_portal";
  }

  // NEW CLIENT. The three non-OPEN modes own their surface whatever the service
  // count is; only OPEN's surface is the booking form, so only OPEN has to care
  // whether there is anything to book.
  switch (input.newClientAdmission) {
    case "closed":
      return "closed_notice";
    case "unknown":
      return "unknown_notice";
    case "waitlist":
      return "waitlist_journey";
    case "open":
      return input.servicesCount === 0 ? "no_services_notice" : "booking_form";
  }
}
