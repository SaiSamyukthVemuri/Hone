import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";
import type { BlockArea } from "@/lib/sessions/block-areas";
import type { SavedEntryFields, SavedLaserFields } from "@/components/entry-row";
import type { SavedAreaBlock } from "@/app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view";

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
  /** Who recorded the disclosure; may differ from the performer (Codex P2 4307259896). */
  aftercare_and_risks_explained_by: string | null;
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

// SCREEN == PAPER, BY CONSTRUCTION. A block, a blockless entry and a laser pass
// print through the SAME components the saved session view renders
// (SavedAreaRecord, ElectrolysisEntryRow, LaserEntryRow), so the document
// carries the allow-listed ROWS those components read, never a second
// presentation of them. #896 rounds 6-8 each found another field where a
// second presenter had drifted from the view; there is no second presenter
// now. The parity test (tests/components/saved-record-print-parity.test.ts)
// renders the real view and this document from one fixture and requires the
// same text.
//
// PRINT-ONLY, NAMED. A few stored clinical fields are not on the saved view
// but ARE treatment record, so the printout keeps them (HON-46: keep the day's
// treatments and clinical notes), as an explicit list rendered AFTER the shared
// render. They are exactly these, and the parity test allows exactly these:
export const PRINT_ONLY_FIELDS = {
  /** session_blocks.block_notes: a legacy free-text clinical note per area. */
  block: ["Area notes"],
  /** laser_entries: the results, and every setting LaserEntryRow does not show. */
  laser: ["Results", "Settings"],
} as const;

export type ExportedBlock = {
  id: string;
  /** Exactly what SavedAreaRecord renders. */
  record: SavedAreaBlock;
  printOnly: Reading[];
};

export type ExportedLaser = {
  id: string;
  /** Exactly what LaserEntryRow renders. */
  record: SavedLaserFields;
  printOnly: Reading[];
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
    /** The practitioner who recorded the aftercare disclosure (Codex P2 4307259896). */
    aftercareExplainedBy: string | null;
    /** Settings blocks (current charting), each with the entries charted in it. */
    blocks: ExportedBlock[];
    /** Entries not attached to a block (older charting): ElectrolysisEntryRow, as the view's "Unassigned entries". */
    entries: SavedEntryFields[];
    /** Laser treatment passes, newest first as the session page lists them. */
    laserEntries: ExportedLaser[];
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
function readings(pairs: Array<[string, unknown]>): Reading[] {
  const out: Reading[] = [];
  for (const [label, value] of pairs) if (present(value)) out.push({ label, value: String(value) });
  return out;
}

// ALLOW-LIST COPIES. Each names the fields its component reads; a column the
// query returns, or one added to a table later, cannot reach the page.
function pickEntry(e: ExportEntrySource): SavedEntryFields {
  return {
    id: e.id,
    created_at: e.created_at,
    area: e.area ?? "",
    areas: e.areas,
    mode: e.mode,
    apilus_modality: e.apilus_modality,
    energy_level: e.energy_level,
    minutes_performed: e.minutes_performed,
    probe_type: e.probe_type,
    probe_size: e.probe_size,
    machine_frequency: e.machine_frequency,
    units_of_lye: e.units_of_lye,
    galvanic_duration_seconds: e.galvanic_duration_seconds,
    galvanic_ma: e.galvanic_ma,
    thermolysis_duration_seconds: e.thermolysis_duration_seconds,
    thermolysis_intensity_percent: e.thermolysis_intensity_percent,
    pulse_count: e.pulse_count,
    pulse_delay_seconds: e.pulse_delay_seconds,
    intensity: e.intensity,
    duration_seconds: e.duration_seconds,
    hairs_treated: e.hairs_treated,
    observation_chips: e.observation_chips ?? [],
    comments: e.comments,
  } as SavedEntryFields;
}

function pickBlock(
  b: ExportBlockSource,
  areas: ReadonlyArray<BlockArea> | undefined,
  entries: ReadonlyArray<ExportEntrySource>,
): SavedAreaBlock {
  return {
    id: b.id,
    sort_order: b.sort_order ?? 0,
    block_name: b.block_name,
    primary_area: b.primary_area,
    side: b.side,
    custom_area_detail: b.custom_area_detail,
    mode: b.mode,
    apilus_modality: b.apilus_modality,
    energy_level: b.energy_level,
    machine_frequency: b.machine_frequency,
    minutes_performed: b.minutes_performed,
    probe_label: b.probe_label,
    probe_type: b.probe_type,
    probe_size: b.probe_size,
    probe_lot_number: b.probe_lot_number,
    probe_lot_confirmed: b.probe_lot_confirmed ?? false,
    numbing_status: b.numbing_status,
    numbing_notes: b.numbing_notes,
    tolerance_rating: b.tolerance_rating,
    reaction_type: b.reaction_type,
    reaction_notes: b.reaction_notes,
    caution_for_next_session: b.caution_for_next_session ?? false,
    caution_note: b.caution_note,
    structured_areas: areas ? areas.map((a) => ({ area: a.area, laterality: a.laterality })) : [],
    electrolysis_entries: entries.map(pickEntry),
  } as SavedAreaBlock;
}

// LaserEntryRow shows the session number and the fluence / pulse width / spot
// size settings when they are text; every other setting prints in the named
// "Settings" line, so nothing recorded is lost from paper.
const LASER_ROW_SETTINGS = ["fluence", "pulse_width", "spot_size"] as const;

function pickLaser(l: ExportLaserSource): ExportedLaser {
  const params = l.equipment_params ?? {};
  const shownByRow = (key: string, value: unknown) =>
    (LASER_ROW_SETTINGS as readonly string[]).includes(key) && typeof value === "string" && value.length > 0;
  const otherSettings = Object.entries(params)
    .filter(([key, value]) => !shownByRow(key, value) && present(value))
    .map(([key, value]) => `${key.replace(/_/g, " ")} ${String(value)}`);
  return {
    id: l.id,
    record: {
      id: l.id,
      created_at: l.created_at,
      zone: l.zone,
      session_number: l.session_number,
      equipment_params: l.equipment_params,
      observation_notes: l.observation_notes,
    } as SavedLaserFields,
    printOnly: readings([
      ["Settings", otherSettings.length > 0 ? otherSettings.join(" · ") : null],
      ["Results", l.ejection_results],
    ]),
  };
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
      // 'draft' is RETIRED lifecycle state: every session since 0159 is draft
      // forever, so printing it would make a completed record read unfinished
      // (Codex P2 4307447128). A preserved legacy 'finalized'/'void' still shows.
      recordStatus: s.record_status === "draft" ? null : s.record_status,
      finalizedAt: s.finalized_at,
      aftercareExplainedAt: s.aftercare_and_risks_explained_at,
      aftercareExplainedBy: s.aftercare_and_risks_explained_at ? name(s.aftercare_and_risks_explained_by) : null,
      blocks: [...(blocksBySession.get(s.id) ?? [])]
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at.localeCompare(b.created_at))
        .map((b) => ({
          id: b.id,
          record: pickBlock(b, input.blockAreasById?.get(b.id), [...(entriesByBlock.get(b.id) ?? [])].sort(byCreated)),
          printOnly: readings([["Area notes", b.block_notes]]),
        })),
      entries: [...(looseBySession.get(s.id) ?? [])].sort(byCreated).map(pickEntry),
      // Newest first, as the session page lists laser passes.
      laserEntries: [...(laserBySession.get(s.id) ?? [])].sort((a, b) => byCreated(b, a)).map(pickLaser),
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
