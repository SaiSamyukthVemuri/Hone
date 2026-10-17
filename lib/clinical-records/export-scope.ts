import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";
import { blockAreasLabel, type BlockArea } from "@/lib/sessions/block-areas";
import { legacyBlockReactionLabel } from "@/lib/sessions/reaction-unified";
import { hasStructuredReadings } from "@/lib/sessions/structured-readings";

// ===========================================================================
// HON-46 — what a per-client clinical-records export contains, as pure code.
// ===========================================================================
//
// One client, one of three scopes (a session, a studio-local day, or a
// studio-local date range), rendered in the authenticated app for printing.
//
// THE DOCUMENT IS BUILT BY ALLOW-LIST. `buildClinicalRecordsDocument` copies
// named fields out of its inputs; it never spreads a row. So a column the
// query happens to return, or one added to a table later, cannot reach the
// page by accident. The exclusions below are enforced twice: the server query
// (lib/clinical-records/export-queries.ts) never selects them, and this
// builder would drop them anyway.
//
// NEVER INCLUDED (and said so on the page, per #828 F18/G-21):
//   * private warnings and personal notes: they live only in
//     client_personal_notes, which the export never reads;
//   * payment records (session price paid, charges, settlements);
//   * intake forms, consent forms, photos and treatment images: not in this
//     slice (HON-46 decision D4 is open), so the page states they are absent
//     rather than implying a complete record;
//   * the next-session planning note, deleted sessions/entries, and deletion
//     reasons.

export type ExportScope =
  | { kind: "session"; sessionId: string }
  | { kind: "day"; day: string }
  | { kind: "range"; from: string; to: string };

export type ScopeParse =
  | { ok: true; scope: ExportScope }
  | { ok: false; reason: "missing" | "invalid" | "range_too_long" };

