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
// Performance: THREE batched reads for the whole roster (sessions for
// all of today's clients, their blocks, the client record fields) --
// never one query per appointment. Today rosters are small; reads
// are capped defensively. Read-only; recorded-history wording only.

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

export async function getBeforeTodayPreviews(
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, BeforeTodayPreview>> {
  const out = new Map<string, BeforeTodayPreview>();
  const ids = [...new Set(clientIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const supabase = await createClient();
  const { data: sessionRows } = await supabase
    .from("sessions")
    .select(
      "id, client_id, started_at, next_session_note, aftercare_and_risks_explained_at, modality, electrolysis_entries(hairs_treated, deleted_at), laser_entries(id, deleted_at)",
    )
    .eq("studio_id", studioId)
    .in("client_id", ids)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(400);
  const sessions = (sessionRows ?? []) as SessionRow[];

  const sessionIds = sessions.map((s) => s.id);
  const [{ data: blockRows }, { data: clientRows }] = await Promise.all([
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
      : Promise.resolve({ data: [] as BlockRow[] }),
    supabase
      .from("clients")
      .select("id, date_of_birth, phone, address")
      .eq("studio_id", studioId)
      .in("id", ids),
  ]);
  const blocks = (blockRows ?? []) as BlockRow[];

  // Migration 0128: attach the structured area rows so every summary surface
  // (last treatment, appointment prep, before-today) shows EVERY treated area +
  // laterality, not just the legacy primary_area. One bounded, studio-scoped
  // query over the loaded block ids — no N+1, no cross-studio rows.
  if (blocks.length > 0) {
    const { data: areaRows } = await supabase
      .from("session_block_areas")
      .select("*")
      .eq("studio_id", studioId)
      .in(
        "session_block_id",
        blocks.map((b) => b.id),
      )
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: true });
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
    ((clientRows ?? []) as Array<{
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

  for (const clientId of ids) {
    const clientSessions = (sessionsByClient.get(clientId) ?? []).map((s) => ({
      ...s,
      // Migration 0114: voided passes never count in the dashboard preview.
      electrolysis_entries: (s.electrolysis_entries ?? []).filter(
        (e) => !e.deleted_at,
      ),
      laser_entries: (s.laser_entries ?? []).filter((e) => !e.deleted_at),
    }));
    const clientBlockMap = new Map<string, BlockRow[]>();
    for (const s of clientSessions) {
      const list = blocksBySession.get(s.id);
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
    const fields = clientFields.get(clientId);
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
            blockReactionNotes: lastBlocks.map(
              (b) => b.reaction_notes ?? null,
            ),
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
    out.set(clientId, compactBeforeToday(briefing));
  }
  return out;
}
