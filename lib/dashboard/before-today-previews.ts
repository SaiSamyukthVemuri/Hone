import { createClient } from "@/lib/supabase/server";
import {
  buildLastSessionSummary,
  pickLastTreatment,
  pickPreClientWatchPlanSource,
  type ClinicalSummaryBlock,
} from "@/lib/sessions/clinical-summary";
import { buildTreatmentIntelligence } from "@/lib/sessions/treatment-intelligence";
import {
  buildBeforeToday,
  type BeforeToday,
} from "@/lib/sessions/before-today";
import type { SessionBlockArea } from "@/lib/types/database";

// PR #212: compact "Before today" previews for the Dashboard Today
// roster. The preview is a RENDERING of the exact same PR #211
// briefing pipeline the client Overview uses (pickLastTreatment ->
// pickPreClientWatchPlanSource -> buildLastSessionSummary ->
// buildTreatmentIntelligence -> buildBeforeToday), so the two can
// never disagree: if the full card says a probe lot is missing, the
// preview's reminder count includes it.
//
// Performance: batched reads for the WHOLE roster (sessions for all of the
// day's clients, their blocks, their structured areas, the client record
// fields) -- never one query per appointment. Rosters are small; reads are
// capped defensively. Read-only; recorded-history wording only.
//
// #605 REPAIR — HISTORY IS BOUNDED BY THE APPOINTMENT, NOT BY THE CLIENT.
//
// This loader used to answer "what is this client's newest session, full
// stop", which is only the right question when the briefing is showing the
// real present day. Once the Dashboard could show ANY day, that answer became
// wrong in three ways at once:
//
//   * a PAST appointment would show a session performed AFTER it as its own
//     preparation history, and then contradict the per-appointment memory
//     directly beside it, which does bound itself;
//   * two appointments for the SAME client on ONE day would share a single
//     answer, even though a session charted between them is legitimately
//     history for the second and cannot be history for the first;
//   * and gating the whole load off on non-today briefings — the first attempt
//     at this — turned "we did not look" into "there is nothing", which is how
//     a returning client got rendered as "New client · No charted history yet"
//     while looking at tomorrow.
//
// So eligibility is now per APPOINTMENT: a session counts as history for an
// appointment when it belongs to the same client, started STRICTLY BEFORE that
// appointment's own start instant, and is not the session recorded FOR that
// appointment. The result is keyed by appointment id for exactly that reason —
// keying by client id cannot express two cutoffs for one person.

export type BeforeTodayPreview = {
  hasHistory: boolean;
  // "Remember: <watch or plan>"; null when history exists but no
  // watch/plan note was recorded.
  rememberLine: string | null;
  // "27.12 MHz · Ballet F3 · Thermolysis"; null = Not recorded.
  setupLine: string | null;
  // "Records look complete." or "Records: N reminders".
  recordsLine: string;
  // PR #241: structured passthrough facts the Daily Prep Brief needs,
  // all already computed by buildBeforeToday (no new query). The
  // Today row preview ignores these; they let the brief split the
  // "for next visit" note from the caution note and list the granular
  // missing-record reminders. nextVisitNote = the next_session_note;
  // cautionNote = the first recorded watch line.
  nextVisitNote: string | null;
  cautionNote: string | null;
  reminders: string[];
};

// Pure: collapse a full briefing into the three preview lines. Watch
// wins over Plan (caution-like first), exactly one Remember line.
export function compactBeforeToday(briefing: BeforeToday): BeforeTodayPreview {
  if (!briefing.hasHistory) {
    return {
      hasHistory: false,
      rememberLine: null,
      setupLine: null,
      recordsLine: "",
      nextVisitNote: null,
      cautionNote: null,
      reminders: [],
    };
  }
  const remember =
    briefing.remember.watchLines[0] ?? briefing.remember.plan ?? null;
  const n = briefing.reminders.length;
  return {
    hasHistory: true,
    rememberLine: remember,
    setupLine: briefing.latestSetupLine,
    recordsLine:
      n === 0
        ? "Records look complete."
        : `Records: ${n} ${n === 1 ? "reminder" : "reminders"}`,
    nextVisitNote: briefing.remember.plan,
    cautionNote: briefing.remember.watchLines[0] ?? null,
    reminders: [...briefing.reminders],
  };
}

type SessionRow = {
  id: string;
  client_id: string;
  // The appointment this session was recorded FOR, when it was started from
  // one. Used to keep an appointment's own session out of its own history.
  appointment_id: string | null;
  started_at: string;
  next_session_note: string | null;
  aftercare_and_risks_explained_at: string | null;
  modality: string;
  electrolysis_entries: Array<{
    hairs_treated: number | null;
    deleted_at: string | null;
  }> | null;
  laser_entries: Array<{ id: string; deleted_at: string | null }> | null;
};

type BlockRow = ClinicalSummaryBlock & {
  id: string;
  session_id: string;
  machine_frequency: string | null;
  probe_lot_number: string | null;
  // Charting unification: the block's live entries' observation_chips, for the
  // unified reaction summaries.
  electrolysis_entries?:
    | Array<{ observation_chips: unknown; deleted_at: string | null }>
    | null;
};

