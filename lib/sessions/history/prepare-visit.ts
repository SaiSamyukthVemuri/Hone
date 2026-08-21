import "server-only";
import type {
  AppointmentPrepMemory,
  PrepNarrativeItem,
} from "@/lib/sessions/appointment-prep-memory";
import {
  loadClientHistories,
  type ClientHistory,
  type HistoryRequest,
  type HistorySession,
} from "@/lib/sessions/history/select-visit";
import {
  loadHistoricalVisitDetails,
  type HistoricalVisitDetail,
  type HistoricalVisitDetailResult,
} from "@/lib/sessions/history/visit-detail";
import {
  summariseVisit,
  type HistoricalVisitSummary,
  type SetupEvidence,
  type VisitPreparation,
  type WatchPlanEvidence,
} from "@/lib/sessions/history/visit-summary";
import { matchHistorical } from "@/lib/sessions/history/window";

// THE ONE ENTRY POINT A CONSUMER CALLS.
//
// Selection, then the canonical record, then the compact projection — in that
// order, once, on the server. A consumer receives answers and never rows, so
// there is no array on any page for a later change to re-rank.
//
// TWO ROUND-TRIPS, INDEPENDENT OF HOW MANY APPOINTMENTS ARE ON SCREEN. The
// selection read is batched across clients; the detail read is batched across
// the visits the authority SELECTED — at most a handful per day, never the whole
// candidate window, and never the client's full history.

/**
 * What one surface receives for one appointment.
 *
 * `preparation` is the only part that may cross to the browser. The rest is
 * server-only, for surfaces that render the full card during the same request,
 * and is documented as such because a type that crosses the RSC boundary is
 * transported for every row whether or not it is ever opened.
 */
export type PreparedVisit = {
  preparation: VisitPreparation;
  /** SERVER ONLY. The full clinical model of the selected visit. */
  memory: AppointmentPrepMemory | null;
  /** SERVER ONLY. The canonical record the model was built from. */
  detail: HistoricalVisitDetail | null;
  /** SERVER ONLY. The selected visit's own row, for the scalars pages render. */
  session: HistorySession | null;
  /**
   * SERVER ONLY. The visit carrying watch/plan guidance, and its own record.
   *
   * FREQUENTLY A DIFFERENT VISIT from the treatment, by product rule rather than
   * by accident: guidance from an earlier visit is not hidden by a newer charted
   * visit that recorded none. A surface rendering that band needs THAT visit's
   * blocks, and the alternative — letting the page fetch them — is how a second
   * clinical projection gets born.
   */
  watchPlanVisit: {
    session: HistorySession;
    detail: HistoricalVisitDetail;
    memory: AppointmentPrepMemory;
  } | null;
  /**
   * SERVER ONLY. Practitioner narrative recovered from the CANDIDATE WINDOW,
   * independent of whether a treatment was selected.
   *
   * A plan can be written on a visit that was never charted — `start_session`
   * creates the row the moment a modality is tapped and `set_next_session_note`
   * has no charting gate — so a consultation-only visit can legitimately carry
   * "started doxycycline, do not treat" with zero blocks. Nesting this inside
   * the treatment would make it unreachable in exactly that case.
   */
  narrative: {
    plan: PrepNarrativeItem | null;
    legacySessionNotes: PrepNarrativeItem | null;
  };
};

const NO_NARRATIVE = { plan: null, legacySessionNotes: null } as const;

const NO_WATCH_PLAN_VISIT = null;

const UNAVAILABLE: VisitPreparation = {
  treatment: { kind: "evidence-unavailable", reason: "read-failed" },
  setup: { kind: "unavailable" },
  watchPlan: { kind: "unavailable" },
};

/** Collapse an answer to the row it observed, or null with its reason kept. */
function observedOr<T>(
  answer: ReturnType<ClientHistory["latestChartedVisit"]>,
): { row: HistorySession | null; state: "observed" | "none" | "unknown" | "failed" } {
  return matchHistorical<HistorySession, { row: HistorySession | null; state: "observed" | "none" | "unknown" | "failed" }>(
    answer,
    {
      observed: (row) => ({ row, state: "observed" }),
      none: () => ({ row: null, state: "none" }),
      indeterminate: () => ({ row: null, state: "unknown" }),
      failed: () => ({ row: null, state: "failed" }),
    },
  );
}

