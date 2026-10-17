import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";

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
  "Deleted sessions and entries",
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

export type ExportEntrySource = {
  id: string;
  session_id: string;
  area: string | null;
  areas: string[] | null;
  probe_type: string | null;
  probe_size: string | null;
  mode: string | null;
  intensity: string | number | null;
  duration_seconds: number | null;
  minutes_performed: number | null;
  pulse_count: number | null;
  hairs_treated: number | null;
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
    entries: Array<{
      id: string;
      areas: string[];
      probe: string | null;
      mode: string | null;
      intensity: string | null;
      durationSeconds: number | null;
      minutesPerformed: number | null;
      pulseCount: number | null;
      hairsTreated: number | null;
      comments: string | null;
    }>;
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

export function buildClinicalRecordsDocument(input: {
  sessions: ReadonlyArray<ExportSessionSource>;
  entries: ReadonlyArray<ExportEntrySource>;
  notes: ReadonlyArray<ExportNoteSource>;
  practitionerNameById: ReadonlyMap<string, string>;
}): ClinicalRecordsDocument {
  const name = (id: string | null) => (id ? (input.practitionerNameById.get(id) ?? null) : null);
  const entriesBySession = new Map<string, ExportEntrySource[]>();
  for (const e of input.entries) {
    const list = entriesBySession.get(e.session_id) ?? [];
    list.push(e);
    entriesBySession.set(e.session_id, list);
  }
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
      entries: (entriesBySession.get(s.id) ?? [])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((e) => ({
          id: e.id,
          areas: e.areas && e.areas.length > 0 ? [...e.areas] : e.area ? [e.area] : [],
          probe: [e.probe_type, e.probe_size].filter(Boolean).join(" ") || null,
          mode: e.mode,
          intensity: e.intensity === null || e.intensity === undefined ? null : String(e.intensity),
          durationSeconds: e.duration_seconds,
          minutesPerformed: e.minutes_performed,
          pulseCount: e.pulse_count,
          hairsTreated: e.hairs_treated,
          comments: e.comments,
        })),
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
