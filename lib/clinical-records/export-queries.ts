import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  localDayBounds,
  type ExportBlockSource,
  type ExportEntrySource,
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
// payment column, and never a deleted session, settings block or entry.
//
// Errors are reported as `{ ok: false }` with no message: a database error can
// quote row data, and nothing here may reach a log or an error tracker.

const SESSION_COLUMNS =
  "id, started_at, ended_at, modality, session_notes, performed_by_practitioner_id, practitioner_id, record_status, finalized_at, aftercare_and_risks_explained_at";
// Current charting fields AND the legacy ones (Codex P1 4301165385): the
// area-first flow records settings on session_blocks and readings on the newer
// electrolysis_entries columns, while older charts used the generic ones.
const BLOCK_COLUMNS =
  "id, session_id, sort_order, block_name, primary_area, side, custom_area_detail, mode, apilus_modality, energy_level, minutes_performed, machine_frequency, probe_label, probe_type, probe_size, probe_lot_number, numbing_status, numbing_notes, tolerance_rating, reaction_type, reaction_notes, caution_note, block_notes, started_at, ended_at, created_at";
const ENTRY_COLUMNS =
  "id, session_id, block_id, area, areas, probe_type, probe_size, mode, apilus_modality, intensity, duration_seconds, energy_level, machine_frequency, thermolysis_intensity_percent, thermolysis_duration_seconds, galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent, units_of_lye, pulse_delay_seconds, minutes_performed, pulse_count, hairs_treated, observation_chips, comments, created_at";
const NOTE_COLUMNS = "id, kind, body, areas, occurred_at, practitioner_id, supersedes_note_id";

/** Cap on sessions in one export; a range is already bounded to a year. */
export const EXPORT_SESSION_LIMIT = 500;

export type ClinicalRecordsLoad =
  | {
      ok: true;
      value: {
        sessions: ExportSessionSource[];
        blocks: ExportBlockSource[];
        entries: ExportEntrySource[];
        notes: ExportNoteSource[];
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
    noteBounds = localDayBounds(from, to, timezone);
    sessionQuery = sessionQuery
      .gte("started_at", noteBounds.fromUtc)
      .lt("started_at", noteBounds.toUtcExclusive);
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
        value: { sessions: [], blocks: [], entries: [], notes: [], practitionerNameById: new Map(), truncated: false },
      };
    }
    const localDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(only.started_at));
    noteBounds = localDayBounds(localDay, localDay, timezone);
  }

  const sessionIds = sessions.map((s) => s.id);
  const [blocksRes, entriesRes, notesRes, practitionersRes] = await Promise.all([
    sessionIds.length === 0
      ? Promise.resolve({ data: [] as ExportBlockSource[], error: null })
      : supabase
          .from("session_blocks")
          .select(BLOCK_COLUMNS)
          .eq("studio_id", studioId)
          .in("session_id", sessionIds)
          .is("deleted_at", null),
    sessionIds.length === 0
      ? Promise.resolve({ data: [] as ExportEntrySource[], error: null })
      : supabase
          .from("electrolysis_entries")
          .select(ENTRY_COLUMNS)
          .in("session_id", sessionIds)
          .is("deleted_at", null),
    supabase
      .from("client_clinical_notes")
      .select(NOTE_COLUMNS)
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .gte("occurred_at", noteBounds!.fromUtc)
      .lt("occurred_at", noteBounds!.toUtcExclusive)
      .order("occurred_at", { ascending: true }),
    supabase.from("practitioners").select("id, display_name").eq("studio_id", studioId),
  ]);
  if (blocksRes.error || entriesRes.error || notesRes.error || practitionersRes.error) return { ok: false };

  const practitionerNameById = new Map<string, string>();
  for (const p of (practitionersRes.data ?? []) as Array<{ id: string; display_name: string }>) {
    practitionerNameById.set(p.id, p.display_name);
  }
  return {
    ok: true,
    value: {
      sessions,
      blocks: (blocksRes.data ?? []) as ExportBlockSource[],
      entries: (entriesRes.data ?? []) as ExportEntrySource[],
      notes: (notesRes.data ?? []) as ExportNoteSource[],
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
  studioId: string;
  actorId: string;
  clientId: string;
  action: "clinical_records_previewed" | "clinical_records_printed";
  metadata: Record<string, string | number>;
}): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { error } = await supabase.from("audit_logs").insert({
    studio_id: args.studioId,
    actor_id: args.actorId,
    action: args.action,
    entity_type: "client",
    entity_id: args.clientId,
    metadata: args.metadata,
  });
  return { ok: !error };
}