/** One appointment's history question. `before` is its own start instant. */
export type BeforeAppointmentRequest = {
  appointmentId: string;
  clientId: string;
  /** ISO instant. A session is eligible only if it started STRICTLY before it. */
  before: string;
};

/**
 * The load, with UNAVAILABLE preserved as its own outcome.
 *
 * `{ ok: false }` means the reads did not establish anything. It must never be
 * flattened into "no history": an unproven absence rendered as "New client"
 * is a claim about a real person that nothing verified. Same discipline as the
 * card-on-file load, which distinguishes ABSENT from UNKNOWN for the same
 * reason.
 */
export type BeforeAppointmentLoad =
  | { ok: true; previews: Map<string, BeforeTodayPreview> }
  | { ok: false };

/**
 * The eligibility rule, on its own, so it can be proven without a database.
 *
 * A session is preparation history for an appointment when it is that client's,
 * started STRICTLY before the appointment, and is not the session recorded FOR
 * that appointment (which is the visit itself, not preparation for it).
 *
 * `sessions` must already be this client's, newest-first; the order is carried
 * through untouched because the summary pipeline depends on it.
 */
export function eligibleSessionsForAppointment<
  T extends { started_at: string; appointment_id: string | null },
>(sessionsNewestFirst: ReadonlyArray<T>, request: BeforeAppointmentRequest): T[] {
  return sessionsNewestFirst.filter(
    (s) =>
      s.started_at < request.before &&
      s.appointment_id !== request.appointmentId,
  );
}

/**
 * Build one preview from an ALREADY-FILTERED set of eligible sessions.
 *
 * Pure, and the single construction path: the appointment-bounded loader and
 * anything else that needs a preview must come through here, so there is one
 * clinical-summary pipeline rather than two that can drift.
 */
function buildPreviewFromSessions(args: {
  sessionsNewestFirst: SessionRow[];
  blocksBySession: Map<string, BlockRow[]>;
  clientFields: {
    date_of_birth: string | null;
    phone: string | null;
    address: string | null;
  } | null;
}): BeforeTodayPreview {
  const clientSessions = args.sessionsNewestFirst.map((s) => ({
    ...s,
    // Migration 0114: voided passes never count in the dashboard preview.
    electrolysis_entries: (s.electrolysis_entries ?? []).filter(
      (e) => !e.deleted_at,
    ),
    laser_entries: (s.laser_entries ?? []).filter((e) => !e.deleted_at),
  }));
  const clientBlockMap = new Map<string, BlockRow[]>();
  for (const s of clientSessions) {
    const list = args.blocksBySession.get(s.id);
    if (list) clientBlockMap.set(s.id, list);
  }
  const lastTreatment = pickLastTreatment(clientSessions, clientBlockMap);
  const watchSource = pickPreClientWatchPlanSource(
    clientSessions,
    clientBlockMap,
  );
  const watchPlan = watchSource
    ? buildLastSessionSummary({
        blocks: clientBlockMap.get(watchSource.id) ?? [],
        nextSessionNote: watchSource.next_session_note ?? null,
      })
    : null;
  const allClientBlocks = clientSessions.flatMap(
    (s) => clientBlockMap.get(s.id) ?? [],
  );
  const intelligence = buildTreatmentIntelligence({
    sessionsNewestFirst: clientSessions,
    blocks: allClientBlocks.map((b) => ({
      ...b,
      entry_hairs: [],
      observation_chips_list: (b.electrolysis_entries ?? [])
        .filter((e) => e.deleted_at == null)
        .map((e) => e.observation_chips),
    })),
  });
  const lastBlocks = lastTreatment
    ? (clientBlockMap.get(lastTreatment.id) ?? [])
    : [];
  const lastSummary = lastTreatment
    ? buildLastSessionSummary({
        // Charting unification: feed live entries' observation_chips so the
        // reaction line reads the unified representation.
        blocks: lastBlocks.map((b) => ({
          ...b,
          observation_chips_list: (b.electrolysis_entries ?? [])
            .filter((e) => e.deleted_at == null)
            .map((e) => e.observation_chips),
        })),
        nextSessionNote: lastTreatment.next_session_note ?? null,
      })
    : null;
  const fields = args.clientFields;
  const briefing = buildBeforeToday({
    lastTreatment: lastTreatment
      ? {
          startedAt: lastTreatment.started_at,
          modality: lastTreatment.modality,
          areaNames: lastSummary?.areas.map((a) => a.name) ?? [],
          aftercareExplainedAt:
            lastTreatment.aftercare_and_risks_explained_at ?? null,
          blockLots: lastBlocks.map((b) => b.probe_lot_number ?? null),
          blockMinutes: lastBlocks.map((b) => b.minutes_performed ?? null),
          blockReactionNotes: lastBlocks.map((b) => b.reaction_notes ?? null),
        }
      : null,
    watchPlan,
    intelligence,
    client: {
      dateOfBirth: fields?.date_of_birth ?? null,
      phone: fields?.phone ?? null,
      address: fields?.address ?? null,
    },
  });
  return compactBeforeToday(briefing);
}

