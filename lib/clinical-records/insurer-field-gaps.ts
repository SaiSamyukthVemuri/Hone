// HON-46: insurer-facing fields Hone does not record yet, disclosed as missing.
//
// WHY THIS EXISTS
// ===========================================================================
// An insurer-facing clinical packet is commonly expected to carry a legal
// identity, a medical record number (MRN), diagnosis or problem codes, and the
// insurer's member or policy identifier. Hone records none of the last three
// today. The `clients` row has one free-text `name` and nothing else that
// identifies a person to a payer (see `Client` in lib/types/database.ts).
//
// The legal name is the exception: the intake form asks for it
// (`legal_name` in lib/intake/questions.ts) and keeps the answer in
// `client_intake_forms.responses`. It is not on the client profile, and this
// packet does not read intake answers, so that gap is scoped to the profile
// and the packet. It must never claim that Hone holds no legal name.
//
// HON-46 requires the packet to flag missing information "rather than
// fabricate" it. This module is the single statement of what is missing and
// why, so every insurer-facing surface prints the same disclosure. It is pure
// and DB-free. It reads no clinical data and makes no authorization decision.
//
// WHAT IT DELIBERATELY DOES NOT DECIDE
// ===========================================================================
// - Legal vs preferred name is HON-58's open design. The one stored name is
//   labelled "Name on record". It is never presented as a legal name or as a
//   preferred name, because nothing records which one it is.
// - MRN, diagnosis and insurance-case capture belong to HON-60. The MRN is
//   distinct from the insurer member/policy identifier, so they are two
//   separate gaps here and must never be merged into one field.
// - No value is inferred: not from an insurer response, a booking, a note, or
//   the stored name.
//
// KEEPING IT TRUE
// ===========================================================================
// tests/lib/clinical-records/insurer-field-gaps.test.ts reads the `Client`
// type and fails if a column for any of these fields appears. When HON-58 or
// HON-60 adds one, that test goes red, and this disclosure must be revisited
// instead of silently claiming the field is not recorded.

export type InsurerFieldGapKey =
  | "legal_identity"
  | "medical_record_number"
  | "diagnosis"
  | "insurer_member_policy";

export type InsurerFieldGap = {
  key: InsurerFieldGapKey;
  label: string;
  // Plain-language reason printed beside the label. States what Hone holds,
  // never a guess at the value.
  reason: string;
};

// The label for `clients.name` on an insurer-facing document. It does not
// claim to be a legal or a preferred name (HON-58).
export const NAME_ON_RECORD_LABEL = "Name on record";

export const INSURER_FIELD_GAPS: readonly InsurerFieldGap[] = [
  {
    key: "legal_identity",
    label: "Legal name",
    reason:
      "Not on the client profile, which stores one name and does not record whether it is the legal name. A legal name given on an intake form is not included in this packet.",
  },
  {
    key: "medical_record_number",
    label: "Medical record number (MRN)",
    reason: "Not recorded in Hone.",
  },
  {
    key: "diagnosis",
    label: "Diagnosis or problem codes",
    reason: "Not recorded in Hone. Hone does not infer a diagnosis from treatment records.",
  },
  {
    key: "insurer_member_policy",
    label: "Insurer member or policy number",
    reason: "Not recorded in Hone. This is separate from a medical record number.",
  },
];

export type InsurerPacketIdentity = {
  nameLabel: typeof NAME_ON_RECORD_LABEL;
  name: string;
  gaps: readonly InsurerFieldGap[];
};

// The identity block for an insurer-facing packet: the stored name under a
// neutral label, plus every field that must be shown as missing. Takes only
// the name, so no other client column can leak into the block through it.
export function insurerPacketIdentity(client: { name: string }): InsurerPacketIdentity {
  return {
    nameLabel: NAME_ON_RECORD_LABEL,
    name: client.name,
    gaps: INSURER_FIELD_GAPS,
  };
}
