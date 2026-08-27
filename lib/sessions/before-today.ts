import type { LastSessionSummary } from "@/lib/sessions/clinical-summary";
import type { TreatmentIntelligence } from "@/lib/sessions/treatment-intelligence";

// PR #211: "Before today" pre-treatment briefing. Pure assembler that
// turns data the client Overview ALREADY loads (last charted
// treatment, the PR #203 pre-client watch/plan, the PR #210
// treatment intelligence, and the client's record fields) into the
// compact briefing card. Deterministic recorded-history support,
// never advice: "latest recorded", "previously noted", "watch note",
// "plan from last visit", "missing record field". Nothing is
// invented; record reminders use the same field rules as the
// Dashboard / Record Keeping completeness sweep and are NOT a legal
// compliance guarantee.
//
// PR #237: the briefing is structured as a pre-treatment reading
// order: Remember today first, then the last treatment snapshot
// (date, areas, modality, setup, probe lot, minutes), then the
// client response (tolerance, reaction, reaction notes), then record
// reminders. Same sources, same rules; only the shape changed so the
// card can render each section distinctly.

export type BeforeTodayInput = {
  lastTreatment: {
    startedAt: string;
    modality: string;
    areaNames: ReadonlyArray<string>;
    aftercareExplainedAt: string | null;
    blockLots: ReadonlyArray<string | null>;
    // Per-area recorded minutes on the last treatment, same order as
    // blockLots; summed for the snapshot.
    blockMinutes: ReadonlyArray<number | null>;
    // Per-area recorded reaction notes on the last treatment.
    blockReactionNotes: ReadonlyArray<string | null>;
  } | null;
  watchPlan: Pick<LastSessionSummary, "watchLines" | "nextSessionNote"> | null;
  intelligence: Pick<
    TreatmentIntelligence,
    "latestReactionLabel" | "latestToleranceRating" | "areas"
  >;
  client: {
    dateOfBirth: string | null;
    phone: string | null;
    address: string | null;
  };
  // CLIN-01-B. TRUE only when the caller's session_blocks read FAILED, so
  // `lastTreatment`, `watchPlan` and `intelligence` carry NOTHING KNOWN rather
  // than nothing recorded. Optional and defaulting to false so the dashboard
  // preview caller, which carries unavailability on its own prep summary, is
  // untouched.
  //
  // This does NOT redefine what a charted treatment is. Selection is unchanged;
  // this records only whether the read feeding selection succeeded.
  clinicalUnavailable?: boolean;
  // CLIN-BEFORE-TODAY-F2. TRUE only when the caller's CLIENTS read failed, so
  // the three fields above are UNKNOWN rather than blank. A blank field is a
  // record gap worth showing; an unread one is not, and "Client phone not
  // recorded" states something about a row nobody looked at.
  //
  // Deliberately INDEPENDENT of `clinicalUnavailable`: these are two different
  // reads and either can fail while the other returns. A failed clinical read
  // must not suppress true record reminders, and a failed client read must not
  // blank a history that was read.
  //
  // Optional and defaulting to false, so callers that load the client row on
  // the same query as everything else are untouched.
  clientRecordUnavailable?: boolean;
};

export type BeforeToday = {
  // CLIN-01-B. Read this FIRST. When true every clinical field below is
  // UNKNOWN, not absent — including `hasHistory: false`, which here means "we
  // could not find out", never "this client has none". A consumer that branches
  // on `hasHistory` without checking this turns a failed read back into a
  // confident clinical denial, which is the defect this field exists to
  // prevent.
  unavailable: boolean;
  hasHistory: boolean;
  lastTreated: {
    startedAt: string;
    modality: string;
    areasLine: string | null;
    // Total recorded minutes on the last treatment; null when none
    // were recorded.
    minutes: number | null;
    // Distinct recorded probe lot(s) on the last treatment; null when
    // none were recorded.
    probeLot: string | null;
  } | null;
  // Watch and plan notes only; the client response moved to its own
  // section (PR #237).
  remember: {
    watchLines: string[];
    plan: string | null;
    hasNotes: boolean;
  };
  // Client response, last recorded: tolerance and reaction from the
  // treatment intelligence (latest recorded across history), reaction
  // notes from the last treatment when present.
  response: {
    toleranceRating: number | null;
    reactionLabel: string | null;
    reactionNotes: string | null;
    hasAny: boolean;
  };
  // Last recorded setup from the most recently treated area, split
  // for chip rendering; null when nothing was recorded.
  setup: {
    frequency: string | null;
    probe: string | null;
    modeLabel: string | null;
    energyLevel: number | null;
    // PR #268 (chart parts): which treatment area this latest setup was
    // recorded on, so the memory card can name it ("Latest recorded setup
    // Chin") instead of showing unlabeled chips. null for legacy data.
    areaName: string | null;
  } | null;
  // "27.12 MHz · Ballet F3 · Thermolysis · EL 14" joined form, kept
  // for the Dashboard Today compact preview (PR #212).
  latestSetupLine: string | null;
  reminders: string[];
};

