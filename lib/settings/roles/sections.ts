import { CATALOG, type PermissionDef } from "@/lib/permissions/catalog";

// PRESENTATION ONLY. The Roles page shows Sam's eight plain-language sections. A section is a way to lay keys out, never a combined
// grant: every key keeps its own scope and its own consequence. Each catalog group belongs to exactly one section (a test pins that
// no key is dropped or doubled), and a group the catalog adds later lands in Studio operations until it is placed here on purpose.

export const SECTIONS = [
  { id: "appointments", label: "Appointments", groups: ["appointments"] },
  { id: "availability", label: "Availability", groups: ["availability"] },
  { id: "clients", label: "Clients", groups: ["clients_identity", "accepting_new_clients"] },
  { id: "clinical", label: "Clinical records", groups: ["clinical_records", "safety_records"] },
  { id: "payments", label: "Payments", groups: ["payments"] },
  { id: "pricing_reports", label: "Pricing and reports", groups: ["pricing", "reports"] },
  { id: "communications", label: "Communications", groups: ["communications"] },
  { id: "operations", label: "Studio operations", groups: ["waitlist_operations", "waitlist_rules"] },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

const FALLBACK: SectionId = "operations";

export function sectionOfGroup(group: string): SectionId {
  return SECTIONS.find((s) => (s.groups as readonly string[]).includes(group))?.id ?? FALLBACK;
}

export const sectionOfKey = (def: PermissionDef): SectionId => sectionOfGroup(def.group);

export function sectionKeys(): Record<SectionId, string[]> {
  const out = Object.fromEntries(SECTIONS.map((s) => [s.id, [] as string[]])) as Record<SectionId, string[]>;
  for (const d of CATALOG as readonly PermissionDef[]) out[sectionOfKey(d)].push(d.key);
  return out;
}

// Consequence label for a key (specific, not a blanket "dangerous"). Destructive is reserved for protected deletion, archive and
// restore, which are fixed owner-only items with no key, so no catalog key carries it.
export type Consequence = "financial" | "sensitive" | null;
export function consequenceOf(def: PermissionDef): Consequence {
  if (!def.sensitive) return null;
  return def.group === "payments" || def.group === "pricing" ? "financial" : "sensitive";
}
export const CONSEQUENCE_LABEL: Record<Exclude<Consequence, null>, string> = {
  financial: "Financial: can move or change money",
  sensitive: "Sensitive: can reach private client, clinical or identity information, or export it",
};

// "Show common actions first; collapse finer controls under Advanced" (handoff). Common = the routine, headline capabilities of each
// section; everything finer (read/write splits, fixed baselines, held or gated rows) sits under that section's Advanced, collapsed by
// default. A key that is not listed here is Advanced. Presentation only: it never changes what a key means or its default.
export const COMMON_KEYS: ReadonlySet<string> = new Set([
  // appointments
  "appt.book", "appt.move", "appt.cancel", "appt.mark_no_show", "appt.complete", "appt.aftercare_send",
  // clients
  "client.create", "client.edit_contact", "client.view_legal_name", "client.edit_legal_name", "admit.change_policy",
  // availability
  "avail.manage_own", "avail.manage_others", "avail.manage_studio_hours",
  // clinical
  "clin.view_records", "clin.edit_records", "clin.view_photos", "clin.upload_photos", "clin.view_intake", "clin.view_aftercare",
  // communications
  "comm.send_routine", "comm.bulk_message",
  // payments
  "pay.view_appointment", "pay.record_external", "pay.charge_saved_card", "pay.refund",
  // pricing and reports
  "price.appointment", "price.service_list", "price.fee_amounts", "rep.studio_totals", "rep.financial_reports",
  // operations (waitlist)
  "wl.view_queue", "wl.add_entry", "wl.manage_queue", "wl.offer_booking",
]);
