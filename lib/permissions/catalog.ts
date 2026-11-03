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

// Sam's eight groups, then the three added by the capability audit, in page order.
export const GROUPS = [
  "appointments",
  "clients_identity",
  "clinical_records",
  "communications",
  "payments",
  "pricing",
  "availability",
  "reports",
  // Added after the capability audit (Sam, 2 Nov): waitlist ENTRY operations and waitlist RULES/AUTOMATION are separate groups,
  // and accepting new clients is an explicit group.
  "waitlist_operations",
  "waitlist_rules",
  "accepting_new_clients",
  // Sterilisation and disinfection logs (Sam, 2 Nov, DN-3).
  "safety_records",
] as const;
export type Group = (typeof GROUPS)[number];

export const PHASES = ["R3", "R4", "R5"] as const;
export type Phase = (typeof PHASES)[number];

// A decision Sam has not made yet (DECISION-MATRIX E1, DN-1..DN-30). `pendingDecision` on a key means: the key is built, but its
// VALUE is not guessed. Every studio (new or existing) gets today's behaviour (the existing-studio snapshot) until the decision is
// made, and the page marks it. `touchedByDecision` means a decision concerns what the key covers but does NOT decide its value.
export type DecisionId = `DN-${number}`;

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
  readonly shipGate?: Readonly<Partial<Record<Role, GateId>>>; // effectively OFF for that role until the gate is satisfied (see GATES)
  readonly pendingDecision?: readonly DecisionId[]; // value pinned to the snapshot for every studio until decided
  readonly touchedByDecision?: readonly DecisionId[]; // informational: a decision touches this key's coverage, not its value
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
// Ship gates. A gated key is EFFECTIVELY OFF for the gated role until the studio policy says the gate is satisfied. The fact is
// an operator-controlled release flag that defaults to NOT satisfied, so an unreleased capability can never come on by default.
export const GATES = {
  receptionist_finance: "Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed",
  receptionist_legal_name: "0280/0290 receptionist name privacy and a legal-name read audit are in production (open point R0-Q4)",
  receptionist_scheduling_notes: "R4 has confirmed from source that scheduling notes are a different field from clinical notes, or limited the receptionist view to a scheduling-only field (Privacy F6)",
  practitioner_legal_name_edit: "Stale-write protection and versions for legal-name edits (#1328 / M1) are in production",
  practitioner_completion: "#1315 and the 0277 apply (the assigned-only completion rule) are in production",
  receptionist_waitlist: "The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a)",
} as const;
export type GateId = keyof typeof GATES;

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
    key: "client.view_directory",
    group: "clients_identity",
    label: "View and search the client list and contact details",
    description: "See and search clients and their contact details. A role without the legal-name key sees the preferred name, otherwise 'Name on file'.",
    scopes: BOOL,
    requires: [CALENDAR],
    newStudioDefault: pair(["studio", "studio"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: false,
    enforcedIn: "R5",
    note: "A fixed baseline, named so a later change to client reads cannot go ungated (D-8). Practitioners read contact details directly and the receptionist through definer functions today.",
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
    shipGate: { receptionist: "receptionist_scheduling_notes" },
    note: "R4 requirements (Privacy F6/F9): confirm scheduling and clinical notes are separate fields before a receptionist can read or write notes; decide whether edit implies read; colleagues' note edits by practitioners are an approved policy only once note versions (0283) ship, so R4 must not enforce the new-studio default for colleagues' notes before them.",
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
    shipGate: { practitioner: "practitioner_completion" },
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
    note: "Studio is the shipped default for a NEW studio only. Today a practitioner cannot change working hours, so an existing studio's snapshot is Off and nobody gains hours control at adoption (own hours = #1318/0278, held). Receptionists have no hours of their own.",
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
  {
    key: "avail.manage_studio_hours",
    group: "availability",
    label: "Manage the studio's opening hours",
    description: "Change the studio-wide weekly opening hours and overrides. Separate from managing a colleague's availability and from managing your own.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    affectsFutureStudioBusiness: true,
    note: "Decided (Sam, 2 Nov, DN-13): a separate permission from avail.manage_others; both OFF by default, owner-configurable. Managing one's own availability (avail.manage_own) stays separate and is already ON for practitioners.",
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
    pendingDecision: ["DN-26"],
    group: "clients_identity",
    label: "View a client's legal name",
    description: "See the legal name. Without it staff see the preferred name, otherwise 'Name on file'. Never exposed in search, links, logs or errors to a role without it.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "approved_policy",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "receptionist_legal_name" },
    note: "The receptionist legal-name switch exists per studio today (default OFF, hidden in the app, unaudited, settable by API). Nobody approved a value above OFF, so the snapshot is OFF for every studio (basis approved_policy). Any studio whose switch is found ON is LISTED in the owner's review banner instead of being carried forward; counting them is a separate read-only step for OPS or Sam.",
  },
  {
    key: "client.edit_legal_name",
    pendingDecision: ["DN-26"],
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
    shipGate: { practitioner: "practitioner_legal_name_edit", receptionist: "receptionist_legal_name" },
  },
  {
    key: "client.merge",
    group: "clients_identity",
    label: "Merge duplicate clients",
    description: "Merge two client records. Safeguarded: preview that shows only what the actor may see (legal names only with view legal name), confirmation, history kept.",
    scopes: BOOL,
    requires: ["client.edit_contact", "client.view_legal_name"],
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
    note: "Decided (Sam, 2 Nov, DN-7): removing a pass, a block or a treated area counts as EDITING under this key; the original and its version history are preserved. Deleting a whole session stays owner-only. Not offered to receptionists in this version (open point R0-Q2).",
  },
  {
    key: "clin.view_photos",
    group: "clinical_records",
    label: "View treatment photos",
    description: "See treatment photos. Needs client visibility only, not chart access: enabling one clinical capability never grants another.",
    scopes: BOOL,
    requires: ["client.view_directory"],
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
    description: "Read a client's intake answers. Needs client visibility only, not chart access: enabling one clinical capability never grants another. Seeing only the intake STATUS is a separate key.",
    scopes: BOOL,
    requires: ["client.view_directory"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
  },
  {
    key: "clin.view_intake_status",
    group: "clinical_records",
    label: "See intake status",
    description: "See whether a client's intake is complete, waiting or out of date. Never the answers and never the chart.",
    scopes: BOOL,
    requires: ["client.view_directory"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    note: "Decided (Sam, 3 Nov, DN-9): requesting an intake update or resending the intake link needs the messaging permission PLUS this status read. It neither requires nor grants the intake answers (clin.view_intake) or the chart.",
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
    note: "Not offered to receptionists in this version (open point R0-Q2). Decided (Sam, 3 Nov, DN-30): practitioners run assisted intake today (audit row 2:C2-53), so today's access is preserved for every existing studio and stays separately configurable; nothing is removed silently at rollout.",
  },
  {
    key: "clin.review_intake",
    group: "clinical_records",
    label: "Review intake",
    description: "Mark a client's intake reviewed and save review notes. Separate from changing the answers.",
    scopes: BOOL,
    requires: ["clin.view_intake"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
    note: "Decided (Sam, 3 Nov, DN-30): practitioners review intake today (audit row 2:C2-51); preserved for existing studios and separately configurable from editing answers.",
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
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R4",
    sensitive: true,
    note: "Not offered to receptionists in this version (open point R0-Q2).",
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
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    note: "Decided (Sam, 3 Nov, DN-30): practitioners send these today, so every existing studio keeps practitioner Studio and receptionist Off. The shipped default for a NEW studio is held equal to that snapshot until Sam confirms his section 4 default for it. Sending intake links, portal links and portal replies are SEPARATE keys that require this one. A permission never overrides consent, opt-outs or channel activation.",
  },
  {
    key: "comm.send_intake_link",
    group: "communications",
    label: "Request an intake update or resend the intake link",
    description: "Ask a client to update their intake or resend the link by email.",
    scopes: BOOL,
    requires: ["comm.send_routine", "clin.view_intake_status"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    note: "Decided (DN-9): needs the messaging permission and the intake STATUS read, never the answers or chart. Practitioners send intake links today (audit row 2:C2-52); preserved and separately configurable (DN-30). Sending always respects consent, opt-outs and channel activation.",
  },
  {
    key: "comm.send_portal_link",
    group: "communications",
    label: "Send a client portal link",
    description: "Send a client their portal sign-in link.",
    scopes: BOOL,
    requires: ["comm.send_routine"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    note: "Decided (DN-30): practitioners send portal links today (audit row 2:C2-74); preserved and separately configurable. Sending always respects consent, opt-outs and channel activation.",
  },
  {
    key: "comm.send_portal_reply",
    group: "communications",
    label: "Reply to a client in the portal",
    description: "Send a staff message or reply in a client's portal thread, within the clients you may see.",
    scopes: BOOL,
    requires: ["comm.send_routine", "client.view_directory"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    note: "Decided (Sam, 3 Nov, DN-14): practitioner ON within their permitted client scope, receptionist OFF, both owner-configurable. The sender is recorded and the history preserved; staff can never rewrite a client's original reply (closes D-M).",
  },
  {
    key: "comm.bulk_message",
    group: "communications",
    label: "Send bulk messages",
    description: "Message many clients at once. Safeguarded: recipient preview, consent respected, row limits, audit.",
    scopes: BOOL,
    requires: ["comm.send_routine", "client.view_directory"],
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
    shipGate: { receptionist: "receptionist_finance" },
    note: "Strict prerequisite of every payment and pricing key below: turning it OFF disables them all. The app hides money from practitioners today, but the database still lets them read paid amounts and card metadata (M-2, M-3); the snapshot is the approved OFF. R3 closes those reads at the COLUMN level (no processor identifiers or card metadata beyond brand and last 4 for any staff role), not only in the UI.",
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
    shipGate: { receptionist: "receptionist_finance" },
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
    shipGate: { receptionist: "receptionist_finance" },
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
    shipGate: { receptionist: "receptionist_finance" },
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
    shipGate: { receptionist: "receptionist_finance" },
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
    shipGate: { receptionist: "receptionist_finance" },
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
    shipGate: { receptionist: "receptionist_finance" },
  },
  {
    key: "price.view_client_prices",
    group: "pricing",
    label: "See a client's special prices",
    description: "Read the per-client prices needed for authorized work (the client_pricing table). Closes M-4 together with the payment view.",
    scopes: SCOPED,
    own: "the price belongs to a client with an appointment assigned to the actor",
    requires: [PAY_VIEW],
    newStudioDefault: pair(["own", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "approved_policy",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    killSwitch: true,
    sensitive: true,
    shipGate: { receptionist: "receptionist_finance" },
    note: "M-4: client_pricing is readable by every member today, while Sam's earlier decision lists per-client prices as forbidden to practitioners. The snapshot is the approved OFF; Sam's C.3 allows the per-client prices needed for authorized work, which this key grants.",
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
    shipGate: { receptionist: "receptionist_finance" },
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
    shipGate: { receptionist: "receptionist_finance" },
    note: "Decided (Sam, 2 Nov, DN-27): staff read only the studio name, timezone and booking preferences their work needs; fee amounts require this key or the relevant payment key.",
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
    note: "Decided (Sam, 2 Nov, DN-1): when an owner permits it, staff reach this under a separate Reports entry; practitioners and receptionists never see Business. Needs the payment view at Whole studio, because a total spans every appointment.",
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
    note: "Decided (Sam, 2 Nov, DN-1): when an owner permits it, staff reach this under a separate Reports entry; practitioners and receptionists never see Business.",
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
    note: "Decided (Sam, 2 Nov, DN-1): when an owner permits it, staff reach this under a separate Reports entry; practitioners and receptionists never see Business. A practitioner can sum lifetime spend by reading paid amounts at the database today (M-2); the snapshot is the approved OFF and R3 closes the read.",
  },
  {
    key: "rep.bulk_export",
    touchedByDecision: ["DN-19"],
    group: "reports",
    label: "Export or print bulk data",
    description: "Export client-list and schedule style outputs in bulk. Contains only fields and rows the actor's own keys would show on screen. NEVER the whole-studio data export or backup, which is fixed owner-only. Safeguarded: confirmation, row limits, audit.",
    scopes: BOOL,
    requires: ["client.view_directory"],
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
    description: "Read the audit log, showing a non-owner only what their own keys allow and never raw (unmasked) values or free-text reasons they could not otherwise see. Never editable or deletable by anyone through this key.",
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
  // ───────────── added after the capability audit (2 Nov): structural keys, values pinned to today's behaviour ─────────────
  // Every key below exists so the capability is covered by the ONE catalog. Today only the owner can do any of it, so every
  // snapshot is Off / Off and the keys are NOT OFFERED to staff: the owner cannot switch them on until Sam decides (the DN ids).
  // ───────────────────────────── waitlist operations (one key per action; Sam, 2 Nov, DN-15a) ─────────────────────────────
  // Receptionist ON for the whole studio, practitioner OFF, both owner-configurable. A receptionist value is effective only once the
  // `receptionist_waitlist` gate is satisfied. Today only the owner can do any of it, so every existing-studio snapshot is Off.
  {
    key: "wl.view_queue",
    group: "waitlist_operations",
    label: "View the new-client waitlist",
    description: "Read the waitlist queue: prospect name, email, phone, status and consent, stated availability, invitations and events.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "receptionist_waitlist" },
    note: "Prospect contact details are personal data. Audit rows WL-1, WL-2.",
  },
  {
    key: "wl.add_entry",
    group: "waitlist_operations",
    label: "Add a waitlist entry",
    description: "Add one prospect to the waitlist by hand.",
    scopes: BOOL,
    requires: ["wl.view_queue"],
    newStudioDefault: pair(["off", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "receptionist_waitlist" },
    note: " Audit rows WL-7.",
  },
  {
    key: "wl.import_entry",
    group: "waitlist_operations",
    label: "Import a legacy waitlist entry",
    description: "Import an entry with its back-dated date and provenance. Importing never records consent and never sends a message.",
    scopes: BOOL,
    requires: ["wl.view_queue"],
    newStudioDefault: pair(["off", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "receptionist_waitlist" },
    note: "Importing never implies consent and never triggers a message automatically (Sam, 2 Nov). Audit rows WL-8.",
  },
  {
    key: "wl.withdraw_entry",
    group: "waitlist_operations",
    label: "Withdraw a waitlist entry",
    description: "Remove (withdraw) an entry from the waitlist.",
    scopes: BOOL,
    requires: ["wl.view_queue"],
    newStudioDefault: pair(["off", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "receptionist_waitlist" },
    note: " Audit rows WL-3.",
  },
  {
    key: "wl.manage_queue",
    group: "waitlist_operations",
    label: "Claim, release and requeue entries",
    description: "Claim, release, expire, requeue or close an unbooked entry, and claim the next few.",
    scopes: BOOL,
    requires: ["wl.view_queue"],
    newStudioDefault: pair(["off", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "receptionist_waitlist" },
    note: " Audit rows WL-4.",
  },
  {
    key: "wl.offer_booking",
    group: "waitlist_operations",
    label: "Invite one person to book",
    description: "Invite one prospect to book (admit them and send the booking link). Starting or closing an invitation round is a rule, not this.",
    scopes: BOOL,
    requires: ["wl.view_queue"],
    newStudioDefault: pair(["off", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "receptionist_waitlist" },
    note: "Sends a message to the prospect, so it follows the consent and opt-out rules and a permission never overrides them. Audit rows WL-6.",
  },
  {
    key: "wl.set_availability",
    group: "waitlist_operations",
    label: "Set an entry's stated availability",
    description: "Change when a prospect says they are available.",
    scopes: BOOL,
    requires: ["wl.view_queue"],
    newStudioDefault: pair(["off", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "receptionist_waitlist" },
    note: " Audit rows WL-9.",
  },
  {
    key: "wl.record_sms_consent",
    group: "waitlist_operations",
    label: "Record a prospect's text-message consent on their behalf",
    description: "Record SMS consent for a prospect. A consent action: it never overrides a STOP and is always audited.",
    scopes: BOOL,
    requires: ["wl.view_queue"],
    newStudioDefault: pair(["off", "studio"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    shipGate: { receptionist: "receptionist_waitlist" },
    touchedByDecision: ["DN-17"],
    note: "Separate because it records consent. Receptionist ON is Sam's decision (DN-15a) and is usable only when the screen and backend enforcement ship. STOP scope is undecided (DN-17) and today's phone-wide STOP stays. Audit rows WL-10.",
  },
  // ───────────────────────────── waitlist rules and automation ─────────────────────────────
  {
    key: "wlrules.invitation_rounds",
    group: "waitlist_rules",
    label: "Start and close invitation rounds",
    description: "Open an invitation round with an allowance and close invitations.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    affectsFutureStudioBusiness: true,
    note: "Rules and automation, deliberately separate from operating entries; OFF for both staff roles, owner-configurable (Sam, 2 Nov, DN-15b). A permission alone never enables SMS and never overrides consent or opt-out restrictions.",
  },
  {
    key: "wlrules.policy_and_text",
    group: "waitlist_rules",
    label: "Waitlist policy, preference grants and text",
    description: "Change the waitlist admission policy, preference grants, ordered-claim rules and the waitlist wording toggles.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    affectsFutureStudioBusiness: true,
    note: "Rules and automation, deliberately separate from operating entries; OFF for both staff roles, owner-configurable (Sam, 2 Nov, DN-15b). A permission alone never enables SMS and never overrides consent or opt-out restrictions.",
  },
  // ───────────────────────────── accepting new clients ─────────────────────────────
  {
    key: "admit.change_policy",
    group: "accepting_new_clients",
    label: "Change the new-client admission policy",
    description: "Permission to change the admission policy. The studio's current Open, Waitlist or Closed setting is a separate studio setting.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    affectsFutureStudioBusiness: true,
    note: "OFF for both staff roles, owner-configurable (Sam, 2 Nov, DN-4a). This is the PERMISSION to change the admission policy. The studio's actual Open / Waitlist / Closed setting is a studio setting, not a permission, and the page keeps the two visibly apart. The public enforcement of the mode stays a mandatory server rule.",
  },
  {
    key: "admit.booking_rules",
    group: "accepting_new_clients",
    label: "Booking window and new-client booking rules",
    description: "How far ahead clients may book and the rules for public new-client booking.",
    scopes: BOOL,
    requires: [],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    affectsFutureStudioBusiness: true,
    note: "OFF for both staff roles, owner-configurable (Sam, 2 Nov, DN-4a). This is the PERMISSION to change the admission policy. The studio's actual Open / Waitlist / Closed setting is a studio setting, not a permission, and the page keeps the two visibly apart. The public enforcement of the mode stays a mandatory server rule.",
  },
  // ───────────────────────────── single capabilities with an open decision ─────────────────────────────
  {
    key: "price.edit_client_prices",
    group: "pricing",
    label: "Set a client's own price",
    description: "Write a per-client price. Reading them is price.view_client_prices.",
    scopes: BOOL,
    requires: ["price.view_client_prices"],
    newStudioDefault: pair(["off", "off"]),
    existingSnapshot: pair(["off", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R3",
    sensitive: true,
    killSwitch: true,
    note: "Decided (Sam, 3 Nov, DN-11): a separate permission to set or change a client's own price, OFF for both staff roles and owner-configurable. Reading follows price.view_client_prices and its scope. Every change is recorded. Appointments already booked keep their agreed price unless someone explicitly edits that appointment's price.",
  },
  // ───────────── client details, one view and one edit key per data group (Sam, 2 Nov, DN-5) ─────────────
  // Practitioners keep today's studio-wide access; receptionists are OFF and the owner may grant READ-ONLY per group (the edit keys are
  // not offered to receptionists), for example allergies and cautions without the full chart.
  {
    key: "client.view_dob_address",
    group: "clients_identity",
    label: "View date of birth and address",
    description: "See date of birth and address on a client's record without the rest of the chart.",
    scopes: BOOL,
    requires: [CALENDAR, "client.view_directory"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Decided (Sam, 2 Nov, DN-5): practitioners keep today's studio-wide access; receptionists OFF with a read-only grant available per data group.",
  },
  {
    key: "client.edit_dob_address",
    group: "clients_identity",
    label: "Edit date of birth and address",
    description: "Change date of birth and address. Separate from viewing; enabling one never grants the other.",
    scopes: BOOL,
    requires: ["client.view_dob_address"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Not offered to receptionists (read-only grants only, DN-5).",
  },
  {
    key: "client.view_allergies_cautions",
    group: "clients_identity",
    label: "View allergies and pinned cautions",
    description: "See allergies and pinned cautions on a client's record without the rest of the chart.",
    scopes: BOOL,
    requires: [CALENDAR, "client.view_directory"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Decided (Sam, 2 Nov, DN-5): practitioners keep today's studio-wide access; receptionists OFF with a read-only grant available per data group.",
  },
  {
    key: "client.edit_allergies_cautions",
    group: "clients_identity",
    label: "Edit allergies and pinned cautions",
    description: "Change allergies and pinned cautions. Separate from viewing; enabling one never grants the other.",
    scopes: BOOL,
    requires: ["client.view_allergies_cautions"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Not offered to receptionists (read-only grants only, DN-5).",
  },
  {
    key: "client.view_budget_goals",
    group: "clients_identity",
    label: "View budget context and treatment goals",
    description: "See budget context and treatment goals on a client's record without the rest of the chart.",
    scopes: BOOL,
    requires: [CALENDAR, "client.view_directory"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Decided (Sam, 2 Nov, DN-5): practitioners keep today's studio-wide access; receptionists OFF with a read-only grant available per data group.",
  },
  {
    key: "client.edit_budget_goals",
    group: "clients_identity",
    label: "Edit budget context and treatment goals",
    description: "Change budget context and treatment goals. Separate from viewing; enabling one never grants the other.",
    scopes: BOOL,
    requires: ["client.view_budget_goals"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Not offered to receptionists (read-only grants only, DN-5).",
  },
  {
    key: "client.view_personal_notes",
    group: "clients_identity",
    label: "View personal notes",
    description: "See personal notes on a client's record without the rest of the chart.",
    scopes: BOOL,
    requires: [CALENDAR, "client.view_directory"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Decided (Sam, 2 Nov, DN-5): practitioners keep today's studio-wide access; receptionists OFF with a read-only grant available per data group.",
  },
  {
    key: "client.edit_personal_notes",
    group: "clients_identity",
    label: "Edit personal notes",
    description: "Change personal notes. Separate from viewing; enabling one never grants the other.",
    scopes: BOOL,
    requires: ["client.view_personal_notes"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Not offered to receptionists (read-only grants only, DN-5).",
  },
  {
    key: "client.view_tags",
    group: "clients_identity",
    label: "View client tags",
    description: "See client tags on a client's record without the rest of the chart.",
    scopes: BOOL,
    requires: [CALENDAR, "client.view_directory"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Decided (Sam, 2 Nov, DN-5): practitioners keep today's studio-wide access; receptionists OFF with a read-only grant available per data group.",
  },
  {
    key: "client.edit_tags",
    group: "clients_identity",
    label: "Edit client tags",
    description: "Change client tags. Separate from viewing; enabling one never grants the other.",
    scopes: BOOL,
    requires: ["client.view_tags"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Not offered to receptionists (read-only grants only, DN-5).",
  },
  {
    key: "client.view_health_fields",
    group: "clients_identity",
    label: "View the health fields on an appointment",
    description: "See the health fields on an appointment on a client's record without the rest of the chart.",
    scopes: BOOL,
    requires: [CALENDAR, "client.view_directory"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Decided (Sam, 2 Nov, DN-5): practitioners keep today's studio-wide access; receptionists OFF with a read-only grant available per data group.",
  },
  {
    key: "client.edit_health_fields",
    group: "clients_identity",
    label: "Edit the health fields on an appointment",
    description: "Change the health fields on an appointment. Separate from viewing; enabling one never grants the other.",
    scopes: BOOL,
    requires: ["client.view_health_fields"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: { practitioner: true, receptionist: false },
    ownerConfigurable: true,
    enforcedIn: "R5",
    sensitive: true,
    note: "Not offered to receptionists (read-only grants only, DN-5).",
  },
  // ───────────── sterilisation and disinfection logs (Sam, 2 Nov, DN-3) ─────────────
  {
    key: "records.view_sterilisation_disinfection",
    group: "safety_records",
    label: "View sterilisation and disinfection records",
    description: "See the sterile-item, disinfectant and probe-lot records.",
    scopes: BOOL,
    requires: [CALENDAR],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    note: "Decided (DN-3): ON for practitioners, OFF for receptionists, separate from logging. Exposure-incident history is NOT this key: it is visible to the owner and the person who reported it only.",
  },
  {
    key: "records.log_sterilisation_disinfection",
    group: "safety_records",
    label: "Log sterilisation and disinfection",
    description: "Add or update a sterile item or a disinfectant record.",
    scopes: BOOL,
    requires: ["records.view_sterilisation_disinfection"],
    newStudioDefault: pair(["studio", "off"]),
    existingSnapshot: pair(["studio", "off"]),
    snapshotBasis: "source",
    offeredTo: BOTH,
    ownerConfigurable: true,
    enforcedIn: "R4",
    note: "Decided (DN-3): a separate permission from viewing; ON for practitioners, OFF for receptionists.",
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
  // Database objects that must refuse a non-owner for this item: R4's checklist. 'to confirm' = not yet located.
  readonly enforcedBy?: readonly string[];
  readonly note?: string;
};

export const FIXED_OWNER_ONLY: readonly FixedOwnerOnly[] = [
  { id: "manage_roles_permissions_ownership", label: "Manage roles, permissions or ownership", source: "C.5", existingEffect: "none" },
  { id: "staff_invite_remove_role_change", label: "Inviting, removing and changing the role of staff", source: "C.5", existingEffect: "none", note: "Part of 'managing roles'. R-1 (a receptionist created outside the desk) is a hole in exactly this item." },
  { id: "ownership_transfer", label: "Transferring ownership", source: "C.5", existingEffect: "none" },
  { id: "permission_system_administration", label: "Changing the permission catalog, overrides, operator kill switch or their audit tables", source: "C.5", existingEffect: "none", note: "Only through the owner-only writer functions; a role can never grant itself anything." },
  { id: "full_studio_data_export", label: "The whole-studio data export and backup", source: "this_version", existingEffect: "none", note: "A complete egress of client data. rep.bulk_export never covers it." },
  { id: "provider_credentials_bank_payouts", label: "Payment-provider credentials, bank accounts and payouts", source: "C.5", existingEffect: "none" },
  { id: "studio_account_deletion", label: "Studio or account deletion", source: "C.5", existingEffect: "none" },
  { id: "permanent_deletion_bulk_destructive", label: "Permanent deletion and bulk destructive actions", source: "C.5", existingEffect: "none" },
  { id: "audit_history_delete_alter", label: "Deleting or altering audit history", source: "C.5", existingEffect: "none" },
  {
    id: "delete_treatment_records_and_photos",
    label: "Deleting whole sessions and photos",
    source: "this_version",
    existingEffect: "narrows",
    enforcedBy: ["public.soft_delete_session", "public.archive_treatment_image"],
    note: "Practitioners can soft-delete a colleague's session (reason, audited) and photos today. Owner-only is a NARROWING: it needs a notice in the owner's review banner and to the affected staff. Removing a pass, a block or a treated area is EDITING under clin.edit_records, not deletion (DN-7).",
  },
  {
    id: "revert_recorded_outcome",
    label: "Undoing a recorded outcome (completed, no-show or cancelled) within the 72-hour window",
    source: "this_version",
    existingEffect: "none",
    note: "Decided (Sam, 2 Nov, DN-12): owner-only, with a reason and history. It never automatically refunds, charges, erases treatment records or reverses a message already sent.",
  },
  {
    id: "require_card_to_book",
    label: "Requiring a card on file to book",
    source: "this_version",
    existingEffect: "none",
    note: "Decided (Sam, 3 Nov, DN-23a): an owner-only studio setting on the payment settings page, separate from staff permissions. Not a key.",
  },
  {
    id: "id_photos_portraits",
    label: "ID photos and portraits",
    source: "this_version",
    existingEffect: "none",
    note: "Decided (Sam, 2 Nov, DN-24): owner-only and not delegable until the separate ID-photo review (#1296 / 0275) is complete.",
  },
  {
    id: "archive_clients",
    label: "Archiving clients",
    source: "this_version",
    existingEffect: "narrows",
    enforcedBy: ["clients.archived_at write path (0050)", "public.record_client_archive_audit_governed"],
    note: "Any practitioner can archive any client today. A NARROWING; notice required.",
  },
  {
    id: "restore_deleted_records",
    label: "Restoring deleted records",
    source: "this_version",
    existingEffect: "narrows",
    enforcedBy: ["client unarchive path (UnarchiveRowControl)", "session restore path: to confirm"],
    note: "Whether practitioners can restore today is source-only; treated as a narrowing until verified.",
  },
];

// Not in Sam's list and not given a key: they stay owner-only simply because no key exists. Flagged for reviewers as
// "not offered as toggles", NOT as "fixed by Sam" (open point R0-Q5).
export const NOT_OFFERED_AS_TOGGLES: readonly string[] = [
  "Studio administration other than the keys above (studio details, email and text toggles, tracking, the Google destination, machines, onboarding): owner-only this release (Sam, 2 Nov, DN-4b)",
  "Payment settings policy such as 'card required' (stays owner-only; the settings page must split it from the fee AMOUNTS key)",
  "Viewing signed consent contents and machine settings: ride on clin.view_records, no separate key",
  "ID-photo store and portrait (0275 / 0231): not built or feature-off; no key until they ship",
  "Hone subscription and billing portal, tax and currency, receipt branding, business name",
];

// Decided rules that take away something an existing practitioner or member can do today, or that only a mandatory rule enforces.
// FIXED_OWNER_ONLY carries the same record for fixed items; these have no key, so they are listed here so each one gets a named
// enforcement point and the notice in the owner's review banner (the "nothing changes until adopted" promise).
export type Narrowing = {
  readonly id: string;
  readonly decision: DecisionId;
  readonly label: string;
  readonly stage: "R1" | "R4" | "R5";
  // Database objects or app paths that must enforce it. "to confirm" = not yet located by the stage that owns it.
  readonly enforcedBy: readonly string[];
  readonly narrowsExisting: boolean;
  readonly notice: string;
};

export const NARROWINGS: readonly Narrowing[] = [
  {
    id: "performer_change",
    decision: "DN-8",
    label: "Changing a session's performer: owner or the currently recorded performer only",
    stage: "R4",
    enforcedBy: ["to confirm: the session-performer update path (audit row CLIN-15)"],
    narrowsExisting: true,
    notice: "Any member can name any peer as a session's performer today. From adoption only the owner or the recorded performer can, with a reason.",
  },
  {
    id: "exposure_incident_history",
    decision: "DN-3",
    label: "Exposure-incident history: owner and the reporter only",
    stage: "R4",
    enforcedBy: ["to confirm: exposure-incident read and update path (audit rows REC-4, REC-5)"],
    narrowsExisting: true,
    notice: "Other practitioners can read and update exposure incidents today. From adoption only the owner and the person who reported can.",
  },
  {
    id: "colleague_private_fields",
    decision: "DN-21",
    label: "Colleague email, Google account email and calendar-feed hash: owner and that person only",
    stage: "R1",
    enforcedBy: ["to confirm: a column-limited staff roster read (audit rows ST-9, ST-8, GC-2)"],
    narrowsExisting: true,
    notice: "Practitioners can read colleagues' emails and feed-token hashes through the API today. From adoption they see names and colours only.",
  },
  {
    id: "studio_columns_read",
    decision: "DN-27",
    label: "Staff read studio name, timezone and booking preferences; fee amounts need a pay or price key",
    stage: "R1",
    enforcedBy: ["to confirm: a column-limited studios read replacing the member read of every column (audit row SET-9)"],
    narrowsExisting: true,
    notice: "Members can read every studio column through the API today, including fee amounts.",
  },
  {
    id: "getting_started_filter",
    decision: "DN-28",
    label: "Getting Started shows only the tasks the viewer may perform",
    stage: "R5",
    enforcedBy: ["app: the Getting Started task list (audit row NAV-9)"],
    narrowsExisting: false,
    notice: "Tasks the viewer cannot perform are no longer listed.",
  },
  {
    id: "notification_read_state",
    decision: "DN-22",
    label: "Notification read state is per person; users read only notifications they may see and change only their own state",
    stage: "R5",
    enforcedBy: ["to confirm: the notifications read, mark-read and mark-all-read paths (audit rows COM-9, COM-10)"],
    narrowsExisting: true,
    notice: "Any member can edit any notification row and mark everyone's as read today. From adoption each person has their own read state.",
  },
  {
    id: "portal_reply_immutable",
    decision: "DN-14",
    label: "Staff can never rewrite a client's original portal reply",
    stage: "R5",
    enforcedBy: ["to confirm: the portal message update path (audit rows PORT-4, PORT-8)"],
    narrowsExisting: true,
    notice: "Staff can edit message rows through the API today. From adoption a client's original reply is immutable and the sender of every staff message is recorded.",
  },
];

// Who may READ a fee amount (Insurance R-3). Changing one is price.fee_amounts; reading is separate and today every member can read every
// studio column. Staff otherwise read only the studio name, timezone and booking preferences, through a column-limited read.
export const FEE_AMOUNT_READ = {
  anyOf: ["price.fee_amounts", "pay.view_appointment"],
  staffOtherwise: ["studio name", "timezone", "booking preferences"],
} as const;

// Always true whatever the owner configures (Sam C.5, C.7, brief section B).
export const MANDATORY: readonly string[] = [
  "Studio isolation on every path (app, API, database function, export, link, search)",
  "Consent requirements",
  "Decided (Sam, 3 Nov, DN-10): card-authorisation consent is READ-ONLY, follows the payment-view permission and its scope (practitioners: own appointments; receptionists: studio-wide when enabled), shows only the authorisation relevant to THAT payment without granting intake or clinical access, and signed originals can never be edited or deleted",
  "Decided (DN-11): appointments already booked keep their agreed prices unless someone explicitly edits that appointment, and every client-specific price change is recorded",
  "Decided (DN-23b): a late-cancellation fee needs an explicit owner-configured window with NO invented default and is never activated automatically; the server decides eligibility from the recorded cancellation time, the appointment time and the policy snapshot taken at THAT booking; the fee-charging permission (pay.charge_saved_card) is also required; duplicate charges are prevented and the reason and history are kept",
  "Reading a fee amount needs price.fee_amounts or pay.view_appointment at any scope; without either, staff read only the studio name, timezone and booking preferences, through a column-limited read, never the whole studios row (DN-27)",
  "Turning wl.view_queue off turns every other waitlist operation key off for that role, and wl.offer_booking and wl.record_sms_consent still check consent and opt-out at the send and record paths, not in the key",
  "Decided (Sam, 3 Nov, DN-9): requesting an intake update or resending the intake link needs the messaging permission plus the intake STATUS read; it never needs or grants the intake answers or the chart",
  "Decided (DN-14): the sender of every staff portal message is recorded, history is preserved, and staff can never rewrite a client's original reply",
  "Decided (DN-22): notification read state is per person; a user reads only notifications they may see and changes only their own read state",
  "Decided (Sam, 3 Nov): all sending (messages, links, portal replies, aftercare) respects consent, opt-outs and existing channel-activation restrictions; no permission overrides them",
  "Decided (Sam, 2 Nov, DN-8): a session's performer is corrected only by the owner or the currently recorded performer, with a reason and audit history; the replacement must be an eligible practitioner of that studio; who actually entered each record is preserved; signatures, attestations and payment history are never rewritten; reassignment cannot be used to bypass a permission",
  "Decided (DN-3): exposure-incident history is visible to the owner and the person who reported it only",
  "Decided (DN-12): undoing a recorded outcome never automatically refunds, charges, erases treatment records or reverses messages already sent",
  "Decided (Sam, 2 Nov, DN-15): importing a waitlist entry never records consent and never sends a message; a waitlist rules permission never enables SMS and never overrides consent or opt-out restrictions",
  "Decided (DN-4a): the permission to change the admission policy is separate from the studio's actual Open / Waitlist / Closed setting, and public enforcement of that setting is a server rule no permission can bypass",
  "Decided (DN-6): starting a treatment follows the permitted completion scope; it never gives a receptionist clinical access and never completes an appointment automatically",
  "Decided (Sam, 2 Nov, DN-1/DN-2): practitioners and receptionists never see the Business tab, whatever keys are on; staff reports appear under a separate Reports entry, and Business data is protected too",
  "Decided (DN-21): colleagues see staff display names and calendar colours only; private email and account details, Google account emails, pending invitations and personal or operational alerts are visible to the owner and that person only",
  "Decided (DN-21): calendar-feed tokens and their hashes are secrets: never in a colleague listing, a search result, an export, a log or the Roles page",
  "Decided (DN-27): staff read only the studio name, timezone and booking preferences their permitted work needs; fee amounts need the relevant payment or pricing permission",
  "Decided (DN-28): Getting Started shows only the tasks the viewer has permission to perform",
  "Payment authorization: saved-card authorisation evidence is required and amounts are derived by the server",
  "Truthful clinical attribution: acting for a colleague never attributes their attestation; 'risks explained' records the person who explained",
  "The owner always has every permission; a studio always keeps at least one active owner; nobody can promote themselves",
  "Refunds never exceed the remaining refundable amount; card refunds return to the original card; reasons are required; original records are preserved",
  "Revocation is immediate: current membership, studio, key and scope are checked on every protected operation; nothing is cached in a token",
  "Role and permission changes are audited append-only (actor, time, before, after)",
  "The owner-visible financial activity feed cannot be switched off or hidden by any key",
  "Service-role money paths verify the actual acting user (the actor id comes from the verified session and is re-checked in the definer)",
  "A reason is required for every refund, correction and waiver, and the original record is preserved",
  "Overlapping memberships or dual roles cannot bypass a denial: the most restrictive of the actor's current active rows applies",
  "The operator kill switch fails closed: a non-owner finance check returns false whenever it is engaged or its state cannot be read",
  "A missing, unknown or unreadable policy state resolves to OFF, never to a default",
  "Every derived output (export, print, report, message, audit view) contains only the fields and rows the actor's own effective keys would allow on screen: legal names only with view legal name, clinical content only with clinical read, amounts only with payment view and scope, clients only within scope",
  "The permission catalog, overrides, kill switch and audit tables change only through owner-only writer functions, and a role can never grant itself anything",
  "Scope is evaluated on the CURRENT assignee at the moment of the action and never cached; reassignment is audited with before and after, and the owner feed flags 'reassigned to self then refunded or completed' (a signal, not a block)",
];

// ───────────────────────── pure helpers ─────────────────────────

export const catalogByKey: ReadonlyMap<string, PermissionDef> = new Map((CATALOG as readonly PermissionDef[]).map((d) => [d.key, d]));

// ─────────── studio policy state (D-1) ───────────
// Every studio carries a POLICY BASIS: `existing_snapshot` until its owner reviews the before/after summary and adopts (or saves a
// custom configuration), `new_studio` for studios created under the shipped defaults. A key with no stored value resolves to the
// studio's BASIS, never to the new-studio default. A studio whose basis is unknown (null) resolves every key to Off.
// Reset to defaults sets the basis to `new_studio` only after the preview and the owner's confirmation.
export type PolicyBasis = "existing_snapshot" | "new_studio";
export type RoleValues = Readonly<Record<string, Scope>>; // a role's STORED overrides per key
export type StudioPolicy = {
  readonly basis: PolicyBasis | null;
  readonly values: RoleValues;
  // Gates the operator has marked satisfied for this studio. Absent = NOT satisfied (fail closed).
  readonly gates?: Readonly<Partial<Record<GateId, boolean>>>;
};

export const basisValue = (d: PermissionDef, role: Role, basis: PolicyBasis): Scope =>
  basis === "new_studio" ? d.newStudioDefault[role] : d.existingSnapshot[role];

export function defaultsFor(role: Role, basis: PolicyBasis): Record<string, Scope> {
  const out: Record<string, Scope> = {};
  for (const d of CATALOG as readonly PermissionDef[]) out[d.key] = basisValue(d, role, basis);
  return out;
}

// The scopes the owner may pick for a role. "Own assigned appointments" means nothing for a receptionist (they are never the
// assigned practitioner), so it is not offered to them (D-5).
export const scopesFor = (d: PermissionDef, role: Role): readonly Scope[] =>
  role === "receptionist" ? d.scopes.filter((s) => s !== "own") : d.scopes;

// EFFECTIVE scope of a key for a role in a studio. This is the ONE rule the database function must copy.
//   1. unknown key, a cycle, an unknown policy basis, a key not offered to the role, or an unsatisfied ship gate: Off.
//   2. the stored value, else the studio's BASIS value (never the new-studio default for an existing studio).
//   3. a stored value the role may not hold (outside scopesFor) is Off.
//   4. capped by every prerequisite's effective scope. A capped result that the key does not allow becomes Off, so a
//      boolean key can never come out as 'own' (D-2): a key that spans the studio needs its prerequisite at that scope.
//   5. an unmet ship gate caps the key at the existing-studio snapshot (see below).
// A prerequisite turned Off makes dependents effectively Off while their STORED values are kept.
export function effectiveScope(role: Role, key: string, policy: StudioPolicy, seen: ReadonlySet<string> = new Set()): Scope {
  const def = catalogByKey.get(key);
  if (!def || seen.has(key) || policy.basis === null) return "off";
  if (!def.offeredTo[role]) return "off";
  const allowed = scopesFor(def, role);
  let scope: Scope = policy.values[key] ?? basisValue(def, role, policy.basis);
  if (!allowed.includes(scope)) return "off";
  // An unmet ship gate makes the role-key UNAVAILABLE: it is capped at the existing-studio snapshot, so a gated capability
  // that is new for the role (receptionist finance, receptionist legal name) is Off, while behaviour a studio has today is
  // neither widened nor silently narrowed. The gate is operator data; an owner cannot change it.
  const gate = def.shipGate?.[role];
  if (gate && policy.gates?.[gate] !== true && scopeRank(scope) > scopeRank(def.existingSnapshot[role])) scope = def.existingSnapshot[role];
  const next = new Set(seen).add(key);
  for (const req of def.requires) {
    const cap = effectiveScope(role, req, policy, next);
    if (scopeRank(cap) < scopeRank(scope)) scope = cap;
  }
  return allowed.includes(scope) ? scope : "off";
}

export type ChangeCheck = { ok: true } | { ok: false; reason: string; blockedBy: string };

// Setting a key. It NEVER changes any other key: a dependent cannot be set above what its prerequisites currently allow, and
// the refusal names the prerequisite so the page can say what to enable first. Lowering a prerequisite is always allowed
// (its dependents simply become effectively Off). A key that is not yet available (unmet gate) cannot be raised above its snapshot.
export function checkChange(role: Role, key: string, next: Scope, policy: StudioPolicy): ChangeCheck {
  const def = catalogByKey.get(key);
  if (!def) return { ok: false, reason: "Unknown permission.", blockedBy: key };
  if (!def.ownerConfigurable) return { ok: false, reason: "This is a fixed baseline of the role.", blockedBy: key };
  if (!def.offeredTo[role] && next !== "off") return { ok: false, reason: "This permission is not offered to this role in this version.", blockedBy: key };
  if (!scopesFor(def, role).includes(next)) return { ok: false, reason: "That scope is not available for this permission and role.", blockedBy: key };
  const gate = def.shipGate?.[role];
  if (gate && policy.gates?.[gate] !== true && scopeRank(next) > scopeRank(def.existingSnapshot[role])) {
    return { ok: false, reason: `Not yet available: ${GATES[gate]}.`, blockedBy: gate };
  }
  for (const req of def.requires) {
    const reqDef = catalogByKey.get(req);
    const cap = effectiveScope(role, req, policy, new Set([key]));
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
export const GROUP_LABEL: Readonly<Record<Group, string>> = {
  appointments: "Appointments",
  clients_identity: "Clients and identity",
  clinical_records: "Clinical records",
  communications: "Communications",
  payments: "Payments",
  pricing: "Pricing",
  availability: "Availability",
  reports: "Reports",
  waitlist_operations: "Waitlist operations",
  waitlist_rules: "Waitlist rules and automation",
  accepting_new_clients: "Accepting new clients",
  safety_records: "Safety records",
};
export function renderCatalogMarkdown(): string {
  const lines: string[] = [];
  for (const g of GROUPS) {
    lines.push(`### ${GROUP_LABEL[g]}`, "");
    lines.push("| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const d of (CATALOG as readonly PermissionDef[]).filter((x) => x.group === g)) {
      const gates = Object.entries(d.shipGate ?? {}).map(([r, g]) => `${r}: ${GATES[g as GateId]}`).join("; ") || "–";
      const off = ROLES.filter((r) => !d.offeredTo[r]).map((r) => `${r} not offered`);
      lines.push(
        `| \`${d.key}\`${d.ownerConfigurable ? "" : " (fixed)"}${off.length ? ` (${off.join(", ")})` : ""} | ${d.scopes.map((s) => LABEL[s]).join(" / ")} | ${d.requires.map((r) => `\`${r}\``).join(", ") || "–"} | ${LABEL[d.newStudioDefault.practitioner]} / ${LABEL[d.newStudioDefault.receptionist]} | ${LABEL[d.existingSnapshot.practitioner]} / ${LABEL[d.existingSnapshot.receptionist]} | ${d.snapshotBasis} | ${gates} | ${[...(d.pendingDecision ?? []), ...(d.touchedByDecision ?? []).map((x) => `${x} (coverage only)`)].join(", ") || "–"} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
