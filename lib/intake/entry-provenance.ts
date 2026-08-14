// Practitioner-assisted intake entry: the ONE authoritative provenance model.
//
// WHAT THIS RECORDS
// -----------------
// That a named, authenticated practitioner recorded the client's questionnaire
// answers while the client was with them, and when. It is stored under a
// single reserved key inside the existing `client_intake_forms.responses`
// jsonb, no column, no table, no migration.
//
// WHAT THIS DOES NOT RECORD, AND MUST NEVER BE READ AS
// ---------------------------------------------------
// It is NOT a claim about which physical human touched the device. The intake
// link is a bearer token; it proves possession, not identity. Nothing in Hone
// cryptographically proves the client personally ticked their own
// acknowledgements, and no copy derived from this module may say otherwise.
//
// What Hone can truthfully say, and what this module exists to make true:
//   1. the authenticated assisted editor CANNOT author the client's
//      acknowledgements (lib/intake/responses.ts strips them server-side);
//   2. assisted questionnaire entry is attributed to a specific practitioner,
//      derived from the session, never from the browser;
//   3. the public token path cannot create, replace or erase this record,
//      because the public sanitizer admits no key outside the questionnaire
//      set plus the one acknowledgement carve-out.
//
// WHY THE ACTOR NAME IS SNAPSHOTTED
// ---------------------------------
// `display_name` is frozen into the record at write time rather than resolved
// at read time. getPractitionersForStudio filters `.eq("active", true)`, so a
// later deactivation makes read-time resolution return null and attribution
// silently disappears, exactly what already happens to `reviewed_by` on this
// same page. A historical fact must not depend on a current lookup.
//
// WHY THIS IS NOT AN EVENT LEDGER
// -------------------------------
// Three timestamps and three actors, not an append-only list. It answers "who
// started, who last recorded, who handed over", which is what the review
// surface can truthfully narrate: without pretending a full audit history
// exists that the storage model cannot actually guarantee.

// The reserved response key. Deliberately outside ALL_QUESTION_KEYS; the
// invariant is pinned by tests/lib/intake/entry-provenance.test.ts so this can
// never become an ordinary questionnaire answer.
export const PRACTITIONER_ASSISTED_ENTRY = {
  id: "practitioner_assisted_entry",
  mode: "practitioner_assisted",
  version: "v1",
} as const;

export type AssistedActorSnapshot = {
  practitioner_id: string;
  display_name: string;
};

export type AssistedEntryRecord = {
  mode: string;
  version: string;
  started_at: string;
  started_by: AssistedActorSnapshot;
  last_updated_at: string;
  last_updated_by: AssistedActorSnapshot;
  handoff_at?: string;
  handoff_by?: AssistedActorSnapshot;
};

const MAX_FIELD_CHARS = 400;

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_FIELD_CHARS) return null;
  return trimmed;
}

function normalizeActor(value: unknown): AssistedActorSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const practitionerId = boundedString(raw.practitioner_id);
  const displayName = boundedString(raw.display_name);
  if (!practitionerId || !displayName) return null;
  return { practitioner_id: practitionerId, display_name: displayName };
}

// Truncate an actor snapshot to what this module's own parser will accept, so
// a value written here can always be read back.
function boundActor(actor: AssistedActorSnapshot): AssistedActorSnapshot {
  return {
    practitioner_id: actor.practitioner_id.slice(0, MAX_FIELD_CHARS),
    display_name: actor.display_name.trim().slice(0, MAX_FIELD_CHARS),
  };
}

// Parse a stored value into a record, or null when it is absent/malformed.
// Never throws. A malformed record is reported as such by the read side
// rather than being quietly treated as an ordinary assisted entry.
function parseStoredRecord(value: unknown): AssistedEntryRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.mode !== PRACTITIONER_ASSISTED_ENTRY.mode) return null;
  const version = boundedString(raw.version);
  const startedAt = boundedString(raw.started_at);
  const lastUpdatedAt = boundedString(raw.last_updated_at);
  const startedBy = normalizeActor(raw.started_by);
  const lastUpdatedBy = normalizeActor(raw.last_updated_by);
  if (!version || !startedAt || !lastUpdatedAt || !startedBy || !lastUpdatedBy) {
    return null;
  }
  const handoffAt = boundedString(raw.handoff_at);
  const handoffBy = normalizeActor(raw.handoff_by);
  const record: AssistedEntryRecord = {
    mode: PRACTITIONER_ASSISTED_ENTRY.mode,
    version,
    started_at: startedAt,
    started_by: startedBy,
    last_updated_at: lastUpdatedAt,
    last_updated_by: lastUpdatedBy,
  };
  // Both halves of the handoff move together; a lone timestamp with no actor
  // (or vice versa) is dropped rather than half-rendered.
  if (handoffAt && handoffBy) {
    record.handoff_at = handoffAt;
    record.handoff_by = handoffBy;
  }
  return record;
}

