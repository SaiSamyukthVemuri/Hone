import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  toDashboardPrepSummary,
  toDisclosureSummary,
} from "@/lib/dashboard/dashboard-prep-summary";
import { resolveDayNextAction } from "@/lib/dashboard/day-next-action";
import { buildTodayWorkflow } from "@/lib/dashboard/today-workflow";

// TODAY CARRIES TWO INDEPENDENT EVIDENCE SOURCES.
//
//   A. the Before-Today workflow  (boolean, no truncation channel, no void
//      filter, discards read errors)
//   B. the appointment-prep loader (three-state, void-filtered, reports
//      truncation)
//
// They can disagree. Once B renders on its own authority — which is what makes
// a future day useful — the unguarded form could print
// "New client · No charted history yet" directly above "Last treatment: …" for
// the same person, and route her through the brand-new-client action.

const PAGE = readFileSync(
  join(process.cwd(), "app/(app)/dashboard/page.tsx"),
  "utf8",
);
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const DISCLOSURE = readFileSync(
  join(process.cwd(), "app/(app)/dashboard/dashboard-treatment-memory.tsx"),
  "utf8",
);

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

describe("THE DASHBOARD NEVER MAKES A HISTORY-ABSENCE CLAIM", () => {
  // The rule that replaced four rounds of completeness bookkeeping.
  //
  // Each earlier round licensed an absence claim from one more completeness
  // signal, and the next unreported narrowing point produced the next false
  // negative: the global row budget, then the per-client slice, then the
  // PostgREST cap on the block read. The claims are now GONE, so no signal is
  // load-bearing and there is no next narrowing point to miss.
  const ABSENCE_CLAIMS = [
    "No watch/plan note.",
    "Not recorded",
    "No prior charted treatment",
    "New client",
    "Returning client",
    "No charted history",
  ];

  it("none of the deleted claims survives anywhere in the page", () => {
    for (const claim of ABSENCE_CLAIMS) {
      expect(CODE, claim).not.toContain(claim);
    }
  });

  it("no completeness flag is consulted, because none is needed", () => {
    // If this reappears, the absence claims are on their way back with it.
    expect(CODE).not.toMatch(/briefingComplete/);
  });

  it("the history state no longer gates ANY rendered preparation fact", () => {
    // `hasHistory` still resolves the row's primary ACTION, which degrades to
    // the neutral "Open client" when the question was not asked. What it must
    // never do again is decide whether a fact Hone READ gets painted.
    expect(CODE).not.toMatch(/workflow\.hasHistory \? \(/);
    expect(CODE).not.toMatch(/\{!workflow\.hasHistory \? \(/);
    expect(CODE).not.toMatch(/hasHistory && workflow\.(remember|caution|setup)/);
  });
});

describe("the TODAY ACTION MATRIX — four cases, no false claim", () => {
  const base = {
    clientId: "c1",
    appointmentId: "a1",
    sessionId: null as string | null,
    hasChartedArea: false,
    status: "confirmed",
  };
  const summary = (over: Partial<ReturnType<typeof toDashboardPrepSummary>>) => ({
    hasTreatment: false,
    unavailable: false,
    compactSummary: null,
    remember: null,
    ...over,
  });

  // Mirrors the page's expression so the matrix is exercised, not just read.
  function historyFor(
    historyAsked: boolean,
    workflowHasHistory: boolean | null,
    prep: ReturnType<typeof summary>,
  ) {
    const wf = workflowHasHistory ?? false;
    if (!historyAsked) return { asked: false as const };
    if (prep.unavailable && !wf) return { asked: false as const };
    return { asked: true as const, hasHistory: wf || prep.hasTreatment };
  }

  it("1. workflow true + prep treatment -> returning affordance", () => {
    const h = historyFor(true, true, summary({ hasTreatment: true }));
    expect(resolveDayNextAction({ ...base, history: h }).label).toBe(
      "Review Before Today",
    );
  });

  it("2. workflow false + prep proved none -> the new-client affordance is allowed", () => {
    const h = historyFor(true, false, summary({}));
    expect(h).toEqual({ asked: true, hasHistory: false });
    expect(resolveDayNextAction({ ...base, history: h }).label).toBe("Open client");
  });

  it("3. workflow false + prep PROVED a treatment -> NOT routed as new", () => {
    // The contradiction case. The prep loader proved history; the workflow's
    // boolean cannot be allowed to override proof.
    const h = historyFor(true, false, summary({ hasTreatment: true }));
    expect(h).toEqual({ asked: true, hasHistory: true });
    expect(resolveDayNextAction({ ...base, history: h }).label).toBe(
      "Review Before Today",
    );
  });

  it("4. workflow false + prep UNAVAILABLE -> not asked, neutral action", () => {
    // An unanswered read is not evidence of a new client, so the question is
    // treated as unposed rather than answered "no".
    const h = historyFor(true, false, summary({ unavailable: true }));
    expect(h).toEqual({ asked: false });
    expect(resolveDayNextAction({ ...base, history: h }).label).toBe("Open client");
  });

  it("workflow TRUE survives an unavailable prep read", () => {
    // Its own authority already proved history; a failed second read must not
    // downgrade it.
    const h = historyFor(true, true, summary({ unavailable: true }));
    expect(h).toEqual({ asked: true, hasHistory: true });
  });

  it("off Today the question is never posed, whatever prep says", () => {
    for (const prep of [
      summary({}),
      summary({ hasTreatment: true }),
      summary({ unavailable: true }),
    ]) {
      expect(historyFor(false, null, prep)).toEqual({ asked: false });
    }
  });

  it("the page implements exactly this expression", () => {
    expect(CODE).toMatch(/history: !historyAsked\s*\?\s*\{ asked: false \}/);
    expect(CODE).toMatch(
      /prepSummary\.unavailable && !\(workflow\?\.hasHistory \?\? false\)\s*\?\s*\{ asked: false \}/,
    );
    expect(CODE).toMatch(
      /hasHistory:\s*\(workflow\?\.hasHistory \?\? false\) \|\| prepSummary\.hasTreatment/,
    );
  });
});

describe("off Today the page states no relationship and no absence", () => {
  it("nothing about the relationship is stated on ANY day", () => {
    // This used to prove the claim was gated on `isToday` so it could not
    // escape onto a future day. Deleting it is the stronger property: there
    // is no longer a claim whose placement could be got wrong.
    expect(CODE).not.toMatch(/New client/);
    expect(CODE).not.toMatch(/No prior charted treatment before this visit/);
  });

  it("`isToday` survives ONLY as the temporal label", () => {
    // The label is a calendar fact, not a history inference: it says which
    // window the facts below were drawn from, and asserts nothing about what
    // is in it.
    expect(CODE).toMatch(/isToday \? "Before today" : "Before this visit"/);
  });

  it("the same positive grammar is emitted for every day", () => {
    // One render path. No `isToday` branch may add or remove a prep fact.
    const block = CODE.slice(CODE.indexOf("{workflow && ("));
    const grammar = block.slice(0, block.indexOf("missingRecords"));
    expect(grammar).toContain("{workflow.remember && (");
    expect(grammar).toContain("{workflow.caution && (");
    expect(grammar).toContain("{workflow.setup && (");
    // exactly one isToday in the grammar: the label itself
    expect((grammar.match(/isToday/g) ?? []).length).toBe(1);
  });
});

describe("a recorded instruction does not depend on proving treatment", () => {
  it("the workflow model carries Remember when hasHistory is FALSE", () => {
    const [item] = buildTodayWorkflow([
      {
        appointmentId: "a1",
        clientId: "c1",
        clientName: "Someone",
        timeLabel: "9:00 AM",
        status: "confirmed",
        serviceName: null,
        hasHistory: false,
        nextVisitNote: "Started doxycycline, do not treat",
        cautionNote: null,
        setupLine: "27.12 MHz",
        reminders: [],
        intake: "reviewed",
        charting: "none",
      },
    ]).items;
    // The instruction survives…
    expect(item.remember).toBe("Started doxycycline, do not treat");
    // …AND SO DOES THE SETTING. This previously asserted `null`, on the
    // reasoning that "Latest setup" against a client with no charted history
    // is noise "because the no-history state says it already". That state no
    // longer says anything — the absence claims are deleted — so the old gate
    // would now silently drop a concrete value Hone actually read.
    expect(item.setup).toBe("27.12 MHz");
  });

  it("the page renders Remember BEFORE the history-state branches", () => {
    // It used to live inside the has-history arm, so a note-only visit — the
    // case where the instruction matters most — silently lost it.
    const remember = CODE.indexOf("Remember: {workflow.remember}");
    const firstBranch = CODE.indexOf("{isToday &&");
    expect(remember).toBeGreaterThan(-1);
    expect(firstBranch).toBeGreaterThan(-1);
    expect(remember).toBeLessThan(firstBranch);
  });

  it("there is exactly ONE Remember renderer", () => {
    // Hoisting it must not leave a second copy behind: an ordinary returning
    // client would then read the same note twice.
    expect((CODE.match(/Remember: \{workflow\.remember\}/g) ?? []).length).toBe(1);
  });
});

describe("positive facts render on their own authority", () => {
  it("Remember, Caution and Latest setup are each independent", () => {
    // Each is a fact Hone READ. None may be gated on proving that some OTHER
    // fact exists, and none needs a complete-history proof.
    expect(CODE).toMatch(/\{workflow\.remember && \(/);
    expect(CODE).toMatch(/\{workflow\.caution && \(/);
    expect(CODE).toMatch(/\{workflow\.setup && \(/);
  });

  it("the setup VALUE renders with no absence companion", () => {
    expect(CODE).toMatch(/Latest setup: \{workflow\.setup\}/);
    expect(CODE).not.toMatch(/workflow\.setup \?\? /);
  });

  it("READ FAILURE is still reported — it is not the same as absence", () => {
    // "The read failed" is an operational fact worth stating. "No positive
    // fact was found" is not, because the window cannot prove it. Collapsing
    // the two in either direction is the error this file guards.
    // The page's job is to keep routing a FAILED read into the disclosure…
    expect(CODE).toMatch(
      /\{\(prepSummary\.hasTreatment \|\| prepSummary\.unavailable\) && \(/,
    );
    // …which is where the calm failure sentence itself lives.
    expect(DISCLOSURE).toMatch(/Previous treatment could not be loaded/);
  });
});
