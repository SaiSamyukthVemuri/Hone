// HON-46 M2 — the reads behind the day packet.
//
// COMPLETE OR NOTHING. Every read is paged to exhaustion by immutable id
// (readAllPages: fail closed on error, stalled cursor, oversize page or too many
// pages), and the caller shows no record rather than a partial clinical one.
//
// SCOPED TWICE. Each query filters studio and client in SQL, and the sessions
// that come back are filtered again by `selectSessionsForDay` (studio, client,
// not deleted, studio-local day), so a query that drifts cannot widen the packet.
//
// NAMED COLUMNS. Each select lists its columns; the packet reads only what it
// shows. It never reads client_personal_notes, a payment column, a contact column
// or a deleted row. Errors are reported as `{ ok: false }` with no message: a
// database error can quote row data.
//
// The Supabase client is INJECTED as a minimal structural type so the query
// shape is unit-tested with a recording fake, and so this module has no
// "server-only" import. The page passes the signed-in (user-scoped) client:
// studio-member RLS applies on top of the filters here.

import type { BlockArea } from "@/lib/sessions/block-areas";
import { SETUP_READING_COLUMNS, type PacketSetupReadingSource } from "@/lib/records/print/machine-settings";
import { readAllPages } from "@/lib/records/print/paging";
import { selectedDayBounds, selectSessionsForDay } from "@/lib/records/print/selected-day";
import type {
  PacketBlockSource,
  PacketEntrySource,
  PacketLaserSource,
  PacketSessionSource,
} from "@/lib/records/print/day-packet";

export const PACKET_SESSION_COLUMNS =
  "id, studio_id, client_id, deleted_at, started_at, ended_at, modality, session_notes, performed_by_practitioner_id, practitioner_id, aftercare_and_risks_explained_at, aftercare_and_risks_explained_by";
export const PACKET_BLOCK_COLUMNS =
  "id, session_id, sort_order, block_name, primary_area, side, custom_area_detail, mode, apilus_modality, energy_level, minutes_performed, machine_frequency, probe_label, probe_type, probe_size, probe_lot_number, numbing_status, numbing_notes, tolerance_rating, reaction_type, reaction_notes, caution_note, block_notes, started_at, ended_at, created_at";
export const PACKET_ENTRY_COLUMNS =
  "id, session_id, block_id, area, areas, probe_type, probe_size, mode, apilus_modality, intensity, duration_seconds, energy_level, machine_frequency, thermolysis_intensity_percent, thermolysis_duration_seconds, galvanic_ma, galvanic_duration_seconds, units_of_lye, pulse_delay_seconds, minutes_performed, pulse_count, hairs_treated, observation_chips, comments, created_at";
export const PACKET_LASER_COLUMNS =
  "id, session_id, zone, session_number, equipment_params, observation_notes, ejection_results, created_at";

/** Rows per .in() filter, so a long id list never builds an over-long URL. */
const ID_CHUNK = 100;

type Result = { data: unknown[] | null; error: unknown };
/** The slice of the Supabase query builder this module uses. */
export interface PacketQuery extends PromiseLike<Result> {
  select(columns: string): PacketQuery;
  eq(column: string, value: string): PacketQuery;
  is(column: string, value: null): PacketQuery;
  in(column: string, values: string[]): PacketQuery;
  gt(column: string, value: string): PacketQuery;
  gte(column: string, value: string): PacketQuery;
  lt(column: string, value: string): PacketQuery;
  order(column: string, options: { ascending: boolean }): PacketQuery;
  range(from: number, to: number): PacketQuery;
}
export interface PacketReader {
  from(table: string): PacketQuery;
}

const PAGE = 1000;

function keyset(q: PacketQuery, after: string | null): PacketQuery {
  const ordered = after === null ? q : q.gt("id", after);
  return ordered.order("id", { ascending: true }).range(0, PAGE - 1);
}

function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function readChunked<T extends { id: string }>(
  ids: readonly string[],
  page: (ids: string[], after: string | null) => PacketQuery,
): Promise<T[] | null> {
  const parts = await Promise.all(
    chunks(ids, ID_CHUNK).map((c) => readAllPages<T>((after) => page(c, after) as unknown as PromiseLike<{ data: T[] | null; error: unknown }>)),
  );
  if (parts.some((p) => p === null)) return null;
  return (parts as T[][]).flat();
}

export type DayPacketLoad =
  | {
      ok: true;
      value: {
        sessions: PacketSessionSource[];
        blocks: PacketBlockSource[];
        blockAreasById: Map<string, BlockArea[]>;
        entries: PacketEntrySource[];
        laserEntries: PacketLaserSource[];
        setupReadings: PacketSetupReadingSource[];
        practitionerNameById: Map<string, string>;
      };
    }
  | { ok: false; reason: "unresolvable_day" | "read_failed" };

