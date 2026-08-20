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

describe("Today never contradicts itself about the relationship", () => {
  it("the no-history line requires BOTH authorities to agree", () => {
    // workflow says none, prep PROVED none, and prep actually answered.
    // …and only on TODAY. "New client" is a relationship claim; off Today the
    // page does not pose that question, so it states the bounded fact instead.
    expect(CODE).toMatch(
      /\{isToday &&\s*!workflow\.hasHistory &&\s*!prepSummary\.hasTreatment &&\s*!prepSummary\.unavailable \? \(/,
    );
  });

  it("a proven treatment or an unanswered read suppresses the claim", () => {
    // The middle arm says nothing rather than asserting the opposite.
    expect(CODE).toMatch(/\) : !workflow\.hasHistory \? \(\s*null\s*\) : \(/);
  });

  it("the unguarded form is gone", () => {
    expect(CODE).not.toMatch(/\{!workflow\.hasHistory \? \(/);
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

describe("off Today the page states a bounded fact, never a relationship", () => {
  it("the no-history CLAIM is gated on isToday", () => {
    expect(CODE).toMatch(/\{isToday &&/);
  });

  it("off Today it says what it can prove about THIS visit instead", () => {
    expect(CODE).toMatch(/No prior charted treatment before this visit/);
    // …and says nothing at all when the read could not answer.
    expect(CODE).toMatch(/prepSummary\.unavailable \? null : \(/);
  });

  it("the temporal label is date-correct", () => {
    expect(CODE).toMatch(/isToday \? "Before today" : "Before this visit"/);
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
    // …while the treatment-derived fact correctly does not.
    expect(item.setup).toBeNull();
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
