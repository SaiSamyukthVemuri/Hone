// Sam's section C (01-ops/ROLES-PERMISSIONS-BRIEF-20261102.md), written INDEPENDENTLY of the R0 catalog so a catalog that
// contradicts section C fails the run instead of being the oracle. Only what Sam stated is encoded; anything he did not state
// is absent here and is reported UNSPECIFIED by the cross-check, never guessed. My own ids (c.*) are mapped to the catalog's
// key names in CATALOG_KEY_MAP once R0 lands. Plan-stage: typechecked only, never run.

export type Scope = "off" | "own" | "studio" | "on"; // "on" for keys with no scope choice
export type StaffRole = "practitioner" | "receptionist";

// NEW-studio shipped defaults. null = Sam did not state a default for that role (cross-check reports it, does not fail).
export const SECTION_C_DEFAULTS: Record<string, { practitioner: Scope | null; receptionist: Scope | null; note?: string }> = {
  // C.3 financial (separate switches; practitioner own assigned, receptionist studio)
  // A4 answered (C.3/C.4): new-studio receptionist payment VIEW is ON, but gated (unusable) until the removal work + R-1 fix land.
  // The run asserts the default AND, while the gate is closed, that the capability is not usable (refused by direct call).
  "c.pay.view":            { practitioner: "own", receptionist: "studio", note: "A4: ON-but-gated until removal + R-1 fix; practitioner own is the pay-view scope in DN-10" },
  "c.pay.record_manual":   { practitioner: "own", receptionist: "studio" },
  "c.pay.charge_saved_card": { practitioner: "own", receptionist: "studio", note: "incl. authorized visit or policy-based fees" },
  "c.pay.refund":          { practitioner: "own", receptionist: "studio" },
  "c.pay.void_pending":    { practitioner: "own", receptionist: "studio" },
  "c.pay.correct_or_waive": { practitioner: "own", receptionist: "studio" },
  "c.price.appointment_price_discount": { practitioner: "own", receptionist: "studio" },
  "c.price.service_list":  { practitioner: "on", receptionist: "on", note: "studio-wide, label: affects future studio business" },
  "c.price.studio_fee_amounts": { practitioner: "on", receptionist: "on", note: "studio-wide, label: affects future studio business" },
  "c.reports.studio_totals": { practitioner: "off", receptionist: "off" },
  "c.reports.financial_reports": { practitioner: "off", receptionist: "off" },
  "c.reports.lifetime_spend": { practitioner: "off", receptionist: "off" },
  // C.4 practitioner
  "c.appt.view_calendar_studio": { practitioner: "on", receptionist: "on" },
  "c.appt.book_move_own":  { practitioner: "own", receptionist: null },
  "c.appt.book_move_reassign_colleague": { practitioner: "off", receptionist: null, note: "owner-configurable" },
  "c.appt.complete_own":   { practitioner: "own", receptionist: "off" },
  "c.appt.complete_colleague": { practitioner: "off", receptionist: "off", note: "owner-configurable with accurate attribution" },
  "c.appt.cancel_noshow_notes_aftercare_studio": { practitioner: "studio", receptionist: null, note: "practitioner: with reasons/history/delivery outcomes; receptionist aftercare is OFF (see c.clin.aftercare)" },
  "c.clin.view_records":   { practitioner: "on", receptionist: "off" },
  "c.clin.edit_records":   { practitioner: "on", receptionist: "off", note: "authorship + preserved versions" },
  "c.clin.photos":         { practitioner: null, receptionist: "off" },
  "c.clin.intake_answers": { practitioner: null, receptionist: "off" },
  "c.clin.aftercare":      { practitioner: null, receptionist: "off" },
  "c.ident.legal_name_view": { practitioner: "on", receptionist: "off", note: "practitioner via the protected identity flow" },
  "c.ident.legal_name_edit": { practitioner: "on", receptionist: "off", note: "practitioner via the protected identity flow; read and write are SEPARATE keys" },
  "c.avail.own":           { practitioner: "on", receptionist: null },
  "c.avail.others":        { practitioner: "off", receptionist: "off", note: "owner-configurable" },
  // C.4 receptionist
  "c.appt.book_move_reassign_cancel_noshow_studio": { practitioner: null, receptionist: "studio" },
  "c.clients.create_edit_contact_preferred_name": { practitioner: null, receptionist: "on" },
  "c.appt.scheduling_notes_and_operational_payment_info": { practitioner: null, receptionist: "on" },
  // C.4 both roles
  "c.comm.routine": { practitioner: "on", receptionist: "on", note: "within authorized scope" },
  "c.comm.bulk": { practitioner: "off", receptionist: "off", note: "owner-configurable with safeguards" },
  "c.clients.import": { practitioner: "off", receptionist: "off", note: "owner-configurable with safeguards" },
  "c.clients.merge": { practitioner: "off", receptionist: "off", note: "owner-configurable with safeguards" },
  "c.clients.bulk_export": { practitioner: "off", receptionist: "off", note: "owner-configurable with safeguards" },
  "c.consent.edit_templates": { practitioner: "off", receptionist: "off", note: "owner-configurable" },
  "c.audit.view_studio_log": { practitioner: "off", receptionist: "off", note: "never editable" },
};

