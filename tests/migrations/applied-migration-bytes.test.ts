import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// An applied migration is frozen (CLAUDE.md §5). These are the reviewed
// byte-for-byte SHA-256 pins that used to live in the per-migration text tests;
// they moved here verbatim when those tests were removed, so each file keeps
// its freeze guard. `supabase/schema-snapshot.json` is NOT that guard: it is
// regenerated whenever a migration is edited.
//
// A pin goes red on ANY edit to the file. Never update a pin to make it pass:
// write a new migration instead.
const PINS: Record<string, string> = {
  "0049_sms_foundation.sql":
    "c329011512969d83b48315db9acad2223127b50cf0ec77d26b6f77b25af74da3",
  "0087_clinical_rls_delete_hardening.sql":
    "9c93834e92db5529529f18a53b1058e290c797ec28324326fc3de4cb08a6f795",
  "0126_client_clinical_notes.sql":
    "6cd91229e65f8d1e71cf40a9ca644bf483b61eedc44acba29ff6c3b6ad0c74ec",
  "0129_atomic_session_block_area_writes.sql":
    "5ae4a4ea6037f49ed8f6bedb0291e950f1f94f9f99e9482b5077687b3f0c2334",
  "0164_clean_entry_create_commands.sql":
    "a1f3aa2754378ee5c171d62fa2a60b5c787801953f4a887b031db4ec439a3826",
  "0184_client_budget_context_least_privilege.sql":
    "aa110edadd459e0f11062e3904ea7ad54a54a75c31d9342b762a533ecc07694c",
  "0185_new_client_waitlist_entries.sql":
    "663a5d826d4c9e610c3bf7ec599dea577772ba521326488add77153f39a14ffc",
  "0186_intake_reminder_24h_2h.sql":
    "4041b38653198976233e5bf1ea41b68b349a587ed2c1fa43c251d9c6c629e66e",
  "0187_appointment_settlement.sql":
    "0201f9b8f9e2ca7c5c8f9c702bc020f6bfd5a4046c0490ae3d7be495509e5dc0",
  "0188_new_client_waitlist_invitations.sql":
    "2bf43f0d49280d0095f627f4a3a2e6e169b5111c0d988496244003db377b7bf0",
  "0189_waitlist_invitation_wall_clock_expiry.sql":
    "3abb5ff14778958114057cd358bd59d5b9a91cc50b5fa33ee837ff5fc9d8c46e",
  "0203_waitlist_mobile_verification_authority.sql":
    "c9453ebb8d9a6c94ff1af534c4f2e9930470f2274d205ecf2ad52ecfadbe340b",
  "0206_sms_delivery_foundation.sql":
    "e3cdaf222f39fc34fe04f7bf93cdbbef62f0b08c2b1033fd9c44010cda86b0ab",
  "0207_sms_invitation_claim_serialized.sql":
    "e85239e027623daac7b21c0541458f370c9a7ecedf78baef171575aeb4ed87b5",
  "0208_waitlist_sms_consent_practitioner_and_signup_answer.sql":
    "1c6c512b6f59fc7cde5cc61f538b8acac4a526d9131df7c3e4a4b35d324637f0",
  "0209_public_slot_candidate_buffer_window.sql":
    "9fa04999b974d70d838ba27800a22338b1f08fd7977f553dec38fba034e3f877",
  "0210_sms_waitlist_join_acknowledgement.sql":
    "b1d33743235644447da41a17778e890c05c14deda6c299303cc5febdceea7157",
  "0212_email_delivery_events.sql":
    "cc2abfa3059157b841c1c1c095a84045410121be13d96ff93e34f8332f81d6d1",
};

const DIR = path.resolve(__dirname, "../../supabase/migrations");

describe("applied migrations are byte-for-byte unchanged", () => {
  it.each(Object.entries(PINS))("%s", (file, sha) => {
    expect(createHash("sha256").update(readFileSync(path.join(DIR, file))).digest("hex")).toBe(sha);
  });
});
