// R0 of the studio Roles and permissions program (Sam, 2 Nov 2026; spec = section C of the build brief, binding).
//
// ONE catalog. This file is pure data plus two pure helpers. NOTHING imports it yet, so it changes no behaviour. R1's
// migration (0287) seeds its catalog table FROM this file and a test pins the two together, so the page (R2), the server
// helper and the database all read ONE map. Do not add a second copy of any default anywhere.
//
// Vocabulary
//   role      practitioner | receptionist. The owner always has every permission and is not configurable.
//   scope     off | own | studio. A boolean capability only allows off | studio ("studio" means ON).
//   own       the key's `own` text says what "own" means (usually: the appointment is assigned to the actor).
//   defaults  what a NEW studio gets (Sam's shipped defaults).
//   snapshot  what an EXISTING studio keeps until its owner reviews a before/after summary and adopts or customizes
//             (C.6). It is today's APPROVED policy, never a database hole (H1, H2, M-2, M-3, M-4 are OFF in it).
//
// Owner-only items that are not keys live in FIXED_OWNER_ONLY and MANDATORY below; they are never delegable.

export const ROLES = ["practitioner", "receptionist"] as const;
export type Role = (typeof ROLES)[number];

export const SCOPES = ["off", "own", "studio"] as const;
export type Scope = (typeof SCOPES)[number];
export const scopeRank = (s: Scope): number => SCOPES.indexOf(s);

// Sam's eight groups, in page order.
export const GROUPS = [
  "appointments",
  "clients_identity",
  "clinical_records",
  "communications",
  "payments",
  "pricing",
  "availability",
  "reports",
] as const;
export type Group = (typeof GROUPS)[number];

export const PHASES = ["R3", "R4", "R5"] as const;
export type Phase = (typeof PHASES)[number];

// How well the snapshot value is known. A reviewer should look hardest at anything that is not "verified".
//   verified         proved at runtime on an isolated copy of the production chain
//   source           read from app + migration source (unverified at runtime)
//   approved_policy  today's code disagrees with an approved decision; the snapshot takes the approved, narrower value
//   not_built        the capability does not exist in the product today, so nothing can be preserved
export type SnapshotBasis = "verified" | "source" | "approved_policy" | "not_built";

export type PermissionDef = {
  readonly key: string;
  readonly group: Group;
  readonly label: string;
  readonly description: string;
  readonly scopes: readonly Scope[]; // always starts with "off"
  readonly own?: string; // required exactly when scopes includes "own"
  readonly requires: readonly string[]; // prerequisite keys; the graph is acyclic
  readonly newStudioDefault: Readonly<Record<Role, Scope>>;
  readonly existingSnapshot: Readonly<Record<Role, Scope>>;
  readonly snapshotBasis: SnapshotBasis;
  // Can the owner turn this on for the role? false = not offered to that role in this version (a catalog fact, not a default).
  readonly offeredTo: Readonly<Record<Role, boolean>>;
  readonly ownerConfigurable: boolean; // false = a fixed baseline of the role (the calendar view)
  readonly enforcedIn: Phase; // which program step switches enforcement on
  readonly killSwitch?: boolean; // the operator kill switch returns every non-owner check for this key to false (R1)
  readonly affectsFutureStudioBusiness?: boolean; // studio-wide price/fee settings are labelled as such on the page
  readonly sensitive?: boolean; // newly enabling it is highlighted in the Reset-to-defaults preview (financial, clinical, identity, bulk)
  readonly shipGate?: Readonly<Partial<Record<Role, string>>>; // the key may not be ENFORCED/offered for that role until this holds
  readonly note?: string;
};

type Pair = readonly [Scope, Scope]; // [practitioner, receptionist]
const pair = (p: Pair): Readonly<Record<Role, Scope>> => ({ practitioner: p[0], receptionist: p[1] });
const BOOL = ["off", "studio"] as const;
const SCOPED = ["off", "own", "studio"] as const;
const BOTH = { practitioner: true, receptionist: true } as const;
const ASSIGNED = "an appointment whose assigned practitioner is the actor";

const CALENDAR = "appt.view_calendar";
const PAY_VIEW = "pay.view_appointment";
const REC_REMOVAL_GATE =
  "Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed";

