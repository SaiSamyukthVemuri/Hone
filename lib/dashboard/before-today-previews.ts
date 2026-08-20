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
import { DEFAULT_CHARTED_SESSION_LIMIT } from "@/lib/sessions/charted-session";
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

export type SessionRow = {
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

export type BlockRow = ClinicalSummaryBlock & {
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
 * ONE appointment's history, as a closed set of states.
 *
 * PRESENT     — the reads answered, and prior charted history exists before
 *               THIS appointment. Carries the preview.
 * ABSENT      — the reads answered sufficiently and establish that there is
 *               none.
 * UNAVAILABLE — the system cannot answer: a read failed, or the shared batch
 *               was truncated and this appointment's completeness could not be
 *               established.
 *
 * The preview EXISTS ONLY on the present arm. That is the point of the shape:
 * `setupLine`, `cautionNote` and `reminders` are unreachable unless a read
 * proved them, so "unknown" cannot be spelled as "null" or "[]" by accident.
 * The previous model — two booleans, `historyKnown` and `hasHistory`, either
 * of which could be false — put the burden on every consumer to remember
 * which one wins, and three consumers forgot.
 *
 * Same discipline as `CardOnFileStatus`, which distinguishes "no card" from
 * "unavailable" for exactly this reason.
 */
export type AppointmentHistory =
  | { status: "present"; preview: BeforeTodayPreview }
  | { status: "absent" }
  | { status: "unavailable" };

export type HistoryStatus = AppointmentHistory["status"];

/**
 * Whether the treatment-memory region may render.
 *
 * NOTE THE ASYMMETRY, which is the whole point: `unavailable` returns TRUE.
 * The prep-memory loader is an INDEPENDENT query with its own three-state
 * answer, and it must be allowed to speak — either with the memory it loaded
 * or with its own "could not be loaded" notice. Suppressing the region because
 * THIS load failed deletes a result that another read established, and leaves
 * the practitioner unable to tell a failure from an empty chart.
 *
 * Only a PROVEN absence hides it, because there is genuinely nothing to show.
 */
export function shouldShowTreatmentMemory(history: HistoryStatus): boolean {
  return history !== "absent";
}

/** Whether the row may offer the returning-client review affordance. */
export function shouldOfferHistoryReview(history: HistoryStatus): boolean {
  return history === "present";
}

// ---------------------------------------------------------------------------
// Query budget. TRUNCATION IS REPORTED, NOT GUESSED — the same contract
// `loadLastChartedTreatmentsForClients` states, because this loader shares one
// batched read between every client on the roster in exactly the same way.
// ---------------------------------------------------------------------------

/**
 * Per-client session window. Every session-selection this preview performs —
 * `pickLastTreatment`, `pickPreClientWatchPlanSource` — is a newest-first
 * FIRST-HIT scan, which is the same shape `DEFAULT_CHARTED_SESSION_LIMIT`
 * was sized for, so the constant is shared rather than re-guessed.
 */
const PREVIEW_SESSIONS_PER_CLIENT = DEFAULT_CHARTED_SESSION_LIMIT;

/** Hard ceiling on the shared session read, so a large day cannot ask for an
 *  unbounded payload. */
const MAX_PREVIEW_SESSION_ROWS = 300;

/**
 * Ceiling on each CHILD read (blocks, structured areas).
 *
 * Deliberately below the PostgREST `max_rows` server cap: if the server's cap
 * bound first, `rows.length >= OUR_LIMIT` would never fire and the truncation
 * would be undetectable — which is precisely the state these reads were in,
 * with no `.limit()` at all.
 */
const MAX_PREVIEW_CHILD_ROWS = 900;

/**
 * The shared session budget for one roster: each client could, in the even
 * case, fill its own window, capped so a large day cannot ask PostgREST for an
 * unbounded payload.
 */
export function previewSessionBudget(uniqueClientCount: number): number {
  return Math.min(
    PREVIEW_SESSIONS_PER_CLIENT * Math.max(0, uniqueClientCount),
    MAX_PREVIEW_SESSION_ROWS,
  );
}

/**
 * Whether a read came back at its budget, i.e. rows may have been dropped.
 *
 * `>=` rather than `>`: PostgREST can never return MORE than the limit, so `>`
 * is dead code that never fires. The cost of `>=` is a false positive at an
 * exact fit — reporting unavailable when the batch happened to be exactly
 * full. That direction is the safe one.
 */
export function isBatchTruncated(rowCount: number, budget: number): boolean {
  return rowCount >= budget;
}

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
 * History for a day's appointments, each bounded by its OWN start instant.
 *
 * EVERY requested appointment id appears in the returned map. There is no
 * page-wide "ok" flag, because completeness is not a page-wide property: a
 * shared batch can answer for one client and starve another, and one boolean
 * cannot say so.
 *
 * TRUNCATION IS REPORTED, NOT GUESSED. The reads are budgeted from the roster
 * and each one is checked against its own budget:
 *
 *   * SESSIONS truncated — the batch is ordered by global recency, so the rows
 *     that lose are the OLDEST across all clients: exactly the returning-after-
 *     a-gap client for whom history matters most. Any appointment left with no
 *     eligible session is then UNAVAILABLE, not absent — we did not read far
 *     enough to prove anything. Appointments that DID find history keep their
 *     answer, because the per-client slice is a recency prefix.
 *
 *   * BLOCKS or AREAS truncated — the whole load is UNAVAILABLE. These reads
 *     are ordered by `sort_order` / `display_order`, NOT by recency, so their
 *     truncation is not a prefix: it drops later blocks across every session at
 *     once. That does not merely omit facts, it CORRUPTS them — a dropped
 *     caution block makes a real clinical caution vanish behind "No watch/plan
 *     note.", and can promote an older session's plan as the current one. No
 *     positive claim survives it, so none is made.
 *
 *   * The CLIENT row missing — that appointment is UNAVAILABLE. Without it the
 *     briefing would emit "date of birth not recorded" / "phone not recorded" /
 *     "address not recorded" reminders that are artefacts of a short read.
 */
export async function getAppointmentHistory(
  studioId: string,
  appointments: ReadonlyArray<BeforeAppointmentRequest>,
): Promise<Map<string, AppointmentHistory>> {
  const out = new Map<string, AppointmentHistory>();
  const requests = appointments.filter(
    (a) => a.appointmentId && a.clientId && a.before,
  );
  // Anything malformed still gets an answer, and the answer is "we cannot say".
  for (const a of appointments) {
    if (!requests.includes(a)) out.set(a.appointmentId, { status: "unavailable" });
  }
  if (requests.length === 0) return out;

  const unavailableForAll = (): Map<string, AppointmentHistory> => {
    for (const r of requests) out.set(r.appointmentId, { status: "unavailable" });
    return out;
  };

  const ids = [...new Set(requests.map((r) => r.clientId))];
  // The widest cutoff any appointment on this roster asks for. Reading past it
  // would spend the row budget on sessions no appointment can use.
  const maxBefore = requests
    .map((r) => r.before)
    .reduce((a, b) => (a > b ? a : b));
  // Budget the single read so each client could, in the even case, fill its own
  // window.
  const budget = previewSessionBudget(ids.length);

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
    // Tie-break, so two sessions sharing an exact instant always resolve the
    // same way — and so the row that falls off the budget edge is stable
    // rather than varying between renders. The charted-session authority
    // orders the same way for the same reason.
    .order("id", { ascending: false })
    .limit(budget);
  if (sessionsError) return unavailableForAll();
  const sessions = (sessionRows ?? []) as SessionRow[];
  const sessionsTruncated = isBatchTruncated(sessions.length, budget);

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
          .limit(MAX_PREVIEW_CHILD_ROWS)
      : Promise.resolve({ data: [] as BlockRow[], error: null }),
    supabase
      .from("clients")
      .select("id, date_of_birth, phone, address")
      .eq("studio_id", studioId)
      .in("id", ids),
  ]);
  if (blocksResult.error || clientsResult.error) return unavailableForAll();
  const blocks = (blocksResult.data ?? []) as BlockRow[];
  if (isBatchTruncated(blocks.length, MAX_PREVIEW_CHILD_ROWS)) {
    return unavailableForAll();
  }

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
      .order("created_at", { ascending: true })
      .limit(MAX_PREVIEW_CHILD_ROWS);
    if (areasError) return unavailableForAll();
    const areaList = (areaRows ?? []) as SessionBlockArea[];
    // A truncated areas read is INDISTINGUISHABLE from legacy data downstream:
    // a block whose areas were all dropped falls back to `primary_area` and
    // renders as a perfectly ordinary single-area block. Nothing later can
    // detect it, so it has to be caught here.
    if (isBatchTruncated(areaList.length, MAX_PREVIEW_CHILD_ROWS)) {
      return unavailableForAll();
    }
    const areasByBlock = new Map<string, SessionBlockArea[]>();
    for (const areaRow of areaList) {
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
    // Already newest-first; sliced to this client's own window so the shared
    // budget cannot hand one client a deeper history than another.
    if (list.length < PREVIEW_SESSIONS_PER_CLIENT) list.push(s);
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
  for (const [appointmentId, history] of historyStatesFromBatch({
    requests,
    sessionsByClient,
    blocksBySession,
    clientFields,
    sessionsTruncated,
  })) {
    out.set(appointmentId, history);
  }
  return out;
}

/**
 * Turn one already-loaded batch into a history state PER APPOINTMENT.
 *
 * Pure, so every truncation and crowd-out rule below can be proven without a
 * database — which matters, because the failure this guards against only
 * appears when one client's history is deep enough to starve another's.
 */
export function historyStatesFromBatch(args: {
  requests: ReadonlyArray<BeforeAppointmentRequest>;
  sessionsByClient: Map<string, SessionRow[]>;
  blocksBySession: Map<string, BlockRow[]>;
  clientFields: Map<
    string,
    { date_of_birth: string | null; phone: string | null; address: string | null }
  >;
  /** The shared session read came back at its budget. */
  sessionsTruncated: boolean;
}): Map<string, AppointmentHistory> {
  const out = new Map<string, AppointmentHistory>();
  for (const request of args.requests) {
    const fields = args.clientFields.get(request.clientId);
    if (!fields) {
      // Without the client row the briefing would emit "date of birth not
      // recorded" / "phone not recorded" / "address not recorded" reminders
      // that are artefacts of a short read, not facts about the record.
      out.set(request.appointmentId, { status: "unavailable" });
      continue;
    }
    const eligible = eligibleSessionsForAppointment(
      args.sessionsByClient.get(request.clientId) ?? [],
      request,
    );
    // Nothing eligible. With a complete window that PROVES there is none; with
    // a truncated one it proves only that we did not read far enough. The
    // batch is ordered by global recency, so the clients that lose rows are
    // the ones whose last visit is oldest — exactly the returning-after-a-gap
    // client for whom this claim is most damaging.
    if (eligible.length === 0) {
      out.set(request.appointmentId, {
        status: args.sessionsTruncated ? "unavailable" : "absent",
      });
      continue;
    }
    const preview = buildPreviewFromSessions({
      sessionsNewestFirst: eligible,
      blocksBySession: args.blocksBySession,
      clientFields: fields,
    });
    // A non-empty session set can still report no history — every eligible
    // session may be an empty draft. Same rule: proven only when the window
    // was complete.
    out.set(
      request.appointmentId,
      preview.hasHistory
        ? { status: "present", preview }
        : { status: args.sessionsTruncated ? "unavailable" : "absent" },
    );
  }
  return out;
}
