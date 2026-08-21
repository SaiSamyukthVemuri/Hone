import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  toDashboardPrepSummary,
  toDisclosureSummary,
} from "@/lib/dashboard/dashboard-prep-summary";
import { resolveDayNextAction } from "@/lib/dashboard/day-next-action";
import {
  hasObservedPrepFact,
  type PreVisitPrep,
} from "@/lib/dashboard/prep/pre-visit-prep";

// THE DASHBOARD MAKES NO CLAIM ABOUT THE RELATIONSHIP.
//
// It used to carry TWO independent evidence sources for that claim:
//
//   A. the Before-Today workflow  (a boolean: no truncation channel, no void
//      filter, no appointment bound, and `error` discarded on all four reads)
//   B. the appointment-prep loader (three-state, void-filtered, appointment-
//      bounded, reports truncation of its session read)
//
// A guard required both to agree before the row printed "New client · No
// charted history yet". That guard was the best available fix at the time and
// it still could not be right, because both sources go silent for the SAME
// reason: A's swallowed error empties the whole roster, and B's truncation flag
// describes only its session read, not the bounded block read beneath it.
//
// A is gone. What replaced the claim is not a better guard but a different
// shape: the row renders facts it observed, and when it observed none it says
// NOTHING. Proving that a client has no history requires a complete read of
// their history; this page never performs one and does not need to.

const PAGE = readFileSync(
  join(process.cwd(), "app/(app)/dashboard/page.tsx"),
  "utf8",
);
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the disclosure projection cannot carry the plan note", () => {
  it("drops `remember` AT RUNTIME, not merely in the type", () => {
    // The RSC serializer follows the OBJECT, not the annotation. Narrowing
    // only the type would leave the note on the wire while the code looked
    // correct.
    const full = toDashboardPrepSummary({
      memory: null,
      unavailable: false,
      planNote: "SENTINEL-PLAN-NOTE",
    });
    expect(full.remember).toBe("SENTINEL-PLAN-NOTE");

    const narrow = toDisclosureSummary(full);
    expect(Object.keys(narrow).sort()).toEqual([
      "compactSummary",
      "hasTreatment",
      "unavailable",
    ]);
    expect(JSON.stringify(narrow)).not.toContain("SENTINEL-PLAN-NOTE");
    expect("remember" in narrow).toBe(false);
  });

  it("the page passes the NARROW projection to the client component", () => {
    expect(CODE).toMatch(/summary=\{toDisclosureSummary\(prepSummary\)\}/);
    expect(CODE).not.toMatch(/summary=\{prepSummary\}/);
  });

  it("the client component's prop type is the narrow one", () => {
    const COMPONENT = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/dashboard-treatment-memory.tsx"),
      "utf8",
    );
    expect(COMPONENT).toMatch(/summary: DashboardTreatmentDisclosureSummary/);
    expect(COMPONENT).not.toMatch(/summary\.remember/);
  });
});