// Build the record to persist after a practitioner-assisted SAVE.
//
// `started_at` / `started_by` are preserved verbatim from any existing record,
// which is what makes the multi-practitioner case truthful: if A began the
// intake and B later continues it, the stored record still says A started and
// now says B last recorded. B never inherits A's attribution and A is never
// overwritten.
//
// An existing value that does not parse is treated as absent and replaced. It
// cannot arise from any application path: the public sanitizer cannot write
// this key and the assisted action always writes a well-formed record, so the
// only way to reach it is a direct database edit, and carrying arbitrary
// unparsed content forward inside a typed field would be worse than
// re-establishing a truthful one from this write.
export function recordAssistedEntry(
  existingValue: unknown,
  actor: AssistedActorSnapshot,
  nowIso: string,
): AssistedEntryRecord {
  const existing = parseStoredRecord(existingValue);
  // Bound the actor on the WRITE side too. Previously only the read side
  // applied MAX_FIELD_CHARS, so a display_name over the cap could be stored
  // and then be refused by this module's own parser: the record would read
  // back as "unreadable" and attribution would vanish.
  const safeActor = boundActor(actor);
  const base: AssistedEntryRecord = {
    mode: PRACTITIONER_ASSISTED_ENTRY.mode,
    version: PRACTITIONER_ASSISTED_ENTRY.version,
    started_at: existing?.started_at ?? nowIso,
    started_by: existing?.started_by ?? safeActor,
    last_updated_at: nowIso,
    last_updated_by: safeActor,
  };
  if (existing?.handoff_at && existing.handoff_by) {
    base.handoff_at = existing.handoff_at;
    base.handoff_by = existing.handoff_by;
  }
  return base;
}

// Stamp the handoff to the client.
//
// Returns null when there is no existing assisted record: a practitioner who
// opened the assisted editor and recorded nothing has not performed assisted
// entry, and inventing a provenance record for them would be a small lie. The
// caller treats null as "nothing to stamp" and proceeds with the handoff.
//
// Handoff deliberately does NOT touch `last_updated_*`: handing the device
// over is not recording an answer, and moving that field would misattribute
// the last recorded answers to whoever happened to click Hand to client.
export function recordAssistedHandoff(
  existingValue: unknown,
  actor: AssistedActorSnapshot,
  nowIso: string,
): AssistedEntryRecord | null {
  const existing = parseStoredRecord(existingValue);
  if (!existing) return null;
  return {
    ...existing,
    version: PRACTITIONER_ASSISTED_ENTRY.version,
    handoff_at: nowIso,
    handoff_by: boundActor(actor),
  };
}

// ---------------------------------------------------------------------------
// Read side (practitioner review)
// ---------------------------------------------------------------------------

export type AssistedEntryView =
  | { state: "none" }
  | {
      state: "assisted";
      version: string;
      startedAtIso: string;
      startedBy: AssistedActorSnapshot;
      lastUpdatedAtIso: string;
      lastUpdatedBy: AssistedActorSnapshot;
      handoffAtIso: string | null;
      handoffBy: AssistedActorSnapshot | null;
      // True when the "last recorded" line would add nothing: the same
      // practitioner AND the same instant. Comparing only the actor concealed
      // a later edit by the same practitioner, including one made AFTER the
      // handover, and implied a false chronology.
      showLastUpdated: boolean;
    }
  | { state: "unreadable" };

// Pure projection over a stored responses map. Tolerates a missing key, a
// malformed record and a legacy row; never throws and never writes. Mirrors
// the read-path posture of readElectrolysisAcknowledgement.
//
// `none` is the ordinary, self-completed intake. It is the overwhelming
// majority of rows and must render nothing at all on the review page: an
// intake the client filled in themselves carries no assisted badge.
export function readAssistedEntry(
  responses: Record<string, unknown> | null | undefined,
): AssistedEntryView {
  const map =
    responses && typeof responses === "object" && !Array.isArray(responses)
      ? (responses as Record<string, unknown>)
      : {};
  const raw = map[PRACTITIONER_ASSISTED_ENTRY.id];
  if (raw === undefined || raw === null) return { state: "none" };
  const record = parseStoredRecord(raw);
  if (!record) return { state: "unreadable" };
  return {
    state: "assisted",
    version: record.version,
    startedAtIso: record.started_at,
    startedBy: record.started_by,
    lastUpdatedAtIso: record.last_updated_at,
    lastUpdatedBy: record.last_updated_by,
    handoffAtIso: record.handoff_at ?? null,
    handoffBy: record.handoff_by ?? null,
    showLastUpdated:
      record.started_by.practitioner_id !== record.last_updated_by.practitioner_id ||
      record.last_updated_at !== record.started_at,
  };
}

// Practitioner-facing copy, centralized so no surface hand-writes a claim
// about who did what. Every string states what the stored row proves and
// stops there.
//
// Wording constraints this copy must keep satisfying:
//   - no "safe / unsafe / cleared / approved / contraindicat / diagnos"
//     (tests/app/clients/intake-review-flags.test.ts greps the review page);
//   - never "signed", "signature", "consent", or "on behalf of";
//   - never implies the client typed the answers, and never implies the
//     practitioner accepted anything on the client's behalf.
export const ASSISTED_ENTRY_REVIEW_COPY = {
  heading: "Intake entry",
  // Rendered with the practitioner name and date interpolated by the caller.
  assistedLead: "Questionnaire answers were recorded with the client by",
  // HEDGED DELIBERATELY. The record proves only that an authenticated
  // practitioner pressed "Hand to client". It does not observe the client
  // receiving anything, and the practitioner's own device is what navigates to
  // the client's link. Asserting the physical act here would be exactly the
  // overstatement this module's header forbids, in the one place a
  // practitioner judges who authored the acknowledgements.
  handedOver: "A handover to the client was recorded by",
  handedOverTail:
    "The acknowledgements themselves are recorded separately below.",
  notHandedOver:
    "No handover to the client has been recorded for this intake yet.",
  acknowledgementSeparate:
    "The acknowledgements on the final step are the client's own and are recorded separately below.",
  selfReviewed:
    "This intake was reviewed by the same practitioner who recorded the answers.",
  unreadable:
    "An intake entry record is present but could not be read. Treat the entry attribution for this intake as unknown.",
} as const;