// C.5 and section B: never delegable, never configurable, whatever the catalog says.
export const FIXED_OWNER_ONLY: string[] = [
  "manage roles, permissions or ownership",
  "payment-provider credentials, bank accounts or payouts",
  "studio or account deletion",
  "permanent deletion or bulk destructive actions",
  "deleting or altering audit history",
  "deleting treatment records or photos (this version)",
  "archiving clients (this version)",
  "restoring deleted records (this version)",
];

// Section B mandatory regardless of settings.
export const MANDATORY: string[] = ["studio isolation", "consent requirements", "payment authorization", "truthful clinical attribution"];

// Filled from the R0 typed source once it exists: my id -> catalog key name. Unmapped ids fail the cross-check.
// Filled 3 Nov against #1332 head 669b2602a (c.clin.aftercare added against d099042c), lib/permissions/catalog.ts (exact key names, read from the file). A compound id
// of mine maps to every catalog key it bundles; ALL must match. Ids with no clear catalog key stay unmapped on purpose.
export const CATALOG_KEY_MAP: Record<string, string | string[]> = {
  "c.pay.view": "pay.view_appointment",
  "c.pay.record_manual": "pay.record_external",
  "c.pay.charge_saved_card": "pay.charge_saved_card",
  "c.pay.refund": "pay.refund",
  "c.pay.void_pending": "pay.void",
  "c.pay.correct_or_waive": "pay.correct_or_waive",
  "c.price.appointment_price_discount": "price.appointment",
  "c.price.service_list": "price.service_list",
  "c.price.studio_fee_amounts": "price.fee_amounts",
  "c.reports.studio_totals": "rep.studio_totals",
  "c.reports.financial_reports": "rep.financial_reports",
  "c.reports.lifetime_spend": "rep.lifetime_spend",
  "c.appt.view_calendar_studio": "appt.view_calendar",
  "c.appt.book_move_own": ["appt.book", "appt.move"],
  "c.appt.complete_own": "appt.complete",
  "c.appt.cancel_noshow_notes_aftercare_studio": ["appt.cancel", "appt.mark_no_show", "appt.edit_notes", "appt.aftercare_send"],
  "c.appt.book_move_reassign_cancel_noshow_studio": ["appt.book", "appt.move", "appt.reassign", "appt.cancel", "appt.mark_no_show"],
  "c.clin.view_records": "clin.view_records",
  "c.clin.edit_records": "clin.edit_records",
  "c.clin.photos": "clin.view_photos",
  "c.clin.intake_answers": "clin.view_intake",
  "c.clin.aftercare": "clin.view_aftercare", // added by Team at #1332 d099042c (view-only; send stays appt.aftercare_send)
  "c.ident.legal_name_view": "client.view_legal_name",
  "c.ident.legal_name_edit": "client.edit_legal_name",
  "c.avail.own": "avail.manage_own",
  "c.avail.others": "avail.manage_others",
  "c.clients.create_edit_contact_preferred_name": ["client.create", "client.edit_contact"],
  "c.comm.routine": "comm.send_routine",
  "c.comm.bulk": "comm.bulk_message",
  "c.clients.import": "client.import",
  "c.clients.merge": "client.merge",
  "c.clients.bulk_export": "rep.bulk_export",
  "c.consent.edit_templates": "clin.edit_consent_templates",
  "c.audit.view_studio_log": "rep.audit_log_view",
  // Deliberately unmapped (no single clear catalog key; reported, never guessed): c.appt.book_move_reassign_colleague,
  // c.appt.complete_colleague, c.appt.scheduling_notes_and_operational_payment_info.
};

// My "on" (a key with no scope choice) is the catalog's "studio" (whole-studio scope); compare after normalising so a boolean
// key does not report a false contradiction. "own" and "off" stay distinct.
export function normScope(v: string): string { return v === "on" ? "studio" : v; }

export type CatalogShape = {
  keys: Record<string, { defaults: { practitioner: string; receptionist: string }; ownerOnly?: boolean }>;
  ownerOnly: string[];
};

/** Cross-check: returns contradictions (fail the run) and gaps (reported, not failures). */
export function crossCheckCatalog(catalog: CatalogShape): { contradictions: string[]; unmapped: string[]; unstated: string[] } {
  const contradictions: string[] = [];
  const unmapped: string[] = [];
  const unstated: string[] = [];
  for (const [id, want] of Object.entries(SECTION_C_DEFAULTS)) {
    const mapped = CATALOG_KEY_MAP[id];
    const keys = mapped === undefined ? [] : Array.isArray(mapped) ? mapped : [mapped];
    if (keys.length === 0 || keys.some((k) => !catalog.keys[k])) { unmapped.push(id); continue; }
    for (const role of ["practitioner", "receptionist"] as const) {
      const w = want[role];
      if (w === null) { unstated.push(`${id}/${role}`); continue; }
      for (const key of keys) {
        const got = catalog.keys[key].defaults[role];
        if (normScope(got) !== normScope(w)) contradictions.push(`${id} ${role}: section C says ${w}, catalog ${key} says ${got}`);
      }
    }
    for (const key of keys) if (catalog.keys[key].ownerOnly) contradictions.push(`${id} (${key}) is marked owner-only in the catalog but section C configures it`);
  }
  if (!catalog.ownerOnly || catalog.ownerOnly.length < FIXED_OWNER_ONLY.length) contradictions.push(`catalog fixed owner-only list has ${catalog.ownerOnly?.length ?? 0} entries, section C/B names ${FIXED_OWNER_ONLY.length}`);
  return { contradictions, unmapped, unstated };
}