export const CATALOG = [
  // ───────────────────────────── appointments ─────────────────────────────
  {
    key: CALENDAR,
    group: "appointments",
    label: "View the studio calendar",
    description: "See the studio calendar and the appointments on it.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["studio", "studio"]),
    existingSnapshot: pair(["studio", "studio"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: false,
    enforcedIn: "R4",
    note: "A fixed baseline of both staff roles: not a switch. Receptionists have no app in production today (the desk, #1303, is behind a flag that is OFF).",
  },
  {
    key: "appt.book",
    group: "appointments",
    label: "Book appointments",
    description: "Create an appointment. Own = for yourself; Whole studio = for any practitioner.",
    scopes: SCOPED,
    own: "the new appointment is assigned to the actor",
    requires: [CALENDAR],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["own", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
  },
  {
    key: "appt.move",
    group: "appointments",
    label: "Move appointments",
    description: "Change an appointment's time.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [CALENDAR],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["own", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    note: "Today the UI offers Move on colleagues' appointments and the database refuses it; the snapshot is the database's value.",
  },
  {
    key: "appt.reassign",
    group: "appointments",
    label: "Reassign appointments",
    description: "Change which practitioner an appointment is assigned to. Own = hand one of your own appointments to a colleague.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: ["appt.move"],
    newStudioDefault: pair(["off", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    note: "Sam's spec turns practitioners' reassignment of colleagues' appointments OFF. Whether a practitioner may hand away their OWN appointment is not stated; defaulted OFF (open point R0-Q3).",
  },
  {
    key: "appt.cancel",
    group: "appointments",
    label: "Cancel appointments",
    description: "Cancel an appointment. A coded reason is required and the history is kept. Cancelling never charges a fee.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [CALENDAR],
    newStudioDefault: pair(["studio", "studio"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
  },
  {
    key: "appt.mark_no_show",
    group: "appointments",
    label: "Mark an appointment a no-show",
    description: "Record that the client did not attend. Reason and history kept. Touches no fee; a fee is a separate payment action.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [CALENDAR],
    newStudioDefault: pair(["studio", "studio"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
  },
  {
    key: "appt.edit_notes",
    group: "appointments",
    label: "Edit appointment and scheduling notes",
    description: "Edit the notes on an appointment. Earlier text is preserved as versions. A receptionist sees scheduling notes only, never clinical notes.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [CALENDAR],
    newStudioDefault: pair(["studio", "studio"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
  },
  {
    key: "appt.complete",
    group: "appointments",
    label: "Complete treatments",
    description:
      "Mark a treatment complete. Own = the appointment assigned to you. Completing a colleague's treatment (Whole studio) records who actually completed it.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [CALENDAR, "clin.view_records"],
    newStudioDefault: pair(["own", "off"]),
    existingSnapshot: pair(["own", "off"]),
    snapshotBasis: "approved_policy",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R4",
    shipGate: { practitioner: "#1315 and the 0277 apply (the assigned-only completion rule) are in production" },
    note: "Today's code lets any practitioner complete any started appointment in the studio. Sam's assigned-only rule is the approved policy and #1315/0277 is its vehicle, so the snapshot is 'own' and R4 may not ship before them (open point R0-Q1). Not offered to receptionists in this version.",
  },
  {
    key: "appt.aftercare_send",
    group: "appointments",
    label: "Send approved aftercare",
    description: "Send approved aftercare to a client. Delivery outcome is recorded.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [CALENDAR],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
  },

  // ───────────────────────────── availability ─────────────────────────────
  {
    key: "avail.manage_own",
    group: "availability",
    label: "Manage own availability",
    description: "Change your own working hours and timed blocks.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R4",
    note: "Today a practitioner cannot change working hours (own hours = #1318/0278, held). Receptionists have no hours of their own.",
  },
  {
    key: "avail.manage_others",
    group: "availability",
    label: "Manage other staff's availability",
    description: "Change a colleague's working hours and blocks.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
  },

  // ─────────────────────────── clients and identity ───────────────────────────
  {
    key: "client.create",
    group: "clients_identity",
    label: "Create clients",
    description: "Add a new client.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["studio", "studio"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
  },
  {
    key: "client.edit_contact",
    group: "clients_identity",
    label: "Edit client contact details and preferred name",
    description:
      "Change a client's email, phone and preferred name. Every contact change is audited with masked old and new values, because it re-routes receipts, aftercare and portal links.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["studio", "studio"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
  },
  {
    key: "client.view_legal_name",
    group: "clients_identity",
    label: "View a client's legal name",
    description: "See the legal name. Without it staff see the preferred name, otherwise 'Name on file'. Never exposed in search, links, logs or errors to a role without it.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "0280/0290 receptionist name privacy and a read audit are in production (open point R0-Q4)" },
    note: "The receptionist legal-name switch exists per studio today (default OFF, hidden in the app, unaudited, settable by API). The existing-studio snapshot row for a receptionist COPIES that studio's current switch value so nothing widens; the catalog value shown here is the default for studios whose switch is OFF.",
  },
  {
    key: "client.edit_legal_name",
    group: "clients_identity",
    label: "Edit a client's legal name",
    description: "Change the legal name through the protected identity flow. Separate from viewing; enabling one never grants the other.",
    scopes: BOOL,
    requires: ["client.view_legal_name"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: {
      practitioner: "stale-write protection and versions for legal-name edits (#1328 / M1) are in production",
      receptionist: "0280/0290 receptionist name privacy and a read audit are in production (open point R0-Q4)",
    },
  },
  {
    key: "client.merge",
    group: "clients_identity",
    label: "Merge duplicate clients",
    description: "Merge two client records. Safeguarded: preview, confirmation, history kept.",
    scopes: BOOL,
    requires: ["client.edit_contact"],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "not_built",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "No merge feature exists in the product today. The key is reserved so the feature cannot ship ungated.",
  },
  {
    key: "client.import",
    group: "clients_identity",
    label: "Import clients",
    description: "Import clients or treatment history. Safeguarded: preview, row limits, audit.",
    scopes: BOOL,
    requires: ["client.create"],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Owner-only today (settings page and server action).",
  },

  // ───────────────────────────── clinical records ─────────────────────────────
  {
    key: "clin.view_records",
    group: "clinical_records",
    label: "View clinical records",
    description: "Read charts and treatment records.",
    scopes: BOOL,
    requires: [CALENDAR],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
  },
  {
    key: "clin.edit_records",
    group: "clinical_records",
    label: "Edit clinical records",
    description: "Write and edit charts, with authorship recorded and earlier versions preserved. Separate from deleting, which stays owner-only.",
    scopes: BOOL,
    requires: ["clin.view_records"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
    note: "Not offered to receptionists in this version (open point R0-Q2).",
  },
  {
    key: "clin.view_photos",
    group: "clinical_records",
    label: "View treatment photos",
    description: "See treatment photos.",
    scopes: BOOL,
    requires: ["clin.view_records"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
  },
  {
    key: "clin.upload_photos",
    group: "clinical_records",
    label: "Upload treatment photos",
    description: "Add treatment photos. Deleting photos stays owner-only.",
    scopes: BOOL,
    requires: ["clin.view_photos"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
    note: "Not offered to receptionists in this version (open point R0-Q2).",
  },
  {
    key: "clin.view_intake",
    group: "clinical_records",
    label: "View intake answers",
    description: "Read a client's intake answers.",
    scopes: BOOL,
    requires: ["clin.view_records"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
  },
  {
    key: "clin.edit_intake",
    group: "clinical_records",
    label: "Edit intake answers",
    description: "Change a client's intake answers on their behalf, with history.",
    scopes: BOOL,
    requires: ["clin.view_intake"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
    note: "Not offered to receptionists in this version (open point R0-Q2). Whether practitioners can edit answers today is source-only.",
  },
  {
    key: "clin.print_record",
    group: "clinical_records",
    label: "Print a client's clinical record",
    description: "Print the client's clinical notes view.",
    scopes: BOOL,
    requires: ["clin.view_records"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
  },
  {
    key: "clin.edit_consent_templates",
    group: "clinical_records",
    label: "Edit consent templates",
    description: "Change the consent form templates clients sign.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "approved_policy",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
    note: "The app is owner-only today but the database lets any practitioner write the table (H2). The snapshot is the approved owner-only policy.",
  },

  // ───────────────────────────── communications ─────────────────────────────
  {
    key: "comm.send_routine",
    group: "communications",
    label: "Send routine messages",
    description: "Appointment, receipt and booking-link messages, within the appointments you may act on.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [CALENDAR],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["own", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    note: "What a practitioner can send by hand today is source-only; the automated reminder and receipt mail is not staff-triggered.",
  },
  {
    key: "comm.bulk_message",
    group: "communications",
    label: "Send bulk messages",
    description: "Message many clients at once. Safeguarded: recipient preview, consent respected, audit.",
    scopes: BOOL,
    requires: ["comm.send_routine"],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "not_built",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "No staff bulk-messaging feature exists today. The key is reserved so the feature cannot ship ungated.",
  },

  // ─────────────────────────────── payments ───────────────────────────────
  {
    key: PAY_VIEW,
    group: "payments",
    label: "See an appointment's payment details",
    description: "Payment status, amount, method, and card brand with last 4 digits. No processor identifiers, no treatment detail.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [CALENDAR],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "approved_policy",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    shipGate: { receptionist: REC_REMOVAL_GATE },
    note: "Strict prerequisite of every payment and pricing key below: turning it OFF disables them all. The app hides money from practitioners today, but the database still lets them read paid amounts and card metadata (M-2, M-3); the snapshot is the approved OFF and R3 closes those reads.",
  },
  {
    key: "pay.record_external",
    group: "payments",
    label: "Record cash, e-transfer or other manual payments",
    description: "Record what the client paid outside the card system, or that it is still owed.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [PAY_VIEW],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "verified",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    shipGate: { receptionist: REC_REMOVAL_GATE },
  },
  {
    key: "pay.charge_saved_card",
    group: "payments",
    label: "Charge a saved card",
    description:
      "Charge the client's saved card, including authorized visit or policy-based fees. The amount is always derived by the server and needs the client's existing card authorisation.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [PAY_VIEW],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    shipGate: { receptionist: REC_REMOVAL_GATE },
  },
  {
    key: "pay.refund",
    group: "payments",
    label: "Refund a payment",
    description: "Refund all or part of a captured payment. Reason required, never more than the remaining refundable amount, card refunds return to the original card.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [PAY_VIEW],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    shipGate: { receptionist: REC_REMOVAL_GATE },
  },
  {
    key: "pay.void",
    group: "payments",
    label: "Void a pending charge",
    description: "Cancel a prepared or pending charge attempt.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [PAY_VIEW],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    shipGate: { receptionist: REC_REMOVAL_GATE },
  },
  {
    key: "pay.correct_or_waive",
    group: "payments",
    label: "Correct a payment or waive a fee",
    description: "Supersede a recorded payment or waive a fee. Reason required; the original record is preserved.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [PAY_VIEW],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "verified",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    shipGate: { receptionist: REC_REMOVAL_GATE },
    note: "The earlier proposal made this depend on 'record manual payment'. Sam lists them as separate switches, so the only prerequisite is seeing the payment.",
  },

  // ─────────────────────────────── pricing ───────────────────────────────
  {
    key: "price.appointment",
    group: "pricing",
    label: "Change an appointment's price or discount",
    description: "Change the price or apply a discount on one appointment. Affects that visit only.",
    scopes: SCOPED,
    own: ASSIGNED,
    requires: [PAY_VIEW],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    shipGate: { receptionist: REC_REMOVAL_GATE },
  },
  {
    key: "price.service_list",
    group: "pricing",
    label: "Edit the service price list",
    description: "Change service prices and durations, and add services.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["studio", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "approved_policy",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    affectsFutureStudioBusiness: true,
    sensitive: true,
    shipGate: { receptionist: REC_REMOVAL_GATE },
    note: "Owner-only in the app today but open to any practitioner at the database (H1); the snapshot is the approved owner-only policy. Studio-wide: labelled 'affects future studio business'.",
  },
  {
    key: "price.fee_amounts",
    group: "pricing",
    label: "Change studio fee amounts",
    description: "Change the no-show and late-cancellation fee amounts.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["studio", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    affectsFutureStudioBusiness: true,
    sensitive: true,
    shipGate: { receptionist: REC_REMOVAL_GATE },
  },

  // ─────────────────────────────── reports ───────────────────────────────
  {
    key: "rep.studio_totals",
    group: "reports",
    label: "See studio money totals",
    description: "Studio-wide payment totals on the dashboard and financials.",
    scopes: BOOL,
    requires: [PAY_VIEW],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    note: "Needs the payment view at Whole studio, because a total spans every appointment.",
  },
  {
    key: "rep.financial_reports",
    group: "reports",
    label: "See financial reports",
    description: "Financial reports, payer reports and payment history lists.",
    scopes: BOOL,
    requires: [PAY_VIEW],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
  },
  {
    key: "rep.lifetime_spend",
    group: "reports",
    label: "See a client's lifetime spend",
    description: "A client's total spend across visits.",
    scopes: BOOL,
    requires: [PAY_VIEW],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "approved_policy",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    note: "A practitioner can sum lifetime spend by reading paid amounts at the database today (M-2); the snapshot is the approved OFF and R3 closes the read.",
  },
  {
    key: "rep.bulk_export",
    group: "reports",
    label: "Export or print bulk data",
    description: "Export the client list, schedule or studio data in bulk. Safeguarded: confirmation and audit.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "The full studio export is owner-only today.",
  },
  {
    key: "rep.audit_log_view",
    group: "reports",
    label: "View the studio-wide audit log",
    description: "Read the audit log. Never editable or deletable by anyone through this key.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
  },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof CATALOG)[number]["key"];

// ───────────────────────── never configurable ─────────────────────────
// Sam C.5 and the brief's section B. None of these has a key, so no page, server path or database function can grant them.
// `existingEffect` says what adopting this version does to an existing studio's staff: "none" or "narrows" (a notice is required).

export type FixedOwnerOnly = {
  readonly id: string;
  readonly label: string;
  readonly source: "C.5" | "B" | "this_version";
  readonly existingEffect: "none" | "narrows";
  readonly note?: string;
};

export const FIXED_OWNER_ONLY: readonly FixedOwnerOnly[] = [
  { id: "manage_roles_permissions_ownership", label: "Manage roles, permissions or ownership", source: "C.5", existingEffect: "none" },
  { id: "provider_credentials_bank_payouts", label: "Payment-provider credentials, bank accounts and payouts", source: "C.5", existingEffect: "none" },
  { id: "studio_account_deletion", label: "Studio or account deletion", source: "C.5", existingEffect: "none" },
  { id: "permanent_deletion_bulk_destructive", label: "Permanent deletion and bulk destructive actions", source: "C.5", existingEffect: "none" },
  { id: "audit_history_delete_alter", label: "Deleting or altering audit history", source: "C.5", existingEffect: "none" },
  {
    id: "delete_treatment_records_and_photos",
    label: "Deleting treatment records and photos",
    source: "this_version",
    existingEffect: "narrows",
    note: "Practitioners can soft-delete a colleague's session (reason, audited) and photos today. Owner-only is a NARROWING and needs a notice to affected staff.",
  },
  {
    id: "archive_clients",
    label: "Archiving clients",
    source: "this_version",
    existingEffect: "narrows",
    note: "Any practitioner can archive any client today. A NARROWING; notice required.",
  },
  {
    id: "restore_deleted_records",
    label: "Restoring deleted records",
    source: "this_version",
    existingEffect: "narrows",
    note: "Whether practitioners can restore today is source-only; treated as a narrowing until verified.",
  },
];

// Not in Sam's list and not given a key: they stay owner-only simply because no key exists. Flagged for reviewers as
// "not offered as toggles", NOT as "fixed by Sam" (open point R0-Q5).
export const NOT_OFFERED_AS_TOGGLES: readonly string[] = [
  "Studio settings: booking rules, integrations, payment settings policy, machine registry",
  "Staff invitations and removal (part of managing roles)",
  "Hone subscription and billing portal, tax and currency, receipt branding, business name",
];

// Always true whatever the owner configures (Sam C.5, C.7, brief section B).
export const MANDATORY: readonly string[] = [
  "Studio isolation on every path (app, API, database function, export, link, search)",
  "Consent requirements",
  "Payment authorization: saved-card authorisation evidence is required and amounts are derived by the server",
  "Truthful clinical attribution: acting for a colleague never attributes their attestation; 'risks explained' records the person who explained",
  "The owner always has every permission; a studio always keeps at least one active owner; nobody can promote themselves",
  "Refunds never exceed the remaining refundable amount; card refunds return to the original card; reasons are required; original records are preserved",
  "Revocation is immediate: current membership, studio, key and scope are checked on every protected operation; nothing is cached in a token",
  "Role and permission changes are audited append-only (actor, time, before, after)",
];

// ───────────────────────── pure helpers ─────────────────────────

export const catalogByKey: ReadonlyMap<string, PermissionDef> = new Map(CATALOG.map((d) => [d.key, d]));

export type RoleValues = Readonly<Record<string, Scope>>; // a role's STORED value per key (missing = the default)

export function defaultsFor(role: Role, basis: "newStudio" | "existingSnapshot"): Record<string, Scope> {
  const out: Record<string, Scope> = {};
  for (const d of CATALOG as readonly PermissionDef[]) out[d.key] = basis === "newStudio" ? d.newStudioDefault[role] : d.existingSnapshot[role];
  return out;
}

// EFFECTIVE scope of a key for a role: the stored value, capped by the effective scope of every prerequisite, and OFF when
// the key is not offered to the role. A prerequisite turned OFF makes its dependents effectively OFF, but the dependents'
// STORED values are left alone, so turning the prerequisite back ON restores exactly what the owner had set.
export function effectiveScope(role: Role, key: string, values: RoleValues, seen: ReadonlySet<string> = new Set()): Scope {
  const def = catalogByKey.get(key);
  if (!def || seen.has(key)) return "off"; // unknown key or a cycle fails closed
  if (!def.offeredTo[role]) return "off";
  let scope: Scope = values[key] ?? def.newStudioDefault[role];
  if (!def.scopes.includes(scope)) return "off";
  const next = new Set(seen).add(key);
  for (const req of def.requires) {
    const cap = effectiveScope(role, req, values, next);
    if (scopeRank(cap) < scopeRank(scope)) scope = cap;
  }
  return scope;
}

export type ChangeCheck = { ok: true } | { ok: false; reason: string; blockedBy: string };

// Setting a key. It NEVER changes any other key: a dependent cannot be set above what its prerequisites currently allow, and
// the refusal names the prerequisite so the page can say what to enable first. Lowering a prerequisite is always allowed
// (its dependents simply become effectively OFF).
export function checkChange(role: Role, key: string, next: Scope, values: RoleValues): ChangeCheck {
  const def = catalogByKey.get(key);
  if (!def) return { ok: false, reason: "Unknown permission.", blockedBy: key };
  if (!def.ownerConfigurable) return { ok: false, reason: "This is a fixed baseline of the role.", blockedBy: key };
  if (!def.offeredTo[role] && next !== "off") return { ok: false, reason: "This permission is not offered to this role in this version.", blockedBy: key };
  if (!def.scopes.includes(next)) return { ok: false, reason: "That scope is not available for this permission.", blockedBy: key };
  for (const req of def.requires) {
    const reqDef = catalogByKey.get(req);
    const cap = effectiveScope(role, req, values);
    if (scopeRank(cap) < scopeRank(next)) {
      return {
        ok: false,
        reason: `Turn on "${reqDef?.label ?? req}"${cap === "off" ? "" : ` for ${cap === "own" ? "own appointments" : "the whole studio"}`} first.`,
        blockedBy: req,
      };
    }
  }
  return { ok: true };
}

// The Markdown table that docs/security/permissions-catalog.md embeds between its markers. Generated, never hand-edited:
// a test regenerates it and compares.
const LABEL: Record<Scope, string> = { off: "Off", own: "Own", studio: "Studio" };
export function renderCatalogMarkdown(): string {
  const lines: string[] = [];
  for (const g of GROUPS) {
    lines.push(`### ${g.replace("_", " and ").replace(/^./, (c) => c.toUpperCase())}`, "");
    lines.push("| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const d of (CATALOG as readonly PermissionDef[]).filter((x) => x.group === g)) {
      const gates = Object.entries(d.shipGate ?? {}).map(([r, t]) => `${r}: ${t}`).join("; ") || "–";
      const off = ROLES.filter((r) => !d.offeredTo[r]).map((r) => `${r} not offered`);
      lines.push(
        `| \`${d.key}\`${d.ownerConfigurable ? "" : " (fixed)"}${off.length ? ` (${off.join(", ")})` : ""} | ${d.scopes.map((s) => LABEL[s]).join(" / ")} | ${d.requires.map((r) => `\`${r}\``).join(", ") || "–"} | ${LABEL[d.newStudioDefault.practitioner]} / ${LABEL[d.newStudioDefault.receptionist]} | ${LABEL[d.existingSnapshot.practitioner]} / ${LABEL[d.existingSnapshot.receptionist]} | ${d.snapshotBasis} | ${gates} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
