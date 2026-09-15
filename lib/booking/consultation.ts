import type { Service } from "@/lib/types/database";

// Plain server-safe predicate for "is this service a consultation?".
// Both the public booking UI (PublicBookForm) and the server action
// (publicBookAppointmentAction) call this helper so the visible
// service filter and the server-side guard cannot drift apart.
//
// Source of truth: services.modality (migration 0021). The column
// accepts any string and the canonical value is the lowercase
// "consultation" used in KNOWN_MODALITIES. A small name-based
// fallback covers studios that didn't set the modality field but did
// name their service like "New Client Consultation"; lib/booking/
// format.ts already uses the same fallback when grouping services in
// the modality bucket, so a service the UI groups under
// "Consultation" is also recognised as bookable by new clients.
//
// What this does NOT do: it does not look at price, duration, or any
// per-studio override. Studios that want explicit control of which
// services are bookable as "first appointments" should set the
// modality field. The name fallback is intentionally conservative
// (case-insensitive substring match) so a studio service named
// "Underarm Consultation Follow-up" is still classified as a
// consultation; the public UI listing surfaces every consultation
// service and the practitioner can curate names accordingly.
export function isConsultationService(
  service: Pick<Service, "modality" | "name">,
): boolean {
  const modality = service.modality?.trim().toLowerCase() ?? "";
  if (modality === "consultation") return true;
  // Fall back to the same heuristic lib/booking/format.ts uses when a
  // studio has not set the modality field. The grouping helper there
  // already routes such services into the consultation bucket; this
  // keeps the predicate in sync.
  if (modality.length === 0 && service.name.toLowerCase().includes("consultation")) {
    return true;
  }
  return false;
}

/**
 * May a NEW client book this service at all?
 *
 * THE WHOLE new-client service rule, in one place, over a loaded row.
 *
 * `publicBookAppointmentAction` states this rule in two parts that sit far
 * apart: the service read filters `studio_id` and `active`, and the guard
 * below it calls `isConsultationService`. Read as source that looks like one
 * rule; read as BEHAVIOUR it is "active, this studio's, and a consultation",
 * and anything offering a service to a new client has to satisfy all three.
 *
 * WAIT-03 B3 needed exactly that question and could not ask it. The recipient
 * route resolved an invitation's `scope_service_id`, read the service for its
 * NAME, and rendered selectable times — for a service the booking path might
 * refuse. An invitation scoped to an ordinary treatment (or to a service since
 * deactivated) presented a working-looking offer that could never commit.
 *
 * Restating the rule there would have created a second definition of
 * "consultation" to drift against the first, which is the failure
 * `isConsultationService` was extracted to prevent in the first place. So the
 * rule moves here and BOTH callers ask this function.
 *
 * TENANCY IS NOT ASKED HERE, deliberately. `studio_id` is a query filter at
 * both call sites and belongs there: a row fetched without it is already the
 * wrong row, and a predicate that took a studio id would invite someone to
 * fetch first and check after.
 */
export function isBookableByNewClient(
  service: Pick<Service, "modality" | "name" | "active"> | null | undefined,
): boolean {
  if (!service) return false;
  // Strict `!== true`. The invitation route reads this column from a row it
  // selects by id, so an absent or null value must fail closed rather than
  // being coerced into "probably fine".
  if (service.active !== true) return false;
  return isConsultationService(service);
}

// ===========================================================================
/*
 * CONTRACT FOR #683 — THE PRACTITIONER INVITE-TO-BOOK ADAPTER.
 *
 * Recorded here, on the predicate itself, because the adapter's service
 * selector is the surface that has to honour it.
 *
 * THE RULE: the practitioner's service selector must offer ONLY services this
 * function accepts — the studio's own, active, and a consultation. An
 * invitation is scoped at issue time, and everything downstream trusts that
 * scope; a selector that can name an ineligible service issues an invitation
 * that cannot be redeemed, and the recipient discovers it, not the operator.
 *
 * WHY IT IS A SELECTOR RULE AND NOT A VALIDATION RULE. #686 fails such an
 * invitation CLOSED at the recipient route, which is correct and is not a
 * repair: the offer is already sent, the recipient already has the link, and
 * the only remaining move is to tell them to phone the studio. The place to
 * stop it is the list the operator picks from.
 *
 * DO NOT reimplement the test. Ask this function, over the row you are about
 * to offer, with `active` read from the database rather than assumed.
 */