// Sam's Roles decisions group 1 (01-ops/ROLES-DECISIONS-LOG.md, 2 Nov): build requirements that the R6 run asserts
// independently of the catalog. Each entry names the surface, the role(s) and the expected outcome. Nothing here activates anything.
export const DECISIONS_GROUP_1 = [
  { id: "DN-1", rule: "staff reports (when an owner permits) appear under a separate Reports entry; practitioners and receptionists never see Business", check: "nav of practitioner/receptionist has no Business entry or route access; Reports entry present only with the reports key ON" },
  { id: "DN-2", rule: "receptionists never see Business (not offered)", check: "receptionist nav and /business-class routes: absent and refused, even with every key ON" },
  { id: "DN-21", rule: "colleagues see display names and calendar colours only; private email, Google account email, pending invitations, personal/ops alerts are owner + that person only; feed tokens and hashes never in colleague listings or on the Roles page", check: "scan every channel of the Roles page and team listings as colleague for private emails, invitation emails, feed token and token-hash sentinels (SENTINELS.TOKEN); owner and self positive controls" },
  { id: "DN-27", rule: "staff read studio name, timezone and booking preferences needed for permitted work; fee amounts require the relevant payment/pricing permission", check: "without pay/price key: studio name/timezone visible, fee amount sentinels absent in all channels; with key: present" },
  { id: "DN-28", rule: "Getting Started shows only tasks the person has permission to perform", check: "Getting Started items for each role == tasks whose permission key is held; no task for a key held OFF" },
] as const;

// Sam's Roles decisions group 2 (ROLES-DECISIONS-LOG.md, 2 Nov): waitlist, accepting new clients, scheduling.
export const WAITLIST_ACTIONS = ["view-queue", "add", "import", "withdraw", "claim-release-requeue", "invite-one", "record-consent", "set-availability"] as const;
export const DECISIONS_GROUP_2 = [
  { id: "DN-15a", rule: "waitlist entry operations: receptionist ON (whole studio), practitioner OFF, owner-configurable; each of WAITLIST_ACTIONS separately configurable; import never implies consent and never sends a message; receptionist usable only when screen AND backend enforcement are ready", check: "per action x role matrix: toggling one action changes only that action; after import, zero consent rows and zero outbound messages (fake provider ledger empty); backend refuses an OFF action even by direct call" },
  { id: "DN-15b", rule: "waitlist rules/automation OFF for both staff roles; a permission never enables SMS and never overrides consent/opt-out", check: "with rules key ON for a staff role, SMS still off unless studio SMS is enabled by owner; opted-out client receives nothing; fake provider ledger asserts" },
  { id: "DN-4a", rule: "accepting-new-clients permission OFF for both staff roles; separate from the actual Open/Waitlist/Closed setting", check: "catalog has two distinct keys (change-admission-policy permission vs admission-state value); staff with permission ON can change state, with OFF cannot (direct call refused); changing the permission never changes the state" },
  { id: "DN-13", rule: "studio-wide opening hours is a SEPARATE key from managing colleagues' availability; both OFF; own availability stays separate; Q11 SETTLED: own availability for practitioners is ON for NEW studios and OFF for EXISTING studios until the owner adopts", check: "four-way matrix: studio-hours x colleagues-availability x own-availability; each key alone grants only its own writes (direct RPC calls); own-availability default asserted per policy state: NEW-DEFAULTS = on, EXISTING-SNAPSHOT = off until ADOPTED, then on" },
  { id: "DN-6", rule: "starting treatment follows completion scope; practitioners own assigned appointments by default; never grants receptionists clinical access; never auto-completes", check: "practitioner starts own, refused for colleague's unless scope widened; receptionist start refused and still no clinical sentinels; appointment status unchanged after start" },
  { id: "DN-4b", rule: "other studio administration owner-only this release (studio details, email/SMS toggles, tracking, Google destination, machines, onboarding)", check: "FIXED_OWNER_ONLY-style cells: every listed surface refused for non-owner with every key ON, route and direct call" },
] as const;