describe("the relationship is never asserted, in either direction", () => {
  it("the two-authority guard is gone, along with the claim it guarded", () => {
    // It was good design for what it was: it required the Before-Today workflow
    // AND the prep loader to agree before calling anyone new, and it treated an
    // unanswered prep read as a veto. It still could not be right, because BOTH
    // authorities could be silent for the same reason — the Before-Today
    // pipeline never bound `error` on any of its four reads, so one failed query
    // made the whole roster read as "no history", and the prep loader's own
    // truncation flag described only its SESSION read.
    //
    // The claim is now unrepresentable rather than guarded.
    expect(CODE).not.toMatch(/New client/);
    expect(CODE).not.toMatch(/No charted history/);
    expect(CODE).not.toMatch(/workflow\.hasHistory/);
    expect(CODE).not.toMatch(/workflow\?\.hasHistory/);
    // The POSITIVE form survives — `{ asked: true, hasHistory: true }` says we
    // observed something. It is the FALSE form, the one that claims a client
    // has no history, that no longer exists on this page.
    expect(CODE).not.toMatch(/hasHistory: false/);
    expect(CODE).not.toMatch(/hasHistory:\s*\(/);
  });

  it("nothing on the row asserts an ABSENCE of history", () => {
    for (const claim of [
      /No watch\/plan note/,
      /Not recorded/,
      /No prior charted treatment/,
      /No charted history yet/,
      /Treatment area not recorded/,
      /No previous treatment to show/,
    ]) {
      expect(CODE).not.toMatch(claim);
    }
  });
});

describe("the history question — asked ONE way, and only positively", () => {
  const base = {
    clientId: "c1",
    appointmentId: "a1",
    sessionId: null as string | null,
    hasChartedArea: false,
    status: "confirmed",
  };

  // Mirrors the page's expression so the rule is exercised, not just read.
  function historyFor(historyAsked: boolean, observed: boolean) {
    return historyAsked && observed
      ? ({ asked: true, hasHistory: true } as const)
      : ({ asked: false } as const);
  }

  const prep = (over: Partial<PreVisitPrep> = {}): PreVisitPrep => ({
    directRecordReminders: [],
    ...over,
  });

  const note = { sessionId: "s1", startedAt: "2026-01-01T00:00:00Z", text: "x" };

  it("a treatment we observed routes to the returning affordance", () => {
    const p = prep({ lastTreatment: { compactSummary: "12 Mar 2026" } });
    expect(hasObservedPrepFact(p)).toBe(true);
    expect(
      resolveDayNextAction({ ...base, history: historyFor(true, true) }).label,
    ).toBe("Review Before Today");
  });

  it("a plan note ALONE is enough — a note-only visit is still history", () => {
    // The case that used to vanish: a consultation-only or abandoned visit
    // carries a safety instruction and zero charting.
    expect(hasObservedPrepFact(prep({ remember: note }))).toBe(true);
  });

  it("a caution alone, and a setup alone, each count", () => {
    expect(hasObservedPrepFact(prep({ caution: note }))).toBe(true);
    expect(
      hasObservedPrepFact(
        prep({
          latestSetup: { ...note, line: "27.12 MHz", areaLabel: null },
        }),
      ),
    ).toBe(true);
  });

  it("observing NOTHING is NOT ASKED — never an answer of 'no'", () => {
    // THE LOAD-BEARING CASE. `{ asked: true, hasHistory: false }` would be a
    // claim that this client has no history, which needs a COMPLETE read of
    // their history. The Dashboard never performs one and does not need to.
    const p = prep();
    expect(hasObservedPrepFact(p)).toBe(false);
    expect(historyFor(true, false)).toEqual({ asked: false });
    // Both arms still resolve to a neutral affordance, so no practitioner-facing
    // label changed — only the page's willingness to assert.
    expect(
      resolveDayNextAction({ ...base, history: historyFor(true, false) }).label,
    ).toBe("Open client");
  });

  it("a failed read is not evidence of a new client", () => {
    const p = prep({ loadFailure: { reason: "read_error" } });
    expect(hasObservedPrepFact(p)).toBe(false);
    expect(historyFor(true, hasObservedPrepFact(p))).toEqual({ asked: false });
  });

  it("off Today the question is never posed, whatever prep says", () => {
    for (const p of [
      prep(),
      prep({ lastTreatment: { compactSummary: "x" } }),
      prep({ loadFailure: { reason: "read_error" } }),
    ]) {
      expect(historyFor(false, hasObservedPrepFact(p))).toEqual({ asked: false });
    }
  });

  it("the page implements exactly this expression", () => {
    expect(CODE).toMatch(
      /history:\s*historyAsked && hasObservedPrepFact\(prep\)\s*\?\s*\{ asked: true, hasHistory: true \}\s*:\s*\{ asked: false \}/,
    );
    // And never the branch that asserts an absence.
    expect(CODE).not.toMatch(/hasHistory: false/);
  });
});
