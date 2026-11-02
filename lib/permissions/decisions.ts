import type { DecisionId } from "./catalog";

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
  "DN-9": { status: "pending", keyed: true, title: "Which key covers requesting an intake update or resending the intake link" },
  "DN-10": { status: "pending", keyed: true, title: "Who may read card-authorization consent forms and signatures" },
  "DN-11": { status: "pending", keyed: true, title: "A key for writing per-client prices" },
  "DN-12": { status: "decided", keyed: false, title: "Reverting an outcome within 72 hours" },
  "DN-13": { status: "decided", keyed: true, title: "Studio-wide opening hours are a separate permission from colleagues' availability; both OFF" },
  "DN-14": { status: "pending", keyed: true, title: "Staff portal messages to clients" },
  "DN-15": { status: "decided", keyed: true, title: "Waitlist operations per action (receptionist ON, practitioner OFF); rules OFF; imports never imply consent" },
  "DN-16": { status: "pending", keyed: false, title: "Google studio flags: owner UI or operator flag" },
  "DN-17": { status: "pending", keyed: true, title: "STOP scope; today's phone-wide STOP stays until the provider's rules are checked" },
  "DN-18": { status: "pending", keyed: false, title: "Client erasure: owner-only governed erasure after legal review" },
  "DN-19": { status: "pending", keyed: true, title: "Owner export scope" },
  "DN-20": { status: "pending", keyed: false, title: "Portal on/off per studio" },
  "DN-21": { status: "decided", keyed: false, title: "Colleagues see names and colours only; private fields owner and self only; feed tokens are secrets" },
  "DN-22": { status: "pending", keyed: false, title: "Notification read state per user" },
  "DN-23": { status: "pending", keyed: false, title: "Require-card-on-file toggle and a late-cancel window" },
  "DN-24": { status: "decided", keyed: false, title: "ID portrait / ID photo access" },
  "DN-25": { status: "pending", keyed: false, title: "Narrow existing practitioners (archive, delete, restore) at release or at adoption" },
  "DN-26": { status: "pending", keyed: true, title: "Offer receptionist legal-name keys" },
  "DN-27": { status: "decided", keyed: true, title: "Staff read studio name, timezone, booking preferences; fee amounts need pay or price keys" },
  "DN-28": { status: "decided", keyed: false, title: "Getting Started shows only tasks the viewer may perform" },
  "DN-29": { status: "pending", keyed: false, title: "Public rate limits when the limiter is down" },
  "DN-30": { status: "pending", keyed: true, title: "Existing-studio snapshot for practitioner intake review and routine messages" },
};