// Sam's Roles decisions group 3 (ROLES-DECISIONS-LOG.md, 2 Nov): clinical records and safety logs.
export const CLIENT_DATA_GROUPS = ["dob-address", "allergies-cautions", "budget-goals", "personal-notes", "tags", "appointment-health-fields"] as const;
export const DECISIONS_GROUP_3 = [
  { id: "DN-5", rule: "practitioner default = today's studio-wide access; view and edit separately configurable per CLIENT_DATA_GROUPS; receptionist OFF; owner may grant read-only per group without the full chart", check: "group x {view,edit} x role matrix; receptionist with read-only allergies sees allergy sentinel but no other group's sentinel and cannot edit (direct call refused); zero-change for existing practitioners" },
  { id: "DN-7", rule: "removing a pass/block/treated area is EDITING; original and version history preserved; whole-session deletion owner-only", check: "remove as editor -> prior version row exists and is readable by owner; edit key OFF -> refused; session delete by practitioner refused, owner allowed" },
  { id: "DN-8", rule: "performer change by owner or current performer only, with reason + audit; replacement must be an eligible same-studio practitioner; actual entering user preserved; signatures, attestations, payment history never rewritten; cannot bypass permissions", check: "colleague (non-performer, non-owner) refused; other-studio practitioner as replacement refused; missing reason refused; after change: entered-by unchanged, signature/attestation/payment rows byte-identical, audit row present; reassignment does not grant the new performer access beyond their own keys" },
  { id: "DN-12", rule: "undoing a recorded outcome owner-only with reason and history; never auto refunds, charges, erases treatment records, or reverses sent messages", check: "practitioner refused; owner with reason allowed; after undo: payment/charge rows, treatment records and message ledger unchanged (fake provider records zero new calls)" },
  { id: "DN-3", rule: "sterilisation/disinfection log and view are separate permissions, practitioner ON, receptionist OFF; exposure-incident history owner + reporter only", check: "Q10 SETTLED: view and add are separate permissions, both OFF for receptionists by default, and ADD REQUIRES VIEW: add-without-view is impossible (granting add without view is refused/auto-blocked, direct add by a view-less user refused); view-only grants only viewing; receptionist refused both; colleague non-reporter practitioner cannot read another's exposure incident (RBACZZ sentinel), owner and reporter can" },
  { id: "DN-24", rule: "ID portraits/photos owner-only and not delegable", check: "IDPHOTO sentinel absent for every non-owner with every key ON, including catalog attempts to grant (the catalog must not expose a delegable key)" },
] as const;

// Sam's Roles decisions group 4 (ROLES-DECISIONS-LOG.md): messaging, intake, portal, notifications.
export const DECISIONS_GROUP_4 = [
  { id: "G4-intake-resend", rule: "intake resend = messaging permission + intake STATUS read only; never answers or chart", check: "role with resend + status-only sees status, zero intake-answer/chart sentinels in any channel; without messaging key resend refused by direct call" },
  { id: "G4-portal-replies", rule: "practitioner ON within scope, receptionist OFF; sender recorded; history kept; client's original reply immutable", check: "receptionist reply refused; practitioner out of scope refused; sent reply row carries sender id; attempt to update/delete client's original reply refused for every role incl. owner; prior messages still listed" },
  { id: "G4-existing-studio", rule: "existing-studio practitioner access to sending portal/intake/aftercare links and reviewing intake is preserved and separately configurable", check: "EXISTING-SNAPSHOT policy: zero-expansion/zero-loss versus pre-roles behaviour for each of the four capabilities; toggling one leaves the other three unchanged" },
  { id: "G4-notifications", rule: "read state is per person; users change only their own and see only permitted ones", check: "A marks own notification read -> B's state unchanged; A cannot mark B's read (direct update refused); A does not receive a notification outside their permitted keys (HON44 L3 pattern)" },
  { id: "G4-sending", rule: "all sending respects consent, opt-outs and channel activation", check: "with every messaging key ON: opted-out client, no-consent client, and inactive channel each yield zero fake-provider calls and a recorded refusal reason" },
] as const;

// Sam's Roles decisions group 5 (ROLES-DECISIONS-LOG.md): card authorisation, client prices, card-to-book, late cancel.
export const DECISIONS_GROUP_5 = [
  { id: "G5-card-auth", rule: "card-authorisation consent readable via pay-view scope: only that payment's authorisation; no intake/clinical access; originals immutable", check: "scope follows pay-view: practitioner sees the authorisation only for payments on OWN appointments, receptionist studio-wide: default ON for new studios but GATED (A4 answered), so while the gate is closed a direct call is refused and no payment sentinel appears; never another payment's; zero INTAKE/CONSENT-form/CLIN sentinels; update/delete of the original refused for every role" },
  { id: "G5-client-prices", rule: "client-specific prices: separate set/change key, OFF for both staff roles; reads follow pay/price scope; changes recorded; existing appointment prices unchanged unless explicitly edited", check: "set refused without the key (direct call); read follows pay/price scope (NUMERIC_CENTS.clientPricingOverride absent without it); change writes an audit row; after a price change, prices_paid/appointment amounts on existing appointments byte-identical" },
  { id: "G5-card-to-book", rule: "require-card-to-book is an owner-only setting", check: "non-owner with every key ON refused by direct call and route; owner allowed; add to FIXED_OWNER_ONLY expectations" },
  { id: "G5-late-cancel", rule: "late-cancel window owner-configured, NO invented default, never auto-activated; server enforces eligibility from recorded cancel time + appointment time + the booking's policy snapshot; fee permission required; no duplicate charges; reason/history kept (held migration 0293, inside R3)", check: "fresh studio has no window value and no fee rows; client-side/tampered eligibility ignored; eligible (inside window by snapshot) vs not (outside) from DB times; later policy change does not alter an existing booking's snapshot; no fee permission -> refused; double submit and concurrent race (raceAll) -> exactly one charge; reason + history rows present; fake payment provider only" },
] as const;

