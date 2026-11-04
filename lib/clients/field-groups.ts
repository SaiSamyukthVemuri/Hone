// Which permission key governs each column of `clients` (R5, DN-5; Sam batch 1, 3 Nov). Prepared, not wired: nothing imports it yet,
// so it changes no behaviour. It exists so a NEW column cannot be added to `Client` without someone deciding its group
// (tests/lib/clients/field-groups.test.ts fails on an unmapped column), and so a column whose group Sam has not decided is visibly
// `undecided` instead of being quietly bundled into a neighbouring grant.
//
// Decided: safety = allergies + cautions; personal = date of birth, birthday, address; pronouns travel with display/contact identity and
// NEVER with legal-name access; clinical record = skin type, skin notes, treatment goals. Budget, personal notes, tags and appointment
// health notes keep their own groups and live OUTSIDE `clients`, so no `clients` column maps to them.

export type FieldGovernance =
  | { kind: "keyed"; group: string; read: string; write: string }
  | { kind: "undecided"; question: string }
  | { kind: "consent" } // consent and opt-out state: never changed through a permission
  | { kind: "owner_only" } // fixed owner-only, not delegable
  | { kind: "system" }; // stamped or derived by the database or by identity, never a staff-edited value

const contact = { kind: "keyed", group: "contact identity", read: "client.view_directory", write: "client.edit_contact" } as const;
const personal = { kind: "keyed", group: "personal", read: "client.view_dob_address", write: "client.edit_dob_address" } as const;
const safety = { kind: "keyed", group: "safety", read: "client.view_allergies_cautions", write: "client.edit_allergies_cautions" } as const;
const clinical = { kind: "keyed", group: "clinical record", read: "clin.view_records", write: "clin.edit_records" } as const;

export const CLIENT_FIELD_GOVERNANCE: Record<string, FieldGovernance> = {
  id: { kind: "system" },
  studio_id: { kind: "system" },
  created_at: { kind: "system" },
  created_by: { kind: "system" },
  normalized_email: { kind: "system" },
  sms_phone: { kind: "system" },

  name: { kind: "keyed", group: "legal name", read: "client.view_legal_name", write: "client.edit_legal_name" },
  preferred_name: contact,
  pronouns: contact,
  phone: contact,
  email: contact,

  date_of_birth: personal,
  address: personal,

  allergies: safety,

  fitzpatrick_type: clinical,
  skin_notes: clinical,

  // No group decided. Not defaulted: a wrong default either hides an emergency number from the people who need it or shows it to
  // roles that should not see it. Open question Q1 in willow/R5-DESIGN-20261104.md.
  emergency_contact_name: { kind: "undecided", question: "Q1" },
  emergency_contact_phone: { kind: "undecided", question: "Q1" },
  // Not written by the profile form and not read by the app outside the owner export; which group they belong to is undecided (Q1b).
  notes: { kind: "undecided", question: "Q1b" },
  contraindications: { kind: "undecided", question: "Q1b" },

  photo_consent: { kind: "consent" },
  sms_consent_at: { kind: "consent" },
  sms_consent_source: { kind: "consent" },
  sms_opted_out_at: { kind: "consent" },
  sms_opt_out_source: { kind: "consent" },

  archived_at: { kind: "owner_only" },
  archived_by: { kind: "owner_only" },
  portrait_image_id: { kind: "owner_only" },
};
