import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getSessionBlockAreasByBlockIds } from "@/lib/supabase/queries";
import type { BlockArea } from "@/lib/sessions/block-areas";
import {
  civilDayBounds,
  localDayBounds,
  type ExportBlockSource,
  type ExportEntrySource,
  type ExportLaserSource,
  type ExportNoteSource,
  type ExportScope,
  type ExportSessionSource,
} from "@/lib/clinical-records/export-scope";

// HON-46 — the server reads behind the per-client clinical-records export.
//
// Every read is the user-scoped client, so the studio-member RLS that guards
// the client profile guards this too; the page adds the owner-only gate on top.
// Each select NAMES its columns: the export reads only what it shows. It never
// reads client_personal_notes (private warnings, personal notes), never a
// payment column, and never a deleted session, settings block, entry or laser pass.
//
// Errors are reported as `{ ok: false }` with no message: a database error can
// quote row data, and nothing here may reach a log or an error tracker.

const SESSION_COLUMNS =
  "id, started_at, ended_at, modality, session_notes, performed_by_practitioner_id, practitioner_id, record_status, finalized_at, aftercare_and_risks_explained_at";
// Current charting fields AND the legacy ones (Codex P1 4301165385): the
// area-first flow records settings on session_blocks and readings on the newer
// electrolysis_entries columns, while older charts used the generic ones.
const BLOCK_COLUMNS =
  "id, session_id, sort_order, block_name, primary_area, side, custom_area_detail, mode, apilus_modality, energy_level, minutes_performed, machine_frequency, probe_label, probe_type, probe_size, probe_lot_number, probe_lot_confirmed, numbing_status, numbing_notes, tolerance_rating, reaction_type, reaction_notes, caution_note, caution_for_next_session, block_notes, started_at, ended_at, created_at";
const ENTRY_COLUMNS =
  "id, session_id, block_id, area, areas, probe_type, probe_size, mode, apilus_modality, intensity, duration_seconds, energy_level, machine_frequency, thermolysis_intensity_percent, thermolysis_duration_seconds, galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent, units_of_lye, pulse_delay_seconds, minutes_performed, pulse_count, hairs_treated, observation_chips, comments, created_at";
const LASER_COLUMNS =
  "id, session_id, zone, session_number, equipment_params, observation_notes, ejection_results, created_at";
const NOTE_COLUMNS = "id, kind, body, areas, occurred_at, practitioner_id, supersedes_note_id, created_at";

/**
 * The ONLY client read allowed before the audit (Codex P1 4301153305): the
 * client's id and display name, studio-scoped, nothing else. The broad
 * profile loader (getClientById) also reads pricing, every session and every
 * entry, which would be an unaudited, unscoped read of the record; it must not
 * be used on this route. Null when the client is not this studio's.
 */
export async function loadExportClientIdentity(
  studioId: string,
  clientId: string,
): Promise<{ id: string; name: string } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name")
    .eq("studio_id", studioId)
    .eq("id", clientId)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string; name: string };
}

/** Cap on sessions in one export; a range is already bounded to a year. */
export const EXPORT_SESSION_LIMIT = 500;

// COMPLETE OR NOTHING (Codex P1 4301307242). PostgREST caps a response at
// max_rows (1000) and still answers 200, so an unpaged read silently drops the
// rest. Every child read is paged to exhaustion in a stable order; a read that
// would need more than EXPORT_MAX_PAGES pages fails the whole load closed, and
// the page shows no record rather than a partial clinical one.
export const EXPORT_PAGE_SIZE = 1000;
export const EXPORT_MAX_PAGES = 50;
// Session ids per .in() filter, so a 500-session export never builds an
// over-long request URL. Same reason as getSessionBlockAreasByBlockIds' chunks.
const SESSION_ID_CHUNK = 100;

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/** Read every row, page by page; null on error OR on saturation (fail closed). */
export async function readAllPages<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[] | null> {
  const out: T[] = [];
  for (let p = 0; p < EXPORT_MAX_PAGES; p += 1) {
    const from = p * EXPORT_PAGE_SIZE;
    const { data, error } = await page(from, from + EXPORT_PAGE_SIZE - 1);
    if (error) return null;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < EXPORT_PAGE_SIZE) return out;
  }
  return null;
}

