import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";
import { blockAreasLabel, type BlockArea } from "@/lib/sessions/block-areas";

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
  "Laser treatment entries",
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
  numbing_status: string | null;
  numbing_notes: string | null;
  tolerance_rating: number | null;
  reaction_type: string | null;
  reaction_notes: string | null;
  caution_note: string | null;
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
  galvanic_intensity_percent: number | null;
  units_of_lye: number | null;
  pulse_delay_seconds: number | null;
  minutes_performed: number | null;
  pulse_count: number | null;
  hairs_treated: number | null;
  observation_chips: string[] | null;
  comments: string | null;
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
  }>;
  clinicalNotes: Array<{
    id: string;
    kind: string;
    body: string;
    areas: string[];
    occurredAt: string;
    practitioner: string | null;
    isRevision: boolean;
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
      ["Galvanic intensity", e.galvanic_intensity_percent, "%"],
      ["Units of lye", e.units_of_lye],
      ["Pulse delay", e.pulse_delay_seconds, "s"],
      ["Intensity", e.intensity],
      ["Duration", e.duration_seconds, "s"],
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
  notes: ReadonlyArray<ExportNoteSource>;
  practitionerNameById: ReadonlyMap<string, string>;
}): ClinicalRecordsDocument {
  const name = (id: string | null) => (id ? (input.practitionerNameById.get(id) ?? null) : null);
  const blocks = input.blocks ?? [];
  const blockIds = new Set(blocks.map((b) => b.id));
  const byCreated = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);

  const entriesByBlock = new Map<string, ExportEntrySource[]>();
  const looseBySession = new Map<string, ExportEntrySource[]>();
  for (const e of input.entries) {
    if (e.block_id && blockIds.has(e.block_id)) {
      entriesByBlock.set(e.block_id, [...(entriesByBlock.get(e.block_id) ?? []), e]);
    } else {
      looseBySession.set(e.session_id, [...(looseBySession.get(e.session_id) ?? []), e]);
    }
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
            ["Probe lot", b.probe_lot_number],
            ["Numbing", b.numbing_status],
            ["Tolerance", b.tolerance_rating],
            ["Reaction", b.reaction_type],
          ]),
          notes: readings([
            ["Numbing notes", b.numbing_notes],
            ["Reaction notes", b.reaction_notes],
            ["Caution", b.caution_note],
            ["Notes", b.block_notes],
          ]),
          entries: [...(entriesByBlock.get(b.id) ?? [])].sort(byCreated).map(exportEntry),
        })),
      entries: [...(looseBySession.get(s.id) ?? [])].sort(byCreated).map(exportEntry),
    }));
  const clinicalNotes = [...input.notes]
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      body: n.body,
      areas: n.areas ? [...n.areas] : [],
      occurredAt: n.occurred_at,
      practitioner: name(n.practitioner_id),
      isRevision: n.supersedes_note_id !== null,
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
