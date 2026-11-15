import type { DecisionId, QuestionId } from "./catalog";

// The audit's open decisions (DECISION-MATRIX E1, DN-1..DN-30) and where each stands. OPS is the single writer of Sam's answers
// (01-ops/ROLES-DECISIONS-LOG.md); this file mirrors them so the catalog can be checked against them.
//   decided   Sam answered; the catalog carries the answer and no key is marked pending for it.
//   pending   no answer yet. A key marked `pendingDecision: [id]` ships with the EXISTING-studio snapshot as its value for every
//             studio. A key marked `touchedByDecision: [id]` keeps its value; the decision only changes what the key covers.
//   a decision with no key at all (`keyed: false`) is a rule or a setting, not a permission toggle.
export type DecisionStatus = "decided" | "pending";
export type DecisionEntry = { readonly status: DecisionStatus; readonly title: string; readonly keyed: boolean };

export const DECISIONS: Readonly<Record<DecisionId, DecisionEntry>> = {
  "DN-1": { status: "decided", keyed: true, title: "Staff reports appear under a separate Reports entry, never Business" },
  "DN-2": { status: "decided", keyed: false, title: "Receptionists never see Business" },
  "DN-3": { status: "decided", keyed: true, title: "Records (sterile items, disinfectants, exposure incidents)" },
  "DN-4": { status: "decided", keyed: true, title: "Admission policy permission OFF and separate from the setting (4a); other studio administration owner-only (4b)" },
  "DN-5": { status: "decided", keyed: true, title: "Non-contact client data (date of birth, address, allergies, goals, notes)" },
  "DN-6": { status: "decided", keyed: false, title: "Starting treatment follows the completion scope; no receptionist clinical access; never auto-completes" },
  "DN-7": { status: "decided", keyed: false, title: "Is soft-removing a pass, block or area editing or deletion" },
  "DN-8": { status: "decided", keyed: false, title: "Who may change a session's performer" },
  "DN-9": { status: "decided", keyed: true, title: "Which key covers requesting an intake update or resending the intake link" },
  "DN-10": { status: "decided", keyed: false, title: "Who may read card-authorization consent forms and signatures" },
  "DN-11": { status: "decided", keyed: true, title: "A key for writing per-client prices" },
  "DN-12": { status: "decided", keyed: false, title: "Undoing a recorded outcome (owner-only, no window, reason required, completion / no-show / cancellation)" },
  "DN-13": { status: "decided", keyed: true, title: "Studio-wide opening hours are a separate permission from colleagues' availability; both OFF" },
  "DN-14": { status: "decided", keyed: true, title: "Staff portal messages to clients" },
  "DN-15": { status: "decided", keyed: true, title: "Waitlist operations per action (receptionist ON, practitioner OFF); rules OFF; imports never imply consent" },
  "DN-16": { status: "decided", keyed: false, title: "Google studio flags: owner UI or operator flag" },
  "DN-17": { status: "decided", keyed: false, title: "STOP scope; today's phone-wide STOP stays until the provider's rules are checked" },
  "DN-18": { status: "decided", keyed: false, title: "Client erasure: owner-only governed erasure after legal review" },
  "DN-19": { status: "decided", keyed: false, title: "Owner export scope" },
  "DN-20": { status: "decided", keyed: false, title: "Portal on/off per studio" },
  "DN-21": { status: "decided", keyed: false, title: "Colleagues see names and colours only; private fields owner and self only; feed tokens are secrets" },
  "DN-22": { status: "decided", keyed: false, title: "Notification read state per user" },
  "DN-23": { status: "decided", keyed: false, title: "Require-card-on-file toggle and a late-cancel window" },
  "DN-24": { status: "decided", keyed: false, title: "ID portrait / ID photo access" },
  "DN-25": { status: "decided", keyed: false, title: "Narrow existing practitioners (archive, delete, restore) at release or at adoption" },
  "DN-26": { status: "decided", keyed: false, title: "Offer receptionist legal-name keys" },
  "DN-27": { status: "decided", keyed: true, title: "Staff read studio name, timezone, booking preferences; fee amounts need pay or price keys" },
  "DN-28": { status: "decided", keyed: false, title: "Getting Started shows only tasks the viewer may perform" },
  "DN-29": { status: "decided", keyed: false, title: "Public rate limits when the limiter is down" },
  "DN-30": { status: "decided", keyed: true, title: "Existing-studio snapshot for practitioner intake review and routine messages" },
};