// Sam's Roles decisions group 6 (ROLES-DECISIONS-LOG.md): archive/erasure, export, portal, legal-name keys.
export const DECISIONS_GROUP_6 = [
  { id: "G6-archive-delete-restore", rule: "archive/delete/restore owner-only at the enforcement release, with advance notice; recoverable; nothing deleted in rollout", check: "non-owner refused by direct call and route with every key ON; owner archive then restore returns identical row; row counts of all tables unchanged by the rollout itself; notice shown before enforcement" },
  { id: "G6-erasure", rule: "erasure workflow designed (request/review/confirm); execution UNAVAILABLE; no invented retention; no backup-erasure promise", check: "request and review states can be recorded; confirm/execute path refused or absent; zero rows deleted after a full workflow; UI/text contains no retention period or backup-erasure claim" },
  { id: "G6-export", rule: "owner export complete (intake, photos, messages, legal identity, consent, notes) minus credentials, payment secrets, other studios, platform security; files and links protected (short-lived, owner-scoped); staff exports separately permission-controlled and OFF by default", check: "owner export contains each included class (positive controls by sentinel) and none of: credential/payment-secret/XSTUDIO/ADMIN sentinels; export file/links require auth and are studio-scoped; staff export key OFF by default: practitioner/receptionist refused while OFF (direct call and link); allowed only if the owner grants it, content per Q19 (batch 3): explicit export key OFF by default AND access to every included row and field, re-checked at generation AND download; credentials, payment secrets and other studios always excluded; owner-export link per Q19b: 15 minutes, single owner session, re-checked on download, expired link refused" },
  { id: "G6-portal", rule: "portal setting owner-only, ON for existing studios; OFF blocks existing portal links and sessions; records kept; affected workflows explained; features independently controlled", check: "existing studio snapshot has portal ON; owner switches OFF -> an old portal cookie/link refused on next request, records still present, explanation shown; non-owner cannot switch; turning one portal feature off leaves the others" },
  { id: "G6-legal-name-keys", rule: "receptionist legal-name keys shown as 'Not available yet' until privacy enforcement + access logging are verified (legal-name switch stays OFF)", check: "Roles page shows the text 'Not available yet' and the control is not operable for receptionist; direct enabling refused; LEGAL sentinels absent for receptionist; preferred name / \"Name on file\" behaviour unchanged" },
] as const;

// Sam's Roles decisions group 7 (ROLES-DECISIONS-LOG.md, 3 Nov): platform and operations. The log is the single authority.
export const DECISIONS_GROUP_7 = [
  { id: "DN-16", rule: "Google Calendar feature flags operator-only, enforced in the database (guard); owners keep normal connect/disconnect", check: "owner and practitioner direct update of the flags refused at the DB (42501 or guard error); service/operator path allowed; owner connect/disconnect still works (fake Google only)" },
  { id: "G7-deactivated-owner", rule: "removed/deactivated calendar owner: stop new studio sync to that person; destination must be an active authorised owner; current owner notified to reconnect; other studios untouched; UI says copied events may remain", check: "after removal: zero new sync jobs to the removed person; destination validation refuses a non-owner/inactive person; a notification row for the current owner; other studio's connection rows byte-identical; explanatory text present; no external event deleted" },
  { id: "DN-29", rule: "rate-limit outage: token/link ops (intake, manage booking, invitation, portal sign-in) refuse safely with a clear retry message; public booking only with bounded fallback; operator alert without client data or secret links", check: "inject limiter failure: each of the four token ops refused with retry message and no state change; public booking still works but fallback per Q3: 5 attempts per visitor per 10 min and 30 per studio per hour, ATTEMPTS counted incl. failures, operator-configurable (not an owner setting); concurrent requests and multiple app instances both bounded; if the shared fallback cannot enforce a bound, submissions are refused safely; alert row/log contains no CLIENT sentinels and no token/link (scan)" },
  { id: "G7-anon-writes", rule: "anonymous waitlist/demo direct DB writes closed; validated server endpoints with rate and quantity limits; public sign-up still works; no privileged key reaches the browser", check: "anon/authenticated direct insert on the waitlist and demo tables refused (42501); normal public sign-up via the endpoint succeeds; over-limit and malformed payloads refused (limits per Q21: 5 attempts/visitor/hour and 3/email/day, failures counted, one active entry per email per studio with a neutral repeat response, operator-configurable); scan every browser-received channel and bundle for the service-role key (never present)" },
  { id: "DN-17", rule: "SMS STOP: current opt-outs retained; Twilio investigated before any change; no activation or messages authorized", check: "existing opt-out rows unchanged by the Roles work; fake provider receives zero sends to opted-out numbers; nothing enables SMS" },
] as const;

