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

export type BeforeTodayInput = {
  lastTreatment: {
    startedAt: string;
    modality: string;
    areaNames: ReadonlyArray<string>;
    aftercareExplainedAt: string | null;
    blockLots: ReadonlyArray<string | null>;
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
};

export type BeforeToday = {
  hasHistory: boolean;
  lastTreated: {
    startedAt: string;
    modality: string;
    areasLine: string | null;
  } | null;
  remember: {
    watchLines: string[];
    plan: string | null;
    latestReactionLabel: string | null;
    latestToleranceRating: number | null;
    hasNotes: boolean;
  };
  // "27.12 MHz · Ballet F3 · Thermolysis · EL 14" from the most
  // recently treated area's latest recorded setup; null when nothing
  // was recorded.
  latestSetupLine: string | null;
  reminders: string[];
};

function joinAreas(names: ReadonlyArray<string>): string | null {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

export function buildBeforeToday(input: BeforeTodayInput): BeforeToday {
  const { lastTreatment, watchPlan, intelligence, client } = input;

  if (!lastTreatment) {
    return {
      hasHistory: false,
      lastTreated: null,
      remember: {
        watchLines: [],
        plan: null,
        latestReactionLabel: null,
        latestToleranceRating: null,
        hasNotes: false,
      },
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
  const latestSetupLine = latestArea
    ? [
        latestArea.latestFrequency,
        latestArea.latestProbe,
        latestArea.latestModeLabel,
        latestArea.latestEnergyLevel != null
          ? `EL ${latestArea.latestEnergyLevel}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || null
    : null;

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
  if (!client.dateOfBirth) reminders.push("Client date of birth not recorded");
  if (!client.phone?.trim()) reminders.push("Client phone not recorded");
  if (!client.address?.trim()) reminders.push("Client address not recorded");

  return {
    hasHistory: true,
    lastTreated: {
      startedAt: lastTreatment.startedAt,
      modality: lastTreatment.modality,
      areasLine: joinAreas(lastTreatment.areaNames),
    },
    remember: {
      watchLines,
      plan,
      latestReactionLabel: intelligence.latestReactionLabel,
      latestToleranceRating: intelligence.latestToleranceRating,
      hasNotes: watchLines.length > 0 || !!plan,
    },
    latestSetupLine,
    reminders,
  };
}