/** "27.12 MHz · Ballet F3 · Thermolysis · EL 14", from the visit's own model. */
function narrativeItem(row: HistorySession, text: string): PrepNarrativeItem {
  return { sessionId: row.id, startedAt: row.started_at, text };
}

function setupLineOf(memory: AppointmentPrepMemory): string | null {
  const area = memory.areas[0];
  if (!area) return null;
  const parts = [
    area.setup.frequency,
    area.setup.probeLine,
    area.setup.modeLabel,
    area.setup.energyLevel != null ? `EL ${area.setup.energyLevel}` : null,
  ].filter((p): p is string => Boolean(p && String(p).trim()));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The first recorded watch line on a visit — the caution's own wording. */
function cautionTextOf(memory: AppointmentPrepMemory): string | null {
  for (const area of memory.areas) {
    const note = area.outcome.cautionNote?.trim();
    if (note) return note;
    if (area.outcome.cautionFlag) return "Previously noted";
  }
  return null;
}

/**
 * Read preparation for a batch of appointments.
 *
 * Each request carries its OWN horizon and its own exclusions, so a client with
 * two bookings in a day gets two answers. Partitioning happens inside the
 * authority; nothing here receives a client-wide array to re-filter.
 */
export async function loadVisitPreparations(input: {
  studioId: string;
  requests: ReadonlyArray<HistoryRequest>;
}): Promise<Map<string, PreparedVisit>> {
  const out = new Map<string, PreparedVisit>();
  if (input.requests.length === 0) return out;

  const histories = await loadClientHistories({
    studioId: input.studioId,
    requests: input.requests,
  });

  // Only the visits the authority SELECTED are read for detail, and the expected
  // live-block count travels with each so completeness is a comparison.
  const wanted = new Map<string, number | null>();
  type Resolved = {
    history: ClientHistory | null;
    treatment: ReturnType<typeof observedOr>;
    setup: ReturnType<typeof observedOr>;
    watch: ReturnType<typeof observedOr>;
    planNote: ReturnType<typeof observedOr>;
    legacyNotes: ReturnType<typeof observedOr>;
  };
  const resolved = new Map<string, Resolved>();

  for (const request of input.requests) {
    const history = histories.get(request.requestKey) ?? null;
    if (!history) {
      resolved.set(request.requestKey, {
        history: null,
        treatment: { row: null, state: "failed" },
        setup: { row: null, state: "failed" },
        watch: { row: null, state: "failed" },
        planNote: { row: null, state: "failed" },
        legacyNotes: { row: null, state: "failed" },
      });
      continue;
    }
    const entry: Resolved = {
      history,
      treatment: observedOr(history.latestChartedVisit()),
      setup: observedOr(history.latestVisitWithSetup()),
      watch: observedOr(history.observedCaution()),
      planNote: observedOr(history.latestPlanNote()),
      legacyNotes: observedOr(history.observedLegacyNotes()),
    };
    resolved.set(request.requestKey, entry);
    for (const answer of [entry.treatment, entry.setup, entry.watch]) {
      if (answer.row) wanted.set(answer.row.id, history.expectedLiveBlocks(answer.row));
    }
  }

  const details = await loadHistoricalVisitDetails({
    studioId: input.studioId,
    sessionIds: [...wanted.keys()],
    expectedLiveBlocks: wanted,
  });

  /** Build a visit's model from its canonical record, or say why we cannot. */
  const modelFor = (
    history: ClientHistory,
    row: HistorySession,
  ): { summary: HistoricalVisitSummary; memory: AppointmentPrepMemory | null; detail: HistoricalVisitDetail | null } => {
    const result: HistoricalVisitDetailResult =
      details.get(row.id) ?? { kind: "failed" };
    if (result.kind === "failed") {
      return {
        summary: { kind: "evidence-unavailable", reason: "read-failed" },
        memory: null,
        detail: null,
      };
    }
    const built = summariseVisit({
      session: row,
      detail: result.detail,
      complete: result.kind === "complete",
      // From the row's COUNT, not from embedded rows a cap could truncate.
      hasLiveElectrolysisEntries: (history.liveEntryCount(row) ?? 0) > 0,
      supersededByUnchartedVisit: history.supersededByUnchartedVisit(row),
    });
    return { ...built, detail: result.detail };
  };

  for (const request of input.requests) {
    const entry = resolved.get(request.requestKey)!;
    if (!entry.history) {
      out.set(request.requestKey, {
        preparation: UNAVAILABLE,
        memory: null,
        detail: null,
        session: null,
        watchPlanVisit: NO_WATCH_PLAN_VISIT,
        narrative: NO_NARRATIVE,
      });
      continue;
    }
    const history = entry.history;

    // 1. THE TREATMENT — the newest charted visit.
    const treatmentModel = entry.treatment.row
      ? modelFor(history, entry.treatment.row)
      : null;
    const treatment: HistoricalVisitSummary =
      treatmentModel?.summary ??
      (entry.treatment.state === "none"
        ? { kind: "no-prior-visit" }
        : {
            kind: "evidence-unavailable",
            reason: entry.treatment.state === "failed" ? "read-failed" : "incomplete",
          });

    // 2. THE SETUP — a RECENCY claim, and frequently a different visit.
    let setup: SetupEvidence = { kind: "unavailable" };
    if (entry.setup.state === "none") {
      setup = { kind: "none-recorded" };
    } else if (entry.setup.row) {
      const model =
        entry.setup.row.id === entry.treatment.row?.id
          ? treatmentModel
          : modelFor(history, entry.setup.row);
      const line = model?.memory ? setupLineOf(model.memory) : null;
      setup = line
        ? { kind: "recorded", line, sessionId: entry.setup.row.id }
        : { kind: "unavailable" };
    }

    // 3. THE GUIDANCE — bare positive facts, which may be older than both.
    const planNote = entry.planNote.row?.next_session_note?.trim() ?? null;
    let caution: string | null = null;
    let watchModel: ReturnType<typeof modelFor> | null = null;
    if (entry.watch.row) {
      watchModel =
        entry.watch.row.id === entry.treatment.row?.id
          ? treatmentModel
          : modelFor(history, entry.watch.row);
      caution = watchModel?.memory ? cautionTextOf(watchModel.memory) : null;
    }
    let watchPlan: WatchPlanEvidence;
    if (caution || planNote) {
      watchPlan = { kind: "recorded", caution, planNote };
    } else if (entry.watch.state === "none" && entry.planNote.state === "none") {
      watchPlan = { kind: "none-recorded" };
    } else {
      watchPlan = { kind: "unavailable" };
    }

    const legacyText = entry.legacyNotes.row?.session_notes?.trim() ?? null;
    out.set(request.requestKey, {
      preparation: { treatment, setup, watchPlan },
      memory: treatmentModel?.memory ?? null,
      detail: treatmentModel?.detail ?? null,
      session: entry.treatment.row,
      watchPlanVisit:
        entry.watch.row && watchModel?.memory && watchModel.detail
          ? {
              session: entry.watch.row,
              detail: watchModel.detail,
              memory: watchModel.memory,
            }
          : null,
      narrative: {
        plan:
          entry.planNote.row && planNote
            ? narrativeItem(entry.planNote.row, planNote)
            : null,
        legacySessionNotes:
          entry.legacyNotes.row && legacyText
            ? narrativeItem(entry.legacyNotes.row, legacyText)
            : null,
      },
    });
  }

  return out;
}

/** One appointment's preparation. A thin wrapper — one implementation, one shape. */
export async function loadVisitPreparation(input: {
  studioId: string;
  clientId: string;
  before: string | null;
  excludeAppointmentId?: string | null;
  excludeSessionId?: string | null;
}): Promise<PreparedVisit> {
  const key = "prep";
  const map = await loadVisitPreparations({
    studioId: input.studioId,
    requests: [
      {
        requestKey: key,
        clientId: input.clientId,
        before: input.before,
        excludeAppointmentId: input.excludeAppointmentId ?? null,
        excludeSessionId: input.excludeSessionId ?? null,
      },
    ],
  });
  return (
    map.get(key) ?? {
      preparation: UNAVAILABLE,
      memory: null,
      detail: null,
      session: null,
      watchPlanVisit: NO_WATCH_PLAN_VISIT,
      narrative: NO_NARRATIVE,
    }
  );
}