type SessionRow = PacketSessionSource & { studio_id: string; client_id: string; deleted_at: string | null };

export async function loadDayPacket(args: {
  supabase: PacketReader;
  studioId: string;
  clientId: string;
  day: string;
  timezone: string;
  /** All-or-nothing structured areas per block (getSessionBlockAreasByBlockIds). */
  loadBlockAreas: (blockIds: string[], studioId: string) => Promise<Map<string, ReadonlyArray<BlockArea>>>;
}): Promise<DayPacketLoad> {
  const { supabase, studioId, clientId, day, timezone } = args;
  const bounds = selectedDayBounds(day, timezone);
  if (bounds === null) return { ok: false, reason: "unresolvable_day" };

  const sessionRows = await readAllPages<SessionRow>(
    (after) =>
      keyset(
        supabase
          .from("sessions")
          .select(PACKET_SESSION_COLUMNS)
          .eq("studio_id", studioId)
          .eq("client_id", clientId)
          .is("deleted_at", null)
          .gte("started_at", bounds.fromUtc)
          .lt("started_at", bounds.toUtcExclusive),
        after,
      ) as unknown as PromiseLike<{ data: SessionRow[] | null; error: unknown }>,
  );
  if (sessionRows === null) return { ok: false, reason: "read_failed" };

  const selected = selectSessionsForDay(sessionRows, { studioId, clientId, day, timezone });
  if (selected.kind === "unavailable") return { ok: false, reason: "unresolvable_day" };
  const sessions: PacketSessionSource[] = selected.kind === "sessions" ? selected.sessions : [];

  const empty = {
    sessions: [],
    blocks: [],
    blockAreasById: new Map<string, BlockArea[]>(),
    entries: [],
    laserEntries: [],
    setupReadings: [],
    practitionerNameById: new Map<string, string>(),
  };
  if (sessions.length === 0) return { ok: true, value: empty };

  const sessionIds = sessions.map((s) => s.id);
  const [blocks, entries, laserEntries] = await Promise.all([
    readChunked<PacketBlockSource>(sessionIds, (ids, after) =>
      keyset(supabase.from("session_blocks").select(PACKET_BLOCK_COLUMNS).eq("studio_id", studioId).in("session_id", ids).is("deleted_at", null), after),
    ),
    readChunked<PacketEntrySource>(sessionIds, (ids, after) =>
      keyset(supabase.from("electrolysis_entries").select(PACKET_ENTRY_COLUMNS).in("session_id", ids).is("deleted_at", null), after),
    ),
    readChunked<PacketLaserSource>(sessionIds, (ids, after) =>
      keyset(supabase.from("laser_entries").select(PACKET_LASER_COLUMNS).in("session_id", ids).is("deleted_at", null), after),
    ),
  ]);
  if (blocks === null || entries === null || laserEntries === null) return { ok: false, reason: "read_failed" };

  // Machine-native settings (treatment_setup_readings) for ONLY these blocks,
  // studio-scoped, to completion. Read-only; a failed read fails the whole packet.
  const setupReadings = await readChunked<PacketSetupReadingSource>(
    blocks.map((b) => b.id),
    (ids, after) =>
      keyset(supabase.from("treatment_setup_readings").select(SETUP_READING_COLUMNS).eq("studio_id", studioId).in("session_block_id", ids), after),
  );
  if (setupReadings === null) return { ok: false, reason: "read_failed" };

  // Names for ONLY the practitioners these sessions reference, to completion.
  // display_name only: never an email (the Records register falls back to one).
  const authorIds = [
    ...new Set(
      sessions
        .flatMap((s) => [s.performed_by_practitioner_id, s.practitioner_id, s.aftercare_and_risks_explained_by])
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const authors = await readChunked<{ id: string; display_name: string | null }>(authorIds, (ids, after) =>
    keyset(supabase.from("practitioners").select("id, display_name").eq("studio_id", studioId).in("id", ids), after),
  );
  if (authors === null) return { ok: false, reason: "read_failed" };

  let blockAreasById: Map<string, BlockArea[]>;
  try {
    const raw = await args.loadBlockAreas(blocks.map((b) => b.id), studioId);
    blockAreasById = new Map([...raw.entries()].map(([id, rows]) => [id, rows.map((r) => ({ area: r.area, laterality: r.laterality }))]));
  } catch {
    return { ok: false, reason: "read_failed" };
  }

  const practitionerNameById = new Map<string, string>();
  for (const a of authors) if (a.display_name && a.display_name.trim().length > 0) practitionerNameById.set(a.id, a.display_name.trim());
  return { ok: true, value: { sessions, blocks, blockAreasById, entries, laserEntries, setupReadings, practitionerNameById } };
}