/**
 * Previews for a day's appointments, each bounded by its OWN start instant.
 *
 * Batched: one sessions read for every client on the roster, then blocks,
 * structured areas and client fields over what that returned. The number of
 * queries does not grow with the number of appointments — adding a tenth
 * appointment adds no query.
 */
export async function getBeforeAppointmentPreviews(
  studioId: string,
  appointments: ReadonlyArray<BeforeAppointmentRequest>,
): Promise<BeforeAppointmentLoad> {
  const previews = new Map<string, BeforeTodayPreview>();
  const requests = appointments.filter((a) => a.appointmentId && a.clientId);
  if (requests.length === 0) return { ok: true, previews };

  const ids = [...new Set(requests.map((r) => r.clientId))];
  // The widest cutoff any appointment on this roster asks for. Reading past it
  // would spend the row budget on sessions no appointment can use.
  const maxBefore = requests
    .map((r) => r.before)
    .reduce((a, b) => (a > b ? a : b));

  const supabase = await createClient();
  const { data: sessionRows, error: sessionsError } = await supabase
    .from("sessions")
    .select(
      "id, client_id, appointment_id, started_at, next_session_note, aftercare_and_risks_explained_at, modality, electrolysis_entries(hairs_treated, deleted_at), laser_entries(id, deleted_at)",
    )
    .eq("studio_id", studioId)
    .in("client_id", ids)
    .lt("started_at", maxBefore)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(400);
  // A failed read establishes nothing. Returning an empty map here is exactly
  // the collapse this type exists to prevent.
  if (sessionsError) return { ok: false };
  const sessions = (sessionRows ?? []) as SessionRow[];

  const sessionIds = sessions.map((s) => s.id);
  const [blocksResult, clientsResult] = await Promise.all([
    sessionIds.length > 0
      ? supabase
          .from("session_blocks")
          .select(
            "id, session_id, sort_order, block_name, primary_area, side, custom_area_detail, mode, apilus_modality, energy_level, minutes_performed, probe_label, probe_lot_number, machine_frequency, tolerance_rating, reaction_type, reaction_notes, caution_for_next_session, caution_note, electrolysis_entries(observation_chips, deleted_at)",
          )
          .eq("studio_id", studioId)
          .in("session_id", sessionIds)
          .is("deleted_at", null)
          .order("sort_order", { ascending: true })
      : Promise.resolve({ data: [] as BlockRow[], error: null }),
    supabase
      .from("clients")
      .select("id, date_of_birth, phone, address")
      .eq("studio_id", studioId)
      .in("id", ids),
  ]);
  if (blocksResult.error || clientsResult.error) return { ok: false };
  const blocks = (blocksResult.data ?? []) as BlockRow[];

  // Migration 0128: attach the structured area rows so every summary surface
  // (last treatment, appointment prep, before-today) shows EVERY treated area +
  // laterality, not just the legacy primary_area. One bounded, studio-scoped
  // query over the loaded block ids, no N+1, no cross-studio rows.
  if (blocks.length > 0) {
    const { data: areaRows, error: areasError } = await supabase
      .from("session_block_areas")
      .select("*")
      .eq("studio_id", studioId)
      .in(
        "session_block_id",
        blocks.map((b) => b.id),
      )
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (areasError) return { ok: false };
    const areasByBlock = new Map<string, SessionBlockArea[]>();
    for (const areaRow of (areaRows ?? []) as SessionBlockArea[]) {
      const bucket = areasByBlock.get(areaRow.session_block_id) ?? [];
      bucket.push(areaRow);
      areasByBlock.set(areaRow.session_block_id, bucket);
    }
    for (const block of blocks) {
      block.structured_areas = areasByBlock.get(block.id) ?? [];
    }
  }

  const clientFields = new Map(
    ((clientsResult.data ?? []) as Array<{
      id: string;
      date_of_birth: string | null;
      phone: string | null;
      address: string | null;
    }>).map((c) => [c.id, c]),
  );

  const sessionsByClient = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const list = sessionsByClient.get(s.client_id) ?? [];
    list.push(s); // already newest-first
    sessionsByClient.set(s.client_id, list);
  }
  const blocksBySession = new Map<string, BlockRow[]>();
  for (const b of blocks) {
    const list = blocksBySession.get(b.session_id) ?? [];
    list.push(b);
    blocksBySession.set(b.session_id, list);
  }

  // Per appointment, IN MEMORY. The reads above are already done; this loop
  // issues no query, which is what keeps two appointments for one client from
  // costing two round trips.
  for (const request of requests) {
    const eligible = eligibleSessionsForAppointment(
      sessionsByClient.get(request.clientId) ?? [],
      request,
    );
    previews.set(
      request.appointmentId,
      buildPreviewFromSessions({
        sessionsNewestFirst: eligible,
        blocksBySession,
        clientFields: clientFields.get(request.clientId) ?? null,
      }),
    );
  }
  return { ok: true, previews };
}
