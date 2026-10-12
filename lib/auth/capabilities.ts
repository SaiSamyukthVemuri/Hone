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
  | "schedule_book_move"
  | "schedule_cancel"
  | "client_contacts"
  | "intake_status"
  | "clinical_records"
  | "clinical_images"
  | "treatment_recording"
  | "payments"
  | "refunds"
  | "exports"
  | "team"
  | "studio_settings"
  | "treating_capacity";

// "own": only appointments they treat. "any": anyone's in the studio.
export type Access = "yes" | "own" | "any" | "no" | "not_yet";

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  schedule_view: "See the schedule",
  schedule_book_move: "Book and move appointments",
  schedule_cancel: "Cancel appointments",
  client_contacts: "See client contact details",
  intake_status: "See whether intake and consent are complete",
  clinical_records: "Read treatment records, notes, health answers and signed forms",
  clinical_images: "See clinical images",
  treatment_recording: "Record and edit treatments",
  payments: "Charge cards and send receipts",
  refunds: "Issue refunds",
  exports: "Export the studio's data",
  team: "Invite and remove people",
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
    schedule_book_move: "yes",
    schedule_cancel: "yes",
    client_contacts: "yes",
    intake_status: "yes",
    clinical_records: "yes",
    clinical_images: "yes",
    treatment_recording: "yes",
    payments: "yes",
    refunds: "yes",
    exports: "yes",
    team: "yes",
    studio_settings: "yes",
    treating_capacity: "yes",
  },
  practitioner: {
    schedule_view: "yes",
    // Book and move only appointments they treat: practitioner_move_appointment
    // refuses a non-owner who is not the treating practitioner, or who
    // reassigns (0145). Cancellation is NOT scoped that way today:
    // practitioner_cancel_appointment checks only an active practitioner of the
    // studio, so it is stated as "any" (F6; Codex P2 4243990812 on #852).
    schedule_book_move: "own",
    schedule_cancel: "any",
    client_contacts: "yes",
    intake_status: "yes",
    clinical_records: "yes",
    clinical_images: "yes",
    treatment_recording: "yes",
    // Any active practitioner can charge and send receipts; refunds are
    // owner-only (payment-actions.ts, manual-fee-actions.ts).
    payments: "yes",
    refunds: "no",
    exports: "no",
    team: "no",
    studio_settings: "no",
    treating_capacity: "yes",
  },
  receptionist: {
    schedule_view: "yes",
    // STUDIO-READY-02c (0220): book, move/reassign and cancel for ANY active
    // owner or practitioner, through the receptionist commands over the shared
    // core. Never an override, never as a treating practitioner.
    schedule_book_move: "any",
    schedule_cancel: "any",
    client_contacts: "yes",
    intake_status: "yes",
    clinical_records: "no",
    clinical_images: "no",
    treatment_recording: "no",
    payments: "no",
    refunds: "no",
    exports: "no",
    team: "no",
    studio_settings: "no",
    treating_capacity: "no",
  },
};

const ACCESS_SUFFIX: Record<Access, string> = {
  yes: "",
  own: " (their own)",
  any: " (anyone's in the studio)",
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
    (a === "yes" || a === "own" || a === "any" ? can : cannot).push(label);
  }
  return { can, cannot };
}

/**
 * A DEACTIVATED person has no access at all: every guard reads active rows
 * only (requireReceptionistWithStudio, receptionist_actor_id), so their summary
 * is a single denial, never the role's list (Codex P2 4243990807 on #852).
 */
export const DEACTIVATED_SUMMARY = "Deactivated: no access to this studio until reactivated.";
