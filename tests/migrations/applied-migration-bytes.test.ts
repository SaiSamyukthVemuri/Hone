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
  "0160_immutable_clinical_lineage.sql":
    "e56a1ee7efc95e561cd17a0c33750ee4aaaf2a956f425576af39ce4a0e6094d4",
  "0164_clean_entry_create_commands.sql":
    "a1f3aa2754378ee5c171d62fa2a60b5c787801953f4a887b031db4ec439a3826",
  "0171_public_reschedule_command_v2.sql":
    "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6",
  "0172_revoke_authenticated_appointment_dml.sql":
    "b89b0d47a70ea2d4a7574bcc4223081cfe1d527394b3ef8b6d4c82bb090f42f1",
  "0173_appointment_repair_commands.sql":
    "04973b15c7b4b5675faa0d4260e29d7e6ccac9fd4a96cd83cbfbea2b90ab97cb",
  "0174_appointment_attribution_and_audit_integrity.sql":
    "479dc58dd76d6030bc33bd83fb30b0a7f930ca58330067bb98a3f6c16a949bbc",
  "0175_appointment_transition_integrity.sql":
    "7a00f67159a31dcdf90db8a35521ba26f258980b415ddd1aea214e63f4af3ad1",
  "0176_public_cancellation_atomicity.sql":
    "4ed5ad84168d6c6f9a8372709b737990af57a5dde08a4e56a7a983308951af20",
  "0177_postcare_write_boundary.sql":
    "a9c15f1c92a7deb24c8e04dbf123e82806fe35f28be814b84222c1c13ae82744",
  "0178_practitioner_identity_boundary.sql":
    "6fc6a85038144933a7091b20b082aba4dcc5987c36c604c1cde52ec01bef234f",
  "0179_actor_fk_integrity.sql":
    "ce9993d86f67d4f5d82c908980f44baf11e404b371cc0611862e0c253cef059a",
  "0180_card_payment_method_replacement_integrity.sql":
    "d5d8271da38588a89e0727ce7a2a5c417ee8e079ad283acdc1fa55f90727eb8d",
  "0181_multi_studio_command_authority.sql":
    "2f5bcbd5854b1201835f6151debffa940e98035e6a4d88865da1d86fb3da195f",
  "0182_sterile_item_discard_lifecycle.sql":
    "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57",
  "0183_client_budget_context.sql":
    "a7b8926832747319024d7c89213688b68fb363d09e88317e3bba6dbb17c6fbeb",
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
  "0198_waitlist_live_invitation_read.sql":
    "91072df94586e9f78536962ddc8c4c601b080b4e6237374a5315e218dbc0c792",
  "0199_reminder_sms_candidate_selection.sql":
    "9561024b06311526ea04e91b81a006abd8dd92c89296cb761887e34a6d04fca5",
  "0200_waitlist_redeemed_unbooked_exit.sql":
    "a6037f262c38df16fafe51a3178afc90c8fe2b814410eec4f2ad510fdd795158",
  "0201_waitlist_exit_authority_contraction.sql":
    "1567610577e84cb717c77cf8451d57a97150f8fc169de33df2d48370be5ef82f",
  "0202_waitlist_profile_and_sms_consent_authority.sql":
    "7a95e4e66c7c5fe50dbb2d7e73d54f7155c54f376a504ff2fbac47826dbb4ce1",
  "0203_waitlist_mobile_verification_authority.sql":
    "c9453ebb8d9a6c94ff1af534c4f2e9930470f2274d205ecf2ad52ecfadbe340b",
  "0204_new_client_admission_mode.sql":
    "186fa6cb3154c85d2987f1e75aeee6f7361004f1b535cc44a46a27f96b4db219",
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
