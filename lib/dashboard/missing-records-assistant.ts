import { TODO_DISCLOSURE_LIMIT } from "@/lib/dashboard/todo-model";
import { createClient } from "@/lib/supabase/server";

// Missing Records / Follow-up Assistant V1 (PR #249). The SECOND
// agentic-style workflow in Hone, and like Daily Prep Brief (PR #241)
// deliberately RULES-BASED ONLY: no AI, no model call, no provider
// integration, no chatbot, no autonomous action. It surfaces recorded
// workflow gaps and follow-ups from RECENT appointments so the
// practitioner can finish the record:
//   1 completed appointment with no charted session     -> Charting needed
//   2 recorded session with aftercare/risks not marked  -> Aftercare not marked
//   3 recorded treatment area with no probe lot          -> Probe lot missing
//   4 intake started but not submitted                   -> Intake incomplete
//   5 for-next-visit note with no upcoming appointment   -> Follow-up
//
// It obeys the agentic safety plan (docs/22): assistant not decider,
// flag not diagnose, summarize recorded history (do not invent),
// prepare the practitioner (do not prescribe). The gap rules MIRROR the
// existing ones (lib/sessions/before-today.ts for probe-lot / aftercare;
// lib/dashboard/next-action.ts for completed-not-charted) so the two can
// never disagree. The caution/watch-note item type is deliberately NOT
// included here: "Clients needing attention" (lib/dashboard/clients-
// needing-attention.ts) already covers it, and this assistant focuses on
// missing-record / follow-up gaps without duplicating it.
//
// Every item links to an EXISTING, safe, studio-scoped route; nothing is
// sent, charged, or mutated. It reads no sensitive surface (no exposure
// incidents, no payment internals, no Stripe ids, no raw tokens, no audit
// JSON) and writes nothing. Recorded-history wording only.

export type MissingRecordType =
  | "charting"
  | "aftercare"
  | "probe_lot"
  | "intake";

// 1 = most worth finishing first. Matches the spec ordering.
export type MissingRecordPriority = 1 | 2 | 3 | 4 | 5;

export type MissingRecordItem = {
  // Stable per (type, source row); used as the React key.
  id: string;
  type: MissingRecordType;
  priority: MissingRecordPriority;
  clientId: string;
  clientName: string;
  // Short, recorded-history reason. Never clinical advice.
  reason: string;
  // ISO timestamp of the relevant session / appointment, or null.
  date: string | null;
  // Existing, safe, studio-scoped route.
  href: string;
  actionLabel: "Chart appointment" | "Review session" | "Open client";
  // Short status chip.
  chip: string;
};

// A completed appointment with no charted session (next-action's
// "Charting needed" gap, extended past today's roster).
export type UnchartedAppointment = {
  appointmentId: string;
  clientId: string;
  clientName: string;
  startedAt: string;
};

// A recorded session and the gaps derived from it. hasTreatmentArea is
// true when the session has at least one recorded treatment area
// (session_block); the aftercare / probe-lot gaps only apply then, so a
// laser-only or empty session never produces a false flag.
export type RecordedSession = {
  sessionId: string;
  clientId: string;
  clientName: string;
  startedAt: string;
  hasTreatmentArea: boolean;
  aftercareMarked: boolean;
  probeLotMissing: boolean;
};

export type IncompleteIntake = {
  clientId: string;
  clientName: string;
};

export type MissingRecordsInput = {
  unchartedAppointments: ReadonlyArray<UnchartedAppointment>;
  sessions: ReadonlyArray<RecordedSession>;
  incompleteIntakes: ReadonlyArray<IncompleteIntake>;
  limit?: number;
};

export type MissingRecordsAssistant = {
  items: MissingRecordItem[];
  hasItems: boolean;
  // Distinct gaps found before the display cap, so the UI can say
  // "showing N of M" honestly. Never a compliance score.
  totalFound: number;
};