// Open ambiguities found in the reconciliation pass against the log. Never defaulted: each is reported to OPS as a question.
export const OPEN_AMBIGUITIES = [] as const; // all reconciliation questions decided (batch 3, 3 Nov); new ones found in implementation are reported to OPS, never defaulted

// Batch 1 (ACCEPTED by Sam, 3 Nov; ROLES-DECISIONS-LOG.md "Open ambiguities" > Batch 1).
export const DECISIONS_BATCH_1 = [
  { id: "Q1", rule: "late-cancellation window: whole hours 1-168, UNSET by default; unset = late-cancellation charging unavailable; policy shown to owner before enabling", check: "fresh studio: window null and charging refused by direct call; 0, 169, 1.5 and negative refused; 1 and 168 accepted; set -> eligibility from the booking's snapshot; policy text shown before enable" },
  { id: "Q3", rule: "limiter outage fallback: 5 attempts/visitor/10 min and 30/studio/hour, operator-configurable, attempts counted incl. failures; tested with concurrent requests and multiple app instances; fail closed if no shared bound; operator alert without client data", check: "inject limiter failure; 6th attempt from one visitor in 10 min refused; 31st in an hour for a studio refused; raceAll across two app instances never exceeds the bound; shared store down -> safe refusal; alert has no CLIENT/TOKEN sentinels" },
  { id: "Q4", rule: "client-detail groups: safety (allergies+cautions together, apart from clinical record); personal (DOB, birthday, address); pronouns with display/contact identity (NOT legal-name access); clinical record (skin type, skin notes, treatment goals); budget, personal notes, tags, appointment health notes each their own group; no silent broadening of receptionist access; never bundle budget or personal notes into another grant", check: "per-group view/edit matrix over exactly these groups (replaces CLIENT_DATA_GROUPS); granting safety read-only to a receptionist exposes allergy+caution sentinels only; granting any group never exposes budget or personal-notes sentinels unless their own group is granted; pronouns grant exposes no LEGAL sentinel" },
  { id: "Q6", rule: "portal replies: whole-studio AND assigned-client scopes; existing studios keep approved current access; assigned-client scope usable only after 'assigned client' is precisely defined and the explanation shown to owners", check: "whole-studio scope works; assigned-client scope now DEFINED by batch 4 item 1 (see B4-assigned-client-last/-two/-studio-control); report NOT RUN until the definition is shown to owners beside the option and enforcement exists; existing-studio practitioner access unchanged" },
  { id: "Q7", rule: "client-specific pricing: whole-studio scope only; OFF by default for both staff roles; owner-configurable; grants no other pricing or payment permission", check: "no 'own' scope offered; default off; with it ON, no other pricing/payment action becomes allowed (direct calls)" },
] as const;

// Sam's reporting rule (3 Nov): a check is NOT RUN or BLOCKED until it exercises the REAL enforcement path (real session,
// real server action/route/RPC against the real database). Catalog-only, mock-only or source-pattern checks never count as a pass.
export type CheckStatus = "PASS" | "FAIL" | "NOT RUN" | "BLOCKED";
export type CheckResult = { id: string; status: CheckStatus; realEnforcementPath: boolean; blockedBy?: string };
export function reportStatus(r: CheckResult): CheckStatus {
  if (r.status === "PASS" && !r.realEnforcementPath) return "NOT RUN"; // a pass off the real path is not a pass
  return r.status;
}

