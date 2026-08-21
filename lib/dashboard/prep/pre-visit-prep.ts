// PRE-VISIT PREP: what the practitioner can be told about the visit before this
// one, expressed so that an unread row cannot become a sentence.
//
// WHAT THIS REPLACED, AND WHY IT IS SHAPED LIKE THIS
// --------------------------------------------------
// The Dashboard used to derive its preparation lines from `BeforeTodayPreview`
// -> `TodayWorkflowItem`, a model whose central field was `hasHistory: boolean`.
// Five review rounds on PR #608 killed the same defect five times in five
// different strings, because that model has no way to distinguish the three
// answers that matter:
//
//   * we observed a fact
//   * we observed a failure
//   * we did not read far enough to know
//
// A boolean collapses the last two into the first's negation, so every negative
// sentence downstream ("No watch/plan note.", "Latest setup: Not recorded",
// "Treatment area not recorded", "New client · No charted history yet") was
// licensed by a value that could not tell "none" from "unread".
//
// The fix is not another flag. THERE IS NO FIELD HERE THAT MEANS "NOTHING
// EXISTS IN HISTORY". Every prep fact is optional, and an absent field renders
// NOTHING. A capped, sliced, filtered or failed read can therefore only make
// the surface QUIETER — never wrong.
//
// The one thing that may still speak about missing data is a
// `DirectRecordReminder`, and it cannot be constructed without a witness: an
// authoritative row that was returned, plus the name of a scalar column on it
// that was observed null. See lib/dashboard/prep/direct-record-reminder.ts.
//
// Pure. No I/O. Client-safe.

import type { DirectRecordReminder } from "@/lib/dashboard/prep/direct-record-reminder";

/** Where a fact was observed, so a render can attribute it rather than imply it. */
export type PrepFactSource = {
  sessionId: string;
  startedAt: string;
};

/** Practitioner-authored text, passed through verbatim. Never summarised here. */
export type PrepNoteFact = PrepFactSource & { text: string };

/** A concrete recorded machine setup. */
export type PrepSetupFact = PrepFactSource & {
  /** "27.12 MHz · Ballet F3 · Thermolysis · EL 14" */
  line: string;
  areaLabel: string | null;
};

/** The previous charted treatment, already reduced to what the row paints. */
export type PrepTreatmentFact = {
  /** "12 Mar 2026 · electrolysis · chin, upper lip · 25 min" — parts OMITTED when absent. */
  compactSummary: string | null;
};

/**
 * An OBSERVED operational failure. Not a claim about the client.
 *
 * `read_error` — a query returned an error we saw.
 * `window_exhausted` — a bounded read came back full, so we know we stopped
 *   early. Both are facts about THIS READ; neither says anything about what
 *   history contains, and neither is allowed to become a history sentence.
 */
export type PrepLoadFailure = { reason: "read_error" | "window_exhausted" };

/**
 * THE MODEL.
 *
 * Deliberately all-optional. There is no `hasHistory`, no `briefingComplete`,
 * no `historyKnown`, no `isTruncated`, no `maybeComplete`, no `allDataLoaded` —
 * and a source guard (tests/source-guards/prep-absence-guards.test.ts) fails the
 * build if one is reintroduced on this path, because the job of such a field is
 * always to license prose about what was not read.
 */
export type PreVisitPrep = {
  remember?: PrepNoteFact;
  caution?: PrepNoteFact;
  latestSetup?: PrepSetupFact;
  lastTreatment?: PrepTreatmentFact;
  /** Each licensed by its own witness. Never derived from a collection's size. */
  directRecordReminders: DirectRecordReminder[];
  loadFailure?: PrepLoadFailure;
};

/**
 * Did we observe anything at all worth opening?
 *
 * Read carefully: this is a POSITIVE predicate over facts we hold. `false` means
 * "we observed nothing", NOT "there is nothing". Its only consumer is the row's
 * next-action affordance, which chooses between "Review Before Today" and the
 * neutral "Open client" — two labels, neither of which asserts a relationship.
 * It must never gate a sentence.
 */
export function hasObservedPrepFact(prep: PreVisitPrep): boolean {
  return Boolean(
    prep.remember ||
      prep.caution ||
      prep.latestSetup ||
      prep.lastTreatment ||
      prep.directRecordReminders.length > 0,
  );
}

/**
 * Is there anything at all to paint under the section label?
 *
 * When this is false the whole block is omitted — QUIETLY. The old model
 * rendered "New client · No charted history yet" here, which was a claim built
 * from two capped collections.
 */
export function hasRenderablePrep(prep: PreVisitPrep): boolean {
  return hasObservedPrepFact(prep) || prep.loadFailure !== undefined;
}
