// STUDIO-READY-02e (#824): the FIXED studio role definitions, and the readable
// per-person access summary rendered from them.
//
// An owner chooses a person's role, never individual capabilities. This module
// is the one place a role's capabilities are written down. The team page
// renders each person's summary from it, and its test pins it to contract
// §2.2 (#830).
//
// It describes behaviour; it does not grant anything. The database grants
// (RLS, definer commands, the 0216 projections) and the server guards decide
// what a person can actually do. This text must state only what those already
// do. Anything not yet built is stated as not available, never promised.

export type StudioRole = "owner" | "practitioner" | "receptionist";

export type CapabilityKey =
  | "schedule_view"
  | "schedule_edit"
  | "client_contacts"
  | "intake_status"
  | "clinical_records"
  | "clinical_images"
  | "treatment_recording"
  | "payments"
  | "refunds_finance"
  | "exports"
  | "team"
  | "studio_settings"
  | "treating_capacity";

export type Access = "yes" | "own" | "no" | "not_yet";

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  schedule_view: "See the schedule",
  schedule_edit: "Book, move and cancel appointments",
  client_contacts: "See client contact details",
  intake_status: "See whether intake and consent are complete",
  clinical_records: "Read treatment records, notes, health answers and signed forms",
  clinical_images: "See clinical images",
  treatment_recording: "Record treatments and sign records",
  payments: "Charge cards and send receipts",
  refunds_finance: "Issue refunds and see financial reports",
  exports: "Export the studio's data",
  team: "Invite people, change roles and deactivate",
  studio_settings: "Change studio, booking, provider and billing settings",
  treating_capacity: "Be booked as a treating practitioner",
};

export const ROLE_LABELS: Record<StudioRole, string> = {
  owner: "Owner",
  practitioner: "Practitioner",
  receptionist: "Receptionist",
};

/** Fixed. One entry per role, every capability stated. */
export const ROLE_CAPABILITIES: Record<StudioRole, Record<CapabilityKey, Access>> = {
  owner: {
    schedule_view: "yes",
    schedule_edit: "yes",
    client_contacts: "yes",
    intake_status: "yes",
    clinical_records: "yes",
    clinical_images: "yes",
    treatment_recording: "yes",
    payments: "yes",
    refunds_finance: "yes",
    exports: "yes",
    team: "yes",
    studio_settings: "yes",
    treating_capacity: "yes",
  },
  practitioner: {
    schedule_view: "yes",
    // Create and move their own bookings; cancel follows today's rule (F6).
    schedule_edit: "own",
    client_contacts: "yes",
    intake_status: "yes",
    clinical_records: "yes",
    clinical_images: "yes",
    treatment_recording: "yes",
    // Any active practitioner can charge and send receipts; refunds and
    // financial reports are owner-only (payment-actions.ts, manual-fee-actions.ts).
    payments: "yes",
    refunds_finance: "no",
    exports: "no",
    team: "no",
    studio_settings: "no",
    treating_capacity: "yes",
  },
  receptionist: {
    schedule_view: "yes",
    // Receptionist booking over the shared scheduling core is a later slice (S4).
    schedule_edit: "not_yet",
    client_contacts: "yes",
    intake_status: "yes",
    clinical_records: "no",
    clinical_images: "no",
    treatment_recording: "no",
    payments: "no",
    refunds_finance: "no",
    exports: "no",
    team: "no",
    studio_settings: "no",
    treating_capacity: "no",
  },
};

const ACCESS_SUFFIX: Record<Access, string> = {
  yes: "",
  own: " (their own)",
  no: "",
  not_yet: " (not available yet)",
};

/** The readable summary for one role: what they can do, and what they cannot. */
export function accessSummary(role: StudioRole): { can: string[]; cannot: string[] } {
  const can: string[] = [];
  const cannot: string[] = [];
  for (const key of Object.keys(CAPABILITY_LABELS) as CapabilityKey[]) {
    const a = ROLE_CAPABILITIES[role][key];
    const label = CAPABILITY_LABELS[key] + ACCESS_SUFFIX[a];
    (a === "yes" || a === "own" ? can : cannot).push(label);
  }
  return { can, cannot };
}