// Batch 2 (ACCEPTED by Sam, 3 Nov; ROLES-DECISIONS-LOG.md "Batch 2"). All checks NOT RUN until the real enforcement path exists.
export const RECEPTIONIST_VIEW_ONLY = ["records", "photos", "intake-answers", "aftercare"] as const;
export const DECISIONS_BATCH_2 = [
  { id: "Q10", rule: "receptionist sterilisation-log VIEW and ADD are separate, both OFF by default; adding requires viewing; exposure incidents stay owner + reporter, never broadened", check: "defaults both off; view-only works and add refused; add key without view refused or impossible; exposure-incident sentinel absent for receptionist and non-reporter colleague with every key ON; owner and reporter positive controls" },
  { id: "Q16", rule: "receptionist clinical: separate VIEW-ONLY switches this release (RECEPTIONIST_VIEW_ONLY), each OFF by default; no editing, printing or treatment completion; ID photos and legal identity restrictions preserved", check: "each of the four switches alone exposes only its own sentinels and nothing else; edit, print, complete, upload by direct call refused even with all four ON; IDPHOTO and LEGAL sentinels absent; no 'edit/print/complete' key offered to receptionist in the catalog" },
  { id: "Q14", rule: "practitioners may read PUBLISHED service prices needed for booking; must not expose private financial settings or client-specific prices outside their permitted scope; fee amounts must not be widened beyond today's behaviour until Q14b", check: "PUBLISHED_SERVICE name+price present for practitioner on booking; unpublished service price, client pricing override and settlement/fee sentinels (NUMERIC_CENTS) absent; fee-amount reads: SUPERSEDED by Q14b (batch 3): staff may read the fee amounts clients actually see when booking, and no other fee/financial amounts" },
  { id: "Q25", rule: "studio totals and individual payment access are INDEPENDENT permissions (no prerequisite either way); reports must not leak individual payment details", check: "four combinations of totals x payment-detail: totals-only role sees totals and no per-payment sentinel (CHG/charge cents, card); payment-detail-only role sees payments and not totals; reports/exports scanned for individual payment details" },
  { id: "Q9", rule: "outcome corrections (DN-12): owner-only; no arbitrary time limit; reason required; history preserved; never reverses payments, erases treatment records or resends messages; outcomes = completion, no-show, cancellation; settlement goes through refund or correction", check: "non-owner refused; no reason refused; correction of an old outcome (e.g. months back) still allowed; history row kept; payments, treatment records and message ledger unchanged; correcting a settlement outcome is routed to refund/correction, not undo" },
  { id: "Q17", rule: "handing an appointment to a colleague: OFF by default, owner-configurable; eligible recipient, studio boundaries, and restrictions for appointments already started or treated", check: "default off, direct call refused; with key ON: same-studio eligible colleague allowed, other-studio recipient refused, ineligible recipient refused (eligibility per A6, batch 3: active practitioner, same studio, configured for the service), started or treated appointment refused; reassignment grants nothing beyond the recipient's own keys" },
] as const;

// Batch 3 (ACCEPTED by Sam, 3 Nov; ROLES-DECISIONS-LOG.md "Batch 3"). All NOT RUN until the real enforcement path exists.
export const DECISIONS_BATCH_3 = [
  { id: "Q8", rule: "waitlist: expiring/closing unbooked entries is a permission SEPARATE from claim/release/requeue ('claim next N' rides with claim); EVERY waitlist action requires queue-view access; imports never create consent or send messages", check: "expire/close key alone does not allow claim and vice versa; 'claim next N' allowed with claim key only; any action by a role without queue view refused (direct call) even with the action key ON; import leaves zero consent rows and zero fake-provider sends" },
  { id: "Q12", rule: "booking rules cover booking windows and new-client rules ONLY; studio identity (web address, timezone, address, intro) and service duration/buffers stay under their own controls", check: "holder of the booking-rules key can change windows/new-client rules and is refused on studio identity fields and service duration/buffers; the reverse holders are refused on booking rules" },
  { id: "Q14b", rule: "staff may READ fee amounts clients actually see when booking; changing fees requires price.fee_amounts; private financial settings restricted", check: "practitioner/receptionist read booking-visible fee amounts; refused on change without the key (direct call); allowed with it; private financial settings sentinels (NUMERIC_CENTS charge/settlement/unpublished) still absent" },
  { id: "Q18", rule: "erasure requests owner-only, tracked and audited; UI states recording a request deletes nothing and execution remains unavailable; tracked request needs a held table (number claimed when built)", check: "non-owner cannot record or view requests; owner request writes an audit row; zero rows deleted; text states 'deletes nothing' and 'execution unavailable'; BLOCKED until the held table exists" },
  { id: "Q19", rule: "staff export requires an explicit export key (OFF by default) PLUS access to every included row and field; permissions re-checked at generation AND at download; credentials, payment secrets and other studios always excluded; owner link lifetime 15 min", check: "key OFF -> refused; key ON but missing access to one included field/row class -> export refused or that class absent (never leaked); revoke the key or a field permission between generation and download -> download refused; expired link refused; CRED/payment-secret/XSTUDIO sentinels never present" },
  { id: "Q20", rule: "portal OFF: existing portal links and sessions blocked on their NEXT request incl. messaging, rebooking and card saving; records preserved; independent intake and consent flows keep working but their links must not bypass the portal restriction; affected workflows explained to the owner before confirmation", check: "with portal OFF: old portal cookie and link refused for messages, rebooking and card save on the next request; an INTAKE link and a CONSENT link still complete their own flow AND, when used to request portal features (portal routes/actions/RSC, messaging, rebooking, card save, session creation from the link), are refused; records unchanged; explanation shown before the confirm step. Turn portal back ON restores access only where permitted" },
  { id: "Q22-A7", rule: "calendar: if no active owner remains, studio sync pauses and the operator is alerted without client data; resumes only after an active owner EXPLICITLY reconnects; other studios' connections preserved", check: "remove the only active owner: sync jobs stop (zero new jobs), operator alert row without CLIENT/TOKEN sentinels; no auto-resume when a new owner is added until that owner reconnects; other studio's connection rows byte-identical (fake Google only)" },
  { id: "Q23-A8", rule: "exposure incidents: a removed reporter loses access through that studio; the owner retains access", check: "after the reporter is removed from the studio their session/JWT is refused for the incident (and overlapping memberships in other studios do not carry access); owner still reads it" },
  { id: "A6", rule: "reassignment recipient (DN-8, Q17): an ACTIVE practitioner in the SAME studio configured for the service; started/treated restrictions preserved; historical attribution corrections follow their own audited rules (group 3)", check: "recipient inactive, other-studio, or not configured for the service -> refused; active same-studio configured -> allowed; started/treated appointment refused" },
  { id: "DN-29-alert", rule: "outage alert: integration with the EXISTING Sentry project prepared with a test plan and no sensitive data; any hosted configuration (alert rule) goes to Sam separately", check: "event payload scanned for CLIENT/TOKEN sentinels; fenced local run only (Sentry egress fence refuses real send); hosted alert rule is NOT in scope: BLOCKED pending Sam" },
] as const;