/** Longest range one export may cover, inclusive of both ends. */
export const MAX_RANGE_DAYS = 366;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRealDay(s: string | undefined): s is string {
  if (!s || !DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function daysBetweenInclusive(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** Read the scope from the page's search params. Never throws. */
export function parseExportScope(raw: {
  scope?: string;
  session?: string;
  day?: string;
  from?: string;
  to?: string;
}): ScopeParse {
  if (!raw.scope) return { ok: false, reason: "missing" };
  if (raw.scope === "session") {
    return raw.session && UUID.test(raw.session)
      ? { ok: true, scope: { kind: "session", sessionId: raw.session.toLowerCase() } }
      : { ok: false, reason: "invalid" };
  }
  if (raw.scope === "day") {
    return isRealDay(raw.day)
      ? { ok: true, scope: { kind: "day", day: raw.day } }
      : { ok: false, reason: "invalid" };
  }
  if (raw.scope === "range") {
    if (!isRealDay(raw.from) || !isRealDay(raw.to) || raw.from > raw.to) {
      return { ok: false, reason: "invalid" };
    }
    if (daysBetweenInclusive(raw.from, raw.to) > MAX_RANGE_DAYS) {
      return { ok: false, reason: "range_too_long" };
    }
    return { ok: true, scope: { kind: "range", from: raw.from, to: raw.to } };
  }
  return { ok: false, reason: "invalid" };
}

/**
 * UTC bounds for a studio-local day or range: from 00:00 on the first day up
 * to (not including) 00:00 the day after the last. The same convention as the
 * Records print view (lib/record-keeping/queries.ts utcInstantsForLocalDayRange).
 */
export function localDayBounds(
  from: string,
  to: string,
  timezone: string,
): { fromUtc: string; toUtcExclusive: string } {
  return {
    fromUtc: utcInstantFromLocal(from, "00:00", timezone).toISOString(),
    toUtcExclusive: utcInstantFromLocal(addDays(to, 1), "00:00", timezone).toISOString(),
  };
}

/**
 * Bounds for CALENDAR-DATE columns (Codex P1 4302644059). A clinical note's
 * occurred_at comes from <input type="date"> and is stored as MIDNIGHT UTC of
 * that civil date (see lib/clinical-notes/clinical-date.ts), so it must be
 * filtered by its YYYY-MM-DD, never through studio-local instant bounds, which
 * shift it a day in every negative UTC offset.
 */
export function civilDayBounds(from: string, to: string): { fromUtc: string; toUtcExclusive: string } {
  return { fromUtc: `${from}T00:00:00.000Z`, toUtcExclusive: `${addDays(to, 1)}T00:00:00.000Z` };
}

/** Audit metadata for a scope: what was looked at, never a name or a note. */
export function scopeAuditMetadata(scope: ExportScope): Record<string, string> {
  if (scope.kind === "session") return { scope: "session", session_id: scope.sessionId };
  if (scope.kind === "day") return { scope: "day", day: scope.day };
  return { scope: "range", from: scope.from, to: scope.to };
}

/** What the page says is NOT in the document. Rendered verbatim. */
export const EXPORT_EXCLUSIONS: readonly string[] = [
  "Private warnings and personal notes about the client",
  "Payment records (prices, charges, payments and balances)",
  "Intake forms and medical history",
  "Consent forms",
  "Photos and treatment images",
  "Next-session planning notes",
  "Deleted sessions, settings blocks and entries",
];

// ---- Sources: exactly what the server query selects ------------------------

export type ExportSessionSource = {
  id: string;
  started_at: string;
  ended_at: string | null;
  modality: string | null;
  session_notes: string | null;
  performed_by_practitioner_id: string | null;
  practitioner_id: string | null;
  record_status: string | null;
  finalized_at: string | null;
  aftercare_and_risks_explained_at: string | null;
};

/**
 * A settings block: where the current, area-first charting flow records the
 * area, the machine settings, the structured probe and the per-area clinical
 * observations (Codex P1 4301165385). Entries hang off a block by block_id.
 */
export type ExportBlockSource = {
  id: string;
  session_id: string;
  sort_order: number | null;
  block_name: string | null;
  primary_area: string | null;
  side: string | null;
  custom_area_detail: string | null;
  mode: string | null;
  apilus_modality: string | null;
  energy_level: string | number | null;
  minutes_performed: number | null;
  machine_frequency: string | null;
  probe_label: string | null;
  probe_type: string | null;
  probe_size: string | null;
  probe_lot_number: string | null;
  probe_lot_confirmed: boolean | null;
  numbing_status: string | null;
  numbing_notes: string | null;
  tolerance_rating: number | null;
  reaction_type: string | null;
  reaction_notes: string | null;
  caution_note: string | null;
  caution_for_next_session: boolean | null;
  block_notes: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
};

export type ExportEntrySource = {
  id: string;
  session_id: string;
  block_id: string | null;
  area: string | null;
  areas: string[] | null;
  probe_type: string | null;
  probe_size: string | null;
  mode: string | null;
  apilus_modality: string | null;
  // Legacy generic readings (older charting).
  intensity: string | number | null;
  duration_seconds: number | null;
  // Current readings.
  energy_level: string | number | null;
  machine_frequency: string | null;
  thermolysis_intensity_percent: number | null;
  thermolysis_duration_seconds: number | null;
  galvanic_ma: number | null;
  galvanic_duration_seconds: number | null;
  // NOT galvanic_intensity_percent: a RETIRED reading (Codex P1 4303753479).
  // The live chart omits it from every clinical display so it can't be read
  // as a current setting (components/entry-row.tsx, "Galvanic intensity % is
  // a DEPRECATED reading"; Policy A in docs/runbooks/
  // chloe-charting-unification-rollout.md). It stays only in the raw data
  // export, so this printout never even selects it.
  units_of_lye: number | null;
  pulse_delay_seconds: number | null;
  minutes_performed: number | null;
  pulse_count: number | null;
  hairs_treated: number | null;
  observation_chips: string[] | null;
  comments: string | null;
  created_at: string;
};

/** A laser treatment pass (laser_entries; Codex P1 4301153312). */
export type ExportLaserSource = {
  id: string;
  session_id: string;
  zone: string;
  session_number: number | null;
  equipment_params: Record<string, unknown> | null;
  observation_notes: string | null;
  ejection_results: string | null;
  created_at: string;
};

export type ExportNoteSource = {
  id: string;
  kind: string;
  body: string;
  areas: string[] | null;
  occurred_at: string;
  practitioner_id: string | null;
  supersedes_note_id: string | null;
  created_at: string;
};

// ---- The document -----------------------------------------------------------

/** One labelled value, already formatted. Only present values are emitted. */
export type Reading = { label: string; value: string };

export type ExportedEntry = {
  id: string;
  areas: string[];
  readings: Reading[];
  observations: string[];
  comments: string | null;
};

export type ExportedBlock = {
  id: string;
  title: string;
  readings: Reading[];
  notes: Reading[];
  entries: ExportedEntry[];
};

export type ClinicalRecordsDocument = {
  sessions: Array<{
    id: string;
    startedAt: string;
    endedAt: string | null;
    modality: string | null;
    practitioner: string | null;
    notes: string | null;
    recordStatus: string | null;
    finalizedAt: string | null;
    aftercareExplainedAt: string | null;
    /** Settings blocks (current charting), each with the entries charted in it. */
    blocks: ExportedBlock[];
    /** Entries not attached to a block (older charting). */
    entries: ExportedEntry[];
    /** Laser treatment passes. */
    laserEntries: Array<{ id: string; zone: string; readings: Reading[]; notes: Reading[] }>;
  }>;
  clinicalNotes: Array<{
    id: string;
    kind: string;
    body: string;
    areas: string[];
    occurredAt: string;
    practitioner: string | null;
    isRevision: boolean;
    /** A later version replaces this one; it is NOT the current note. */
    isSuperseded: boolean;
  }>;
};

function present(v: unknown): v is string | number {
  return (typeof v === "string" && v.trim().length > 0) || (typeof v === "number" && Number.isFinite(v));
}

/** Allow-listed label/value pairs: a label is emitted only when its value exists. */
function readings(pairs: Array<[string, unknown, string?]>): Reading[] {
  const out: Reading[] = [];
  for (const [label, value, unit] of pairs) {
    if (present(value)) out.push({ label, value: unit ? `${value} ${unit}` : String(value) });
  }
  return out;
}

function exportEntry(e: ExportEntrySource): ExportedEntry {
  // STRUCTURED readings make the legacy generic intensity/duration stale: a
  // legacy row edited through structured charting keeps the old pair beside
  // the new fields. Suppressed by the SAME rule as the saved-record view
  // (lib/sessions/structured-readings.ts; Codex P1 4304983088).
  const legacyPair = !hasStructuredReadings(e);
  return {
    id: e.id,
    areas: e.areas && e.areas.length > 0 ? [...e.areas] : e.area ? [e.area] : [],
    readings: readings([
      ["Mode", e.mode],
      ["Apilus modality", e.apilus_modality],
      ["Probe", [e.probe_type, e.probe_size].filter(Boolean).join(" ")],
      ["Energy level", e.energy_level],
      ["Machine frequency", e.machine_frequency],
      ["Thermolysis intensity", e.thermolysis_intensity_percent, "%"],
      ["Thermolysis duration", e.thermolysis_duration_seconds, "s"],
      ["Galvanic current", e.galvanic_ma, "mA"],
      ["Galvanic duration", e.galvanic_duration_seconds, "s"],
      ["Units of lye", e.units_of_lye],
      ["Pulse delay", e.pulse_delay_seconds, "s"],
      ["Intensity", legacyPair ? e.intensity : null],
      ["Duration", legacyPair ? e.duration_seconds : null, "s"],
      ["Minutes performed", e.minutes_performed, "min"],
      ["Pulses", e.pulse_count],
      ["Hairs treated", e.hairs_treated],
    ]),
    observations: Array.isArray(e.observation_chips)
      ? (e.observation_chips as unknown[]).filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : [],
    comments: e.comments,
  };
}

/**
 * A block's treated areas, through the SINGLE display contract every clinical
 * surface uses (Codex P1 4301307238): structured session_block_areas rows win,
 * otherwise the legacy primary_area + side. Custom detail is appended.
 */
/** Equipment parameters are free-form: only plain string/number values are shown. */
function equipmentReadings(params: Record<string, unknown> | null): Reading[] {
  if (!params || typeof params !== "object" || Array.isArray(params)) return [];
  return readings(
    Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key.replace(/_/g, " "), value] as [string, unknown]),
  );
}

function exportLaser(l: ExportLaserSource) {
  return {
    id: l.id,
    zone: l.zone,
    readings: [...readings([["Session number", l.session_number]]), ...equipmentReadings(l.equipment_params)],
    notes: readings([
      ["Observations", l.observation_notes],
      ["Results", l.ejection_results],
    ]),
  };
}

function blockTitle(b: ExportBlockSource, structured: ReadonlyArray<BlockArea> | undefined): string {
  const areas = blockAreasLabel(structured ?? null, { primary_area: b.primary_area, side: b.side });
  const base = areas ?? (present(b.block_name) ? b.block_name : null);
  if (!base) return present(b.custom_area_detail) ? b.custom_area_detail : "Area not recorded";
  return present(b.custom_area_detail) ? `${base} (${b.custom_area_detail})` : base;
}

export function buildClinicalRecordsDocument(input: {
  sessions: ReadonlyArray<ExportSessionSource>;
  blocks?: ReadonlyArray<ExportBlockSource>;
  /** Structured treated areas per block id (session_block_areas). */
  blockAreasById?: ReadonlyMap<string, ReadonlyArray<BlockArea>>;
  entries: ReadonlyArray<ExportEntrySource>;
  laserEntries?: ReadonlyArray<ExportLaserSource>;
  notes: ReadonlyArray<ExportNoteSource>;
  /**
   * Ids of notes some OTHER note supersedes, across the client's FULL note
   * history (a revision may be dated outside the exported range).
   */
  supersededNoteIds?: ReadonlySet<string>;
  practitionerNameById: ReadonlyMap<string, string>;
}): ClinicalRecordsDocument {
  const name = (id: string | null) => (id ? (input.practitionerNameById.get(id) ?? null) : null);
  const blocks = input.blocks ?? [];
  const blockIds = new Set(blocks.map((b) => b.id));
  const byCreated = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);

  const entriesByBlock = new Map<string, ExportEntrySource[]>();
  const looseBySession = new Map<string, ExportEntrySource[]>();
  for (const e of input.entries) {
    if (e.block_id === null || e.block_id === undefined || e.block_id === "") {
      // Only a TRUE legacy entry (no block at all) prints at session level.
      looseBySession.set(e.session_id, [...(looseBySession.get(e.session_id) ?? []), e]);
    } else if (blockIds.has(e.block_id)) {
      entriesByBlock.set(e.block_id, [...(entriesByBlock.get(e.block_id) ?? []), e]);
    }
    // Otherwise the entry belongs to a block that was filtered out (soft-
    // deleted; its children may still be active) and is OMITTED, as the
    // session loader omits it (Codex P1 4302941115). It must never resurface
    // as a "legacy" entry.
  }
  const laserBySession = new Map<string, ExportLaserSource[]>();
  for (const l of input.laserEntries ?? []) {
    laserBySession.set(l.session_id, [...(laserBySession.get(l.session_id) ?? []), l]);
  }
  const blocksBySession = new Map<string, ExportBlockSource[]>();
  for (const b of blocks) blocksBySession.set(b.session_id, [...(blocksBySession.get(b.session_id) ?? []), b]);

  const sessions = [...input.sessions]
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((s) => ({
      id: s.id,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      modality: s.modality,
      practitioner: name(s.performed_by_practitioner_id ?? s.practitioner_id),
      notes: s.session_notes,
      recordStatus: s.record_status,
      finalizedAt: s.finalized_at,
      aftercareExplainedAt: s.aftercare_and_risks_explained_at,
      blocks: [...(blocksBySession.get(s.id) ?? [])]
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at.localeCompare(b.created_at))
        .map((b) => ({
          id: b.id,
          title: blockTitle(b, input.blockAreasById?.get(b.id)),
          readings: readings([
            ["Mode", b.mode],
            ["Apilus modality", b.apilus_modality],
            ["Energy level", b.energy_level],
            ["Machine frequency", b.machine_frequency],
            ["Minutes performed", b.minutes_performed, "min"],
            ["Probe", b.probe_label || [b.probe_type, b.probe_size].filter(Boolean).join(" ")],
            // The confirmation travels with the lot (Codex P2 4302799069), worded
            // as the live chart words it (session-blocks-view.tsx).
            ["Probe lot", present(b.probe_lot_number) ? `${b.probe_lot_number.trim()}${b.probe_lot_confirmed ? " (confirmed)" : ""}` : null],
            ["Numbing", b.numbing_status],
            ["Tolerance", b.tolerance_rating],
          ]),
          notes: readings([
            ["Numbing notes", b.numbing_notes],
            // REACTIONS through the SAME rule as the saved-record view
            // (legacyBlockReactionLabel; Codex P1 4304382927). Current
            // responses print as the entries' chips ("Observed: ..."); a
            // block's reaction_type prints only when it is un-migrated history,
            // and then LABELLED legacy, never as an active finding, never
            // twice, and never "none" beside a real response.
            [
              "Legacy skin response",
              legacyBlockReactionLabel(
                b.reaction_type,
                (entriesByBlock.get(b.id) ?? []).map((e) => e.observation_chips),
              ),
            ],
            ["Legacy response note", b.reaction_notes],
            // The flag stands on its own (Codex P2 4302644062): a legacy block may
            // carry the caution with no note, and the chart still shows it.
            ["Caution for next session", present(b.caution_note) ? b.caution_note : b.caution_for_next_session ? "Yes" : null],
            ["Notes", b.block_notes],
          ]),
          entries: [...(entriesByBlock.get(b.id) ?? [])].sort(byCreated).map(exportEntry),
        })),
      entries: [...(looseBySession.get(s.id) ?? [])].sort(byCreated).map(exportEntry),
      laserEntries: [...(laserBySession.get(s.id) ?? [])].sort(byCreated).map(exportLaser),
    }));
  // Same-day versions in the order they were written (Codex P1 4302740025).
  const clinicalNotes = [...input.notes]
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.created_at.localeCompare(b.created_at))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      body: n.body,
      areas: n.areas ? [...n.areas] : [],
      occurredAt: n.occurred_at,
      practitioner: name(n.practitioner_id),
      isRevision: n.supersedes_note_id !== null,
      // An obsolete version is labelled as one, never printed as the current
      // note (Codex P1 4302740025), as the clinical-notes print already does.
      isSuperseded: input.supersededNoteIds?.has(n.id) ?? false,
    }));
  return { sessions, clinicalNotes };
}

// ---- Fail-closed orchestration ----------------------------------------------

export type PreviewOutcome<T> =
  | { ok: true; document: T }
  | { ok: false; reason: "audit_failed" | "load_failed" };

/**
 * Record the audit event FIRST, and load nothing unless it was recorded
 * (#828 G-13: every preview is audited, fail closed). Pure orchestration so
 * the ordering is unit-tested without a database.
 */
export async function auditThenLoad<T>(
  audit: () => Promise<{ ok: boolean }>,
  load: () => Promise<{ ok: true; value: T } | { ok: false }>,
): Promise<PreviewOutcome<T>> {
  const recorded = await audit().catch(() => ({ ok: false }));
  if (!recorded.ok) return { ok: false, reason: "audit_failed" };
  const loaded = await load().catch(() => ({ ok: false as const }));
  if (!loaded.ok) return { ok: false, reason: "load_failed" };
  return { ok: true, document: loaded.value };
}