// The open questions OPS is putting to Sam (01-ops/ROLES-RECONCILIATION.md section c, Q1 to Q25 plus Q14b) and three Team-raised items from its section b (B-1..B-3).
// Every Q-n is now settled (batches 1-3 and the settled-from-text list); B-n were Team-raised and are settled by batch 4. `surface` names where it lives: a catalog key, FEE_AMOUNT_READ, a NARROWINGS id or a
// FIXED_OWNER_ONLY id. A key it flags is pinned to its existing-studio snapshot (or merely marked, when only coverage is in doubt).
export type OpenQuestion = { readonly title: string; readonly surface: readonly string[]; readonly status?: "settled"; readonly settledIn?: string };
export const OPEN_QUESTIONS: Readonly<Record<QuestionId, OpenQuestion>> = {
  "Q-1": { title: "Late-cancel window: units and limits; may it stay unset (DN-23b)", surface: ["price.fee_amounts"], status: "settled", settledIn: "Batch 1: whole hours 1-168, unset by default" },
  "Q-2": { title: "Who sets the late-cancel window (DN-23b)", surface: ["price.fee_amounts"], status: "settled", settledIn: "Batch 1: owner sets it" },
  "Q-3": { title: "Bounded fallback for public booking during a limiter outage: the bound and who is alerted (DN-29)", surface: ["rate_limit_outage"], status: "settled", settledIn: "Batch 1: provisional operator-configurable limits, 5 per visitor per 10 min and 30 per studio per hour" },
  "Q-4": { title: "Client-detail data-group boundaries (DN-5)", surface: ["client.view_dob_address", "client.edit_allergies_cautions"], status: "settled", settledIn: "Batch 1: safety, personal, identity (pronouns), clinical record, plus budget, personal notes, tags, health notes" },
  "Q-6": { title: "Scope for portal replies: whole studio or own clients (DN-14)", surface: ["comm.send_portal_reply"], status: "settled", settledIn: "Batch 1: whole studio and assigned client; definition shown to owners first" },
  "Q-7": { title: "Scopes for setting client prices (DN-11)", surface: ["price.edit_client_prices"], status: "settled", settledIn: "Batch 1: whole-studio only, OFF by default" },
  "Q-8": { title: "Waitlist action grouping and whether view is a prerequisite (DN-15a)", surface: ["wl.manage_queue"], status: "settled", settledIn: "Batch 3: wl.expire_close is its own key; every wl.* requires wl.view_queue; imports never create consent or send messages" },
  "Q-9": { title: "Undoing an outcome: any window, and which outcomes (DN-12)", surface: ["revert_recorded_outcome"], status: "settled", settledIn: "Batch 2: owner-only, no window, reason required; completion, no-show and cancellation; never reverses money, records or messages" },
  "Q-10": { title: "Safety records for receptionists: default Off or not offered; log without view (DN-3)", surface: ["records.view_sterilisation_disinfection", "records.log_sterilisation_disinfection"], status: "settled", settledIn: "Batch 2: separate view and log keys, receptionist Off/Off, log requires view; exposure incidents owner and reporter only" },
  "Q-12": { title: "What admit.booking_rules covers (DN-4a vs DN-4b)", surface: ["admit.booking_rules"], status: "settled", settledIn: "Batch 3: booking windows and new-client rules only" },
  "Q-13": { title: "Where the Open / Waitlist / Closed setting is changed", surface: ["admit.change_policy"], status: "settled", settledIn: "Settled from group 2: the Open/Waitlist/Closed setting is separate from the admission key" },
  "Q-14": { title: "Fee amounts readable through payment view at own scope (DN-27)", surface: ["FEE_AMOUNT_READ"], status: "settled", settledIn: "Batch 2: published service prices readable for booking; private settings and client-specific prices not exposed; fee-amount reads unchanged until Q14b" },
  "Q-15": { title: "Show 'Not available yet' on practitioner legal-name edit too (DN-26)", surface: ["client.edit_legal_name"], status: "settled", settledIn: "Settled from group 6: Not available yet on receptionist legal-name rows only" },
  "Q-16": { title: "Which receptionist clinical capabilities are supported (C.4, R0-Q2)", surface: ["clin.edit_records", "clin.upload_photos", "clin.print_record", "appt.complete"], status: "settled", settledIn: "Batch 2: receptionist clinical access is view-only keys offered Off by default; edit, print and complete not offered" },
  "Q-17": { title: "May a practitioner hand one of their OWN appointments to a colleague (R0-Q3)", surface: ["appt.reassign"], status: "settled", settledIn: "Batch 2: appt.handoff_own, Off by default, owner-configurable; eligible same-studio recipient; not after start or treatment" },
  "Q-18": { title: "Erasure workflow: who files, where recorded, what the confirm step shows (DN-18)", surface: ["erase_client_permanently"], status: "settled", settledIn: "Batch 3: owner-only, tracked and audited; recording deletes nothing; execution unavailable" },
  "Q-19": { title: "Staff export content and owner-link lifetime (DN-19)", surface: ["rep.bulk_export"], status: "settled", settledIn: "Batch 3: explicit export permission OFF by default plus access to every row and field, re-checked at generation and download" },
  "Q-20": { title: "Portal OFF: in-flight links and independently controlled features (DN-20)", surface: ["client_portal_setting"], status: "settled", settledIn: "Batch 3: links and sessions blocked on next request; records preserved; intake and consent links must be verified not to bypass" },
  "Q-21": { title: "Anonymous waitlist and demo limits (group 7)", surface: ["anonymous_public_writes_closed"], status: "settled", settledIn: "OPS technical parameters: per-visitor 5/hour and per-email 3/day, one active entry per email per studio, operator-configurable" },
  // Raised by the Team lane from the reconciliation's section b (a key or value no decision backs). B-n, not Q-n: OPS numbers the Q series.
  "B-1": { title: "client.view_directory as a fixed baseline for both roles is implied, never stated", surface: ["client.view_directory"], status: "settled", settledIn: "Batch 4: fixed baseline for active practitioners and receptionists; preferred-name privacy kept; no legal, clinical, export or other-studio access" },
  "B-2": { title: "price.view_client_prices 'own' scope definition is the catalog's, not Sam's", surface: ["price.view_client_prices"], status: "settled", settledIn: "Batch 4: assigned client = non-cancelled appointment currently assigned in this studio; shown beside the option" },
  "B-3": { title: "affectsFutureStudioBusiness labels on opening hours, waitlist rules and admission keys go beyond section C.3", surface: ["admit.booking_rules", "avail.manage_studio_hours"], status: "settled", settledIn: "Batch 4: label on service prices, fees, studio hours, waitlist rules and admission rules, each with a specific effect line" },
  // Follow-ups and later questions in OPS's numbering (ROLES-RECONCILIATION section c, batch 2/3).
  "Q-14b": { title: "Which fee amounts staff may read (DN-27 follow-up)", surface: ["FEE_AMOUNT_READ"], status: "settled", settledIn: "Batch 3: staff read fee amounts clients see at booking; editing stays price.fee_amounts" },
  "Q-22": { title: "A deactivated calendar owner with no other active owner: pause all sync and notify owners, or pause and alert the operator", surface: ["deactivated_calendar_owner"], status: "settled", settledIn: "Batch 3: sync pauses, operator alerted without client data, resumes only on explicit owner reconnect" },
  "Q-23": { title: "An exposure incident whose reporter was removed: who may read it", surface: ["exposure_incident_history"], status: "settled", settledIn: "Batch 3: a removed reporter loses access through that studio; the owner keeps it" },
  "Q-24": { title: "Timing of the advance notice before archive, delete and restore become owner-only (DN-25)", surface: ["archive_clients", "restore_deleted_records"], status: "settled", settledIn: "Settled from group 6: the DN-25 narrowing applies at the enforcement release with advance notice" },
  "Q-25": { title: "Does the studio-totals report need the payment view (and the reverse)", surface: ["rep.studio_totals"], status: "settled", settledIn: "Batch 2: no prerequisite either way; reports never leak an individual payment detail" },
};