// Batch 4 (ACCEPTED by Sam, 3 Nov; ROLES-DECISIONS-LOG.md "Batch 4"). All NOT RUN until the real enforcement path exists.
export const PLACEHOLDER_REASONS = ["", " ", "   ", "x", "n/a", "N/A", "na", "none", "test", "asdf", "...", "-", "ok", "reason", "TBD", "tbd", "xxx", "aaaa", "1234"] as const;
export const DECISIONS_BATCH_4 = [
  { id: "B4-assigned-client-last", rule: "assigned client (Q6 own scope, B-2 own scope), Batch 4 clarification: the former practitioner is denied ONLY when no other qualifying appointment (non-cancelled, past or upcoming, this studio, currently theirs) still links them to that client AND no broader studio-wide permission applies; CURRENT assignment evaluated on the server; the relationship alone grants NO additional clinical access; definition shown to owners beside the option", check: "(1) P1 has exactly ONE qualifying appointment with client C; reassign it to P2 -> P1's very next request (same cookie, no re-login) refused for C incl. portal reply and client-price view; also a remaining CANCELLED appointment does not count, nor one in another studio; no CLIN/ALLERGY/INTAKE/NOTE sentinel for P1 afterwards" },
  { id: "B4-assigned-client-two", rule: "same rule: moving one of TWO qualifying appointments does not remove the link", check: "(2) P1 has TWO qualifying appointments with C (one past non-cancelled, one upcoming; repeat with both upcoming); reassign one -> P1 still allowed on the very next request; reassign the second -> now refused (same as 1); relationship still grants no clinical sentinels" },
  { id: "B4-assigned-client-studio-control", rule: "same rule: a broader studio-wide permission still applies", check: "(3) control: P1 with the whole-studio scope for the same key still allowed for C after their LAST qualifying appointment is moved; proves the denial in (1) comes from the own-scope rule and not from a broken fixture" },
  { id: "B4-wlrules", rule: "waitlist rules/automation: changing settings alone does NOT require queue-view; any action that reads or changes individual entries still requires the relevant entry permissions", check: "role with wlrules key and NO wl.view_queue can change the rules settings (direct call) and cannot read or change any individual entry (refused); with entry permission but no wlrules, rules refused; no entry-level sentinel on the rules screen" },
  { id: "B4-directory", rule: "client directory (B-1): names and basic contact details are a FIXED BASELINE for ACTIVE practitioners and receptionists in that studio; preferred-name / Name on file privacy preserved; grants no legal identity, clinical information, bulk export or other-studio access", check: "ACTIVE practitioner and receptionist read names + basic contact; invited-pending, removed and deactivated staff refused; other-studio staff refused; LEGAL, CLIN, ALLERGY, DOB/ADDR and export sentinels absent from directory, search, autocomplete and RSC; client with preferred name shows preferred, otherwise 'Name on file' (STORED sentinel absent)" },
  { id: "B4-labels", rule: "'Affects future studio business' label on service prices, fees, studio hours, waitlist rules and admission rules, with the SPECIFIC effect explained beside each setting", check: "Roles page and settings pages: label present on exactly those five settings and absent elsewhere; each has a specific effect sentence (non-generic, differs per setting)" },
  { id: "B4-reasons", rule: "reason REQUIRED when adopting defaults, resetting saved permissions, or expanding sensitive access (incl. widening scope); non-empty meaningful text; blank and placeholder-only text rejected; character minimum not treated as proof; review step asks the why; other changes OPTIONAL reason; before/after recorded automatically in every case", check: "adopt, reset and sensitive widening each refused (server, direct call, not only UI) for every PLACEHOLDER_REASONS value and whitespace-only; a meaningful reason accepted and stored in the audit row; non-sensitive change saves with no reason; before/after diff row exists in all cases; a long string of one repeated character is not accepted merely for its length" },
  { id: "B4-aftercare-view", rule: "receptionist VIEW-aftercare permission separate from sending aftercare (batch 2 Q16)", check: "view-only receptionist reads aftercare and cannot send; send key alone does not grant view; BLOCKED for mapping until Team adds the key" },
  { id: "B4-bundled-mappings", rule: "the three bundled mappings (colleague book/move/reassign; complete a colleague's treatment; receptionist scheduling notes + operational payment info) are resolved WITHOUT broadening access", check: "BLOCKED until Team names keys/scopes; then: cross-check shows no default wider than before; scheduling-notes view exposes no clinical-note sentinel" },
] as const;