function chunks<T>(xs: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Every row for every chunk of session ids, or null if any chunk fails. */
async function readAllForSessions<T>(
  sessionIds: ReadonlyArray<string>,
  page: (ids: string[], from: number, to: number) => PageResult<T>,
): Promise<T[] | null> {
  const parts = await Promise.all(
    chunks(sessionIds, SESSION_ID_CHUNK).map((ids) => readAllPages<T>((from, to) => page(ids, from, to))),
  );
  if (parts.some((part) => part === null)) return null;
  return (parts as T[][]).flat();
}

export type ClinicalRecordsLoad =
  | {
      ok: true;
      value: {
        sessions: ExportSessionSource[];
        blocks: ExportBlockSource[];
        blockAreasById: Map<string, BlockArea[]>;
        entries: ExportEntrySource[];
        laserEntries: ExportLaserSource[];
        notes: ExportNoteSource[];
        supersededNoteIds: Set<string>;
        practitionerNameById: Map<string, string>;
        truncated: boolean;
      };
    }
  | { ok: false };

export async function loadClinicalRecordsForExport(args: {
  studioId: string;
  clientId: string;
  scope: ExportScope;
  timezone: string;
}): Promise<ClinicalRecordsLoad> {
  const supabase = await createClient();
  const { studioId, clientId, scope, timezone } = args;

  let sessionQuery = supabase
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null);
  let noteBounds: { fromUtc: string; toUtcExclusive: string } | null = null;

  if (scope.kind === "session") {
    sessionQuery = sessionQuery.eq("id", scope.sessionId);
  } else {
    const [from, to] = scope.kind === "day" ? [scope.day, scope.day] : [scope.from, scope.to];
    // Sessions are INSTANTS: the studio-local window. Clinical notes are
    // CALENDAR DATES: the same civil days, by their stored YYYY-MM-DD.
    const sessionBounds = localDayBounds(from, to, timezone);
    noteBounds = civilDayBounds(from, to);
    sessionQuery = sessionQuery
      .gte("started_at", sessionBounds.fromUtc)
      .lt("started_at", sessionBounds.toUtcExclusive);
  }

  const sessionsRes = await sessionQuery
    .order("started_at", { ascending: true })
    .limit(EXPORT_SESSION_LIMIT + 1);
  if (sessionsRes.error) return { ok: false };
  const allSessions = (sessionsRes.data ?? []) as ExportSessionSource[];
  const truncated = allSessions.length > EXPORT_SESSION_LIMIT;
  const sessions = allSessions.slice(0, EXPORT_SESSION_LIMIT);

  // A single-session export carries the clinical notes recorded on that
  // session's studio-local day. A session id that is not this client's
  // matched nothing above, so it yields an empty document, not another
  // client's notes.
  if (scope.kind === "session") {
    const only = sessions[0];
    if (!only) {
      return {
        ok: true,
        value: {
          sessions: [],
          blocks: [],
          blockAreasById: new Map(),
          entries: [],
          laserEntries: [],
          notes: [],
          supersededNoteIds: new Set(),
          practitionerNameById: new Map(),
          truncated: false,
        },
      };
    }
    // NO clinical notes in a single-session export (Codex P1 4302690099):
    // notes carry no session association, so a same-day note would put
    // unrelated clinical narrative into a printout labelled "this session".
    // The page says so and points to the day view, which includes them.
    noteBounds = null;
  }

  const sessionIds = sessions.map((s) => s.id);
  const bounds = noteBounds;
  const [blocks, entries, laserEntries, notes, supersedingLinks] = await Promise.all([
    readAllForSessions<ExportBlockSource>(sessionIds, (ids, from, to) =>
      supabase
        .from("session_blocks")
        .select(BLOCK_COLUMNS)
        .eq("studio_id", studioId)
        .in("session_id", ids)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<ExportBlockSource[]>(),
    ),
    readAllForSessions<ExportEntrySource>(sessionIds, (ids, from, to) =>
      supabase
        .from("electrolysis_entries")
        .select(ENTRY_COLUMNS)
        .in("session_id", ids)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<ExportEntrySource[]>(),
    ),
    readAllForSessions<ExportLaserSource>(sessionIds, (ids, from, to) =>
      supabase
        .from("laser_entries")
        .select(LASER_COLUMNS)
        .in("session_id", ids)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<ExportLaserSource[]>(),
    ),
    bounds === null
      ? Promise.resolve([] as ExportNoteSource[])
      : readAllPages<ExportNoteSource>((from, to) =>
          supabase
            .from("client_clinical_notes")
            .select(NOTE_COLUMNS)
            .eq("studio_id", studioId)
            .eq("client_id", clientId)
            .gte("occurred_at", bounds.fromUtc)
            .lt("occurred_at", bounds.toUtcExclusive)
            .order("id", { ascending: true })
            .range(from, to)
            .returns<ExportNoteSource[]>(),
        ),
    // Which notes a later version replaces (Codex P1 4302740025). Read across
    // the client's WHOLE note history, not the exported range: a revision dated
    // after the range still makes the in-range original obsolete. Paged to
    // completion and fail-closed, like every read here.
    bounds === null
      ? Promise.resolve([] as Array<{ id: string; supersedes_note_id: string }>)
      : readAllPages<{ id: string; supersedes_note_id: string }>((from, to) =>
          supabase
            .from("client_clinical_notes")
            .select("id, supersedes_note_id")
            .eq("studio_id", studioId)
            .eq("client_id", clientId)
            .not("supersedes_note_id", "is", null)
            .order("id", { ascending: true })
            .range(from, to)
            .returns<Array<{ id: string; supersedes_note_id: string }>>(),
        ),
  ]);
  if (blocks === null || entries === null || laserEntries === null || notes === null || supersedingLinks === null) {
    return { ok: false };
  }
  const supersededNoteIds = new Set(supersedingLinks.map((l) => l.supersedes_note_id));

  // Author names for ONLY the practitioners these records reference, read to
  // completion (Codex P2 4302690102): an unbounded studio-wide read is capped
  // at max_rows with no useful order, which would print a real author as
  // "Unknown practitioner". Chunked and paged like every other read here.
  const authorIds = [
    ...new Set(
      [
        ...sessions.flatMap((s) => [s.performed_by_practitioner_id, s.practitioner_id]),
        ...notes.map((n) => n.practitioner_id),
      ].filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const authors = await readAllForSessions<{ id: string; display_name: string }>(authorIds, (ids, from, to) =>
    supabase
      .from("practitioners")
      .select("id, display_name")
      .eq("studio_id", studioId)
      .in("id", ids)
      .order("id", { ascending: true })
      .range(from, to)
      .returns<Array<{ id: string; display_name: string }>>(),
  );
  if (authors === null) return { ok: false };

  // The treated areas of each block (Codex P1 4301307238): for blocks charted
  // through the multi-area flow, session_block_areas is authoritative and
  // primary_area keeps only the first area. Read through the same loader the
  // other clinical surfaces use; it is all-or-nothing, so a failure fails the
  // export closed rather than understating which areas were treated.
  let blockAreasById: Map<string, BlockArea[]>;
  try {
    const raw = await getSessionBlockAreasByBlockIds(
      blocks.map((b) => b.id),
      studioId,
    );
    blockAreasById = new Map(
      [...raw.entries()].map(([id, rows]) => [id, rows.map((r) => ({ area: r.area, laterality: r.laterality }))]),
    );
  } catch {
    return { ok: false };
  }

  const practitionerNameById = new Map<string, string>();
  for (const p of authors) practitionerNameById.set(p.id, p.display_name);
  return {
    ok: true,
    value: {
      sessions,
      blocks,
      blockAreasById,
      entries,
      laserEntries,
      notes,
      supersededNoteIds,
      practitionerNameById,
      truncated,
    },
  };
}

/**
 * Append the audit event for a preview or a print. Returns ok:false on ANY
 * failure so the caller can refuse (fail closed). Metadata carries the scope,
 * never a client name or a note.
 */
export async function recordClinicalRecordsAudit(args: {
  /** Set by the caller when the row must be referenced (the print binding). */
  id?: string;
  studioId: string;
  actorId: string;
  clientId: string;
  action: "clinical_records_previewed" | "clinical_records_printed";
  metadata: Record<string, string | number>;
}): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { error } = await supabase.from("audit_logs").insert({
    ...(args.id ? { id: args.id } : {}),
    studio_id: args.studioId,
    actor_id: args.actorId,
    action: args.action,
    entity_type: "client",
    entity_id: args.clientId,
    metadata: args.metadata,
  });
  return { ok: !error };
}