function joinAreas(names: ReadonlyArray<string>): string | null {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

const EMPTY_REMEMBER = { watchLines: [], plan: null, hasNotes: false };
const EMPTY_RESPONSE = {
  toleranceRating: null,
  reactionLabel: null,
  reactionNotes: null,
  hasAny: false,
};

// Reminders that come from the CLIENT RECORD, loaded by a DIFFERENT read. They
// stay true, and stay shown, even when the clinical read failed: nothing here
// is derived from session_blocks.
//
// The converse holds too, and is why the outcome of that read is a parameter
// rather than an assumption. Every field arrives `null` when the clients read
// fails, so an unguarded sweep emits all three reminders at once and the row
// reports a record gap that nobody has established.
function clientRecordReminders(
  client: BeforeTodayInput["client"],
  unavailable: boolean,
): string[] {
  if (unavailable) return [];
  const reminders: string[] = [];
  if (!client.dateOfBirth) reminders.push("Client date of birth not recorded");
  if (!client.phone?.trim()) reminders.push("Client phone not recorded");
  if (!client.address?.trim()) reminders.push("Client address not recorded");
  return reminders;
}

export function buildBeforeToday(input: BeforeTodayInput): BeforeToday {
  const { lastTreatment, watchPlan, intelligence, client } = input;
  const clientRecordUnavailable = input.clientRecordUnavailable === true;

  // CLIN-01-B: the clinical read failed. Every clinical claim this builder
  // would otherwise make is unknown, so none is made — in particular the
  // procedure-record reminders, whose EMPTINESS the card renders as "Procedure
  // record looks complete based on recorded fields.", a completeness claim
  // nobody can make about a history that was not read.
  if (input.clinicalUnavailable) {
    return {
      unavailable: true,
      hasHistory: false,
      lastTreated: null,
      remember: { ...EMPTY_REMEMBER },
      response: { ...EMPTY_RESPONSE },
      setup: null,
      latestSetupLine: null,
      reminders: clientRecordReminders(client, clientRecordUnavailable),
    };
  }

  if (!lastTreatment) {
    return {
      unavailable: false,
      hasHistory: false,
      lastTreated: null,
      remember: { ...EMPTY_REMEMBER, watchLines: [] },
      response: { ...EMPTY_RESPONSE },
      setup: null,
      latestSetupLine: null,
      reminders: [],
    };
  }

  const watchLines = (watchPlan?.watchLines ?? []).filter(
    (l) => l.trim().length > 0,
  );
  const plan = watchPlan?.nextSessionNote?.trim() || null;

  // Latest recorded setup: the most recently treated area's latest
  // block (intelligence.areas is sorted newest-first by lastTreated).
  const latestArea = intelligence.areas[0] ?? null;
  const setup =
    latestArea &&
    (latestArea.latestFrequency ||
      latestArea.latestProbe ||
      latestArea.latestModeLabel ||
      latestArea.latestEnergyLevel != null)
      ? {
          frequency: latestArea.latestFrequency,
          probe: latestArea.latestProbe,
          modeLabel: latestArea.latestModeLabel,
          energyLevel: latestArea.latestEnergyLevel,
          areaName: latestArea.name?.trim() || null,
        }
      : null;
  const latestSetupLine = setup
    ? [
        setup.frequency,
        setup.probe,
        setup.modeLabel,
        setup.energyLevel != null ? `EL ${setup.energyLevel}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null
    : null;

  // Last treatment snapshot extras: total recorded minutes and the
  // distinct recorded probe lot(s), both from data already loaded.
  const minutesTotal = lastTreatment.blockMinutes.reduce<number>(
    (sum, m) =>
      typeof m === "number" && Number.isFinite(m) && m > 0 ? sum + m : sum,
    0,
  );
  const distinctLots = [
    ...new Set(
      lastTreatment.blockLots
        .map((l) => l?.trim())
        .filter((l): l is string => !!l),
    ),
  ];
  const probeLot = distinctLots.length > 0 ? distinctLots.join(", ") : null;

  // Client response, last recorded. Reaction notes: the first
  // recorded note on the last treatment's areas.
  const reactionNotes =
    lastTreatment.blockReactionNotes
      .map((n) => n?.trim())
      .find((n): n is string => !!n) ?? null;
  const response = {
    toleranceRating: intelligence.latestToleranceRating,
    reactionLabel: intelligence.latestReactionLabel,
    reactionNotes,
    hasAny:
      intelligence.latestToleranceRating != null ||
      intelligence.latestReactionLabel != null ||
      reactionNotes != null,
  };

  // Record reminders: same field rules as the procedure-record
  // completeness sweep, scoped to THIS client's most recent charted
  // treatment.
  const reminders: string[] = [];
  const lotsMissing = lastTreatment.blockLots.filter(
    (l) => !l?.trim(),
  ).length;
  if (lastTreatment.blockLots.length > 0 && lotsMissing > 0) {
    reminders.push(
      "Probe lot number needed before the procedure record is complete",
    );
  }
  if (lastTreatment.blockLots.length === 0) {
    reminders.push("Treatment area not recorded on the last session");
  }
  if (!lastTreatment.aftercareExplainedAt) {
    reminders.push("Aftercare/risks not marked on the last session");
  }
  reminders.push(...clientRecordReminders(client, clientRecordUnavailable));

  return {
    unavailable: false,
    hasHistory: true,
    lastTreated: {
      startedAt: lastTreatment.startedAt,
      modality: lastTreatment.modality,
      areasLine: joinAreas(lastTreatment.areaNames),
      minutes: minutesTotal > 0 ? minutesTotal : null,
      probeLot,
    },
    remember: {
      watchLines,
      plan,
      hasNotes: watchLines.length > 0 || !!plan,
    },
    response,
    setup,
    latestSetupLine,
    reminders,
  };
}