// DASH-TRUTH-02: return enough rows for the Dashboard disclosure to be real.
// Bounded; the SESSION_SCAN_CAP / COMPLETED_APPT_CAP scans are unchanged.
const DEFAULT_LIMIT = TODO_DISCLOSURE_LIMIT;

function clientHref(clientId: string): string {
  return `/clients/${clientId}`;
}

// Compare ISO dates desc (newest first); nulls sort last.
function newerFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : -1;
}

// Pure, deterministic. Builds the candidate items from already-derived
// facts, dedupes to one item per (client, type) keeping the most recent,
// orders by priority then recency, and caps the result. No I/O, no model,
// no mutation.
export function buildMissingRecordsAssistant(
  input: MissingRecordsInput,
): MissingRecordsAssistant {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const candidates: MissingRecordItem[] = [];

  for (const a of input.unchartedAppointments) {
    candidates.push({
      id: `charting:${a.appointmentId}`,
      type: "charting",
      priority: 1,
      clientId: a.clientId,
      clientName: a.clientName,
      reason: "Completed appointment, charting needed.",
      date: a.startedAt,
      href: `${clientHref(a.clientId)}/sessions/new?appointment_id=${a.appointmentId}`,
      actionLabel: "Chart appointment",
      chip: "Charting needed",
    });
  }

  for (const s of input.sessions) {
    const sessionHref = `${clientHref(s.clientId)}/sessions/${s.sessionId}`;
    if (s.hasTreatmentArea && !s.aftercareMarked) {
      candidates.push({
        id: `aftercare:${s.sessionId}`,
        type: "aftercare",
        priority: 2,
        clientId: s.clientId,
        clientName: s.clientName,
        reason: "Aftercare/risks not marked on the recorded session.",
        date: s.startedAt,
        href: sessionHref,
        actionLabel: "Review session",
        chip: "Aftercare not marked",
      });
    }
    if (s.hasTreatmentArea && s.probeLotMissing) {
      candidates.push({
        id: `probe_lot:${s.sessionId}`,
        type: "probe_lot",
        priority: 3,
        clientId: s.clientId,
        clientName: s.clientName,
        reason: "Probe lot missing from a recorded treatment area.",
        date: s.startedAt,
        href: sessionHref,
        actionLabel: "Review session",
        chip: "Probe lot missing",
      });
    }
    // DASH-TRUTH-01: a recorded for-next-visit note with no upcoming
    // appointment is NOT a missing record. It is clinical memory the
    // practitioner wrote deliberately, and whether to rebook is their call, not
    // an outstanding task this assistant should manufacture. The note itself is
    // untouched (sessions.next_session_note) and still surfaces in Today →
    // Before today → Remember, Treatment Memory, appointment prep and history.
    // The `follow_up` candidate that used to be pushed here is gone.
  }

  for (const i of input.incompleteIntakes) {
    candidates.push({
      id: `intake:${i.clientId}`,
      type: "intake",
      priority: 4,
      clientId: i.clientId,
      clientName: i.clientName,
      reason: "Intake started but not submitted.",
      date: null,
      href: clientHref(i.clientId),
      actionLabel: "Open client",
      chip: "Intake incomplete",
    });
  }

  // One item per (client, type): keep the most recent. Order by priority
  // then recency so the dedup keeps the highest-signal instance.
  const ordered = candidates
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.priority !== b.item.priority) {
        return a.item.priority - b.item.priority;
      }
      const byDate = newerFirst(a.item.date, b.item.date);
      return byDate !== 0 ? byDate : a.index - b.index;
    })
    .map(({ item }) => item);

  const seen = new Set<string>();
  const deduped: MissingRecordItem[] = [];
  for (const item of ordered) {
    const key = `${item.clientId}:${item.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return {
    items: deduped.slice(0, limit),
    hasItems: deduped.length > 0,
    totalFound: deduped.length,
  };
}

// ---------------------------------------------------------------------------
// Loader — bounded, read-only, studio-scoped reads over tables Hone
// already has RLS on. Mirrors the clients-needing-attention loader shape:
// scan the recent window, group in memory, hand pure facts to the builder.
// No service-role, no public route, no model/provider call, no write.
// ---------------------------------------------------------------------------

// Recent-session scan cap (matches the clients-needing-attention posture)
// and the completed-appointment lookback window.
const SESSION_SCAN_CAP = 120;
const COMPLETED_APPT_CAP = 100;
const COMPLETED_WINDOW_DAYS = 30;

type SessionScanRow = {
  id: string;
  client_id: string;
  started_at: string;
  aftercare_and_risks_explained_at: string | null;
  client:
    | { id: string; name: string; archived_at: string | null }
    | { id: string; name: string; archived_at: string | null }[]
    | null;
};

type BlockScanRow = {
  session_id: string;
  primary_area: string | null;
  block_name: string | null;
  custom_area_detail: string | null;
  probe_lot_number: string | null;
};

function joinedClient(
  raw: SessionScanRow["client"],
): { id: string; name: string; archived_at: string | null } | null {
  return Array.isArray(raw) ? raw[0] ?? null : raw;
}

export async function getMissingRecordsAssistant(
  studioId: string,
  // Passed in (not read from the clock here) so the module stays
  // deterministic and the window is computed once at the call site.
  nowUtcIso: string,
  options: { limit?: number } = {},
): Promise<MissingRecordsAssistant> {
  const supabase = await createClient();

  // 1) Recent sessions (newest first), capped.
  const { data: sessRows } = await supabase
    .from("sessions")
    .select(
      "id, client_id, started_at, aftercare_and_risks_explained_at, client:clients(id, name, archived_at)",
    )
    .eq("studio_id", studioId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(SESSION_SCAN_CAP);

  const sessions = ((sessRows ?? []) as SessionScanRow[])
    .map((r) => ({ row: r, client: joinedClient(r.client) }))
    .filter((s) => s.client && !s.client.archived_at);
  const sessionIds = sessions.map((s) => s.row.id);

  // 2) Treatment areas (session_blocks) for those sessions: probe lot +
  //    area presence. Mirrors the before-today record-reminder rules.
  const { data: blockRows } =
    sessionIds.length > 0
      ? await supabase
          .from("session_blocks")
          .select(
            "session_id, primary_area, block_name, custom_area_detail, probe_lot_number",
          )
          .eq("studio_id", studioId)
          .in("session_id", sessionIds)
          .is("deleted_at", null)
      : { data: [] as BlockScanRow[] };
  const blocksBySession = new Map<string, BlockScanRow[]>();
  for (const b of (blockRows ?? []) as BlockScanRow[]) {
    const list = blocksBySession.get(b.session_id) ?? [];
    list.push(b);
    blocksBySession.set(b.session_id, list);
  }

  // 3) Recent completed appointments, and which have a charted session
  //    (inner join to session_blocks => the session has a treatment area).
  const windowStartIso = new Date(
    Date.parse(nowUtcIso) - COMPLETED_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  const { data: apptRows } = await supabase
    .from("appointments")
    .select("id, client_id, starts_at, client:clients(id, name, archived_at)")
    .eq("studio_id", studioId)
    .eq("status", "completed")
    .gte("starts_at", windowStartIso)
    .lte("starts_at", nowUtcIso)
    .order("starts_at", { ascending: false })
    .limit(COMPLETED_APPT_CAP);
  type CompletedApptRow = {
    id: string;
    client_id: string;
    starts_at: string;
    client: SessionScanRow["client"];
  };
  const completedAppts = ((apptRows ?? []) as CompletedApptRow[])
    .map((r) => ({ row: r, client: joinedClient(r.client) }))
    .filter((a) => a.client && !a.client.archived_at);
  const completedApptIds = completedAppts.map((a) => a.row.id);

  const chartedApptIds = new Set<string>();
  if (completedApptIds.length > 0) {
    const { data: chartedRows } = await supabase
      .from("sessions")
      .select("appointment_id, session_blocks!inner(session_id)")
      .eq("studio_id", studioId)
      .in("appointment_id", completedApptIds)
      .is("deleted_at", null);
    for (const r of (chartedRows ?? []) as Array<{
      appointment_id: string | null;
    }>) {
      if (r.appointment_id) chartedApptIds.add(r.appointment_id);
    }
  }

  // Review 3779063526. The follow-up gap ("a plan exists but nothing is on the
  // calendar") was retired with the `follow_up` To-do kind: a plan for the next
  // visit is clinical memory, not unresolved work, so not having rebooked yet
  // is not a task. Its plumbing outlived it — this loader still selected
  // next_session_note, derived follow-up client ids and ran an extra
  // appointments query, then carried nextVisitNote and hasUpcomingAppointment
  // into RecordedSession that nothing read. That cost a database round trip on
  // every dashboard whose recent sessions contain plans, and kept transporting
  // plan TEXT through the To-do loader. All of it is removed here.
  //
  // The column and the note itself are untouched: Today → Remember, Treatment
  // Memory, appointment prep, session/client history and the clinical-summary
  // loaders all read sessions.next_session_note directly and are unaffected.

  // 5) Intake status for clients in the session scan: flag in_progress
  //    only ("intake incomplete"). Submitted is "awaiting review", already
  //    covered by the existing Needs-attention card, so it is excluded.
  const scanClientIds = [...new Set(sessions.map((s) => s.row.client_id))];
  const incompleteIntakeClientIds = new Set<string>();
  if (scanClientIds.length > 0) {
    const { data: intakeRows } = await supabase
      .from("client_intake_forms")
      .select("client_id, status, created_at")
      .eq("studio_id", studioId)
      .in("client_id", scanClientIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    const latestByClient = new Map<string, string>();
    for (const r of (intakeRows ?? []) as Array<{
      client_id: string;
      status: string;
    }>) {
      if (!latestByClient.has(r.client_id)) {
        latestByClient.set(r.client_id, r.status);
      }
    }
    for (const [clientId, status] of latestByClient) {
      if (status === "in_progress") incompleteIntakeClientIds.add(clientId);
    }
  }

  // Assemble pure facts.
  const unchartedAppointments: UnchartedAppointment[] = completedAppts
    .filter((a) => !chartedApptIds.has(a.row.id))
    .map((a) => ({
      appointmentId: a.row.id,
      clientId: a.row.client_id,
      clientName: a.client?.name ?? "Client",
      startedAt: a.row.starts_at,
    }));

  const recordedSessions: RecordedSession[] = sessions.map((s) => {
    const blocks = blocksBySession.get(s.row.id) ?? [];
    const lotsMissing = blocks.filter((b) => !b.probe_lot_number?.trim()).length;
    return {
      sessionId: s.row.id,
      clientId: s.row.client_id,
      clientName: s.client?.name ?? "Client",
      startedAt: s.row.started_at,
      hasTreatmentArea: blocks.length > 0,
      aftercareMarked: s.row.aftercare_and_risks_explained_at != null,
      probeLotMissing: blocks.length > 0 && lotsMissing > 0,
    };
  });

  const nameByClient = new Map<string, string>();
  for (const s of sessions) {
    if (s.client) nameByClient.set(s.row.client_id, s.client.name);
  }
  const incompleteIntakes: IncompleteIntake[] = [
    ...incompleteIntakeClientIds,
  ].map((clientId) => ({
    clientId,
    clientName: nameByClient.get(clientId) ?? "Client",
  }));

  return buildMissingRecordsAssistant({
    unchartedAppointments,
    sessions: recordedSessions,
    incompleteIntakes,
    limit: options.limit,
  });
}
