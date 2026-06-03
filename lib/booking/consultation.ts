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
