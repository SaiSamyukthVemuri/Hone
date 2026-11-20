import { describe, expect, it } from "vitest";
import { COMPOSED_DASHBOARD } from "./helpers/composed-dashboard";

// The day-navigation ARITHMETIC is proved in tests/lib/dashboard, and the
// navigation itself in the browser (e2e/dashboard-day-navigation.spec.ts). This
// file keeps the page-wiring pins those cannot see: actual-today is never the
// selected day, the roster window is DST-correct, and off Today the page asks
// no history question at all.

// PERF-01C: the secondary stack (To do, Birthdays, snapshot, setup cards) now
// renders from app/(app)/dashboard/secondary-stack.tsx behind a Suspense
// boundary, so the day's roster no longer waits on studio paperwork. These
// assertions are about what RENDERS and in what order, so they read the
// COMPOSED source (page with the child spliced in where it renders) rather
// than half the page. See tests/app/dashboard/helpers/composed-dashboard.ts.
const PAGE = COMPOSED_DASHBOARD;
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CODE = strip(PAGE);

describe("actual today is its own value, never the selected day", () => {
  it("actual-today is still its own value and is NOT redefined from the URL", () => {
    // The single most dangerous edit in this feature. `todayLocal` also drives
    // birthdays, the sterile-supply expiry horizon, the To-do supply labels and
    // the birthday "Today" badge — none of which may follow a day the
    // practitioner is merely LOOKING at.
    expect(CODE).toMatch(/const todayLocal = todayInTz\(studio\.timezone\)/);
    expect((CODE.match(/const todayLocal =/g) ?? []).length).toBe(1);
    expect(CODE).not.toMatch(/todayLocal = selectedDay/);
  });

  it("the surfaces anchored to ACTUAL today still read todayLocal", () => {
    expect(CODE).toMatch(/getClientBirthdaysForMonth\([^)]*todayLocal/s);
    expect(CODE).toMatch(/getExpiringSterileItems\(studio\.id, todayLocal\)/);
    expect(CODE).toMatch(/todayLocal,\s*\}\)/); // buildDashboardTodo
  });
});

describe("the roster window is the SELECTED day, and it is DST-correct", () => {
  it("both bounds come from local midnight — never start-plus-24h", () => {
    // A Toronto day is 23 or 25 hours twice a year. `start + 86_400_000` drops
    // a real appointment on the fall-back day.
    expect(CODE).toMatch(
      /utcInstantFromLocal\(selectedDayLocal, "00:00", studio\.timezone\)/,
    );
    expect(CODE).toMatch(
      /utcInstantFromLocal\(selectedDayEndLocal, "00:00", studio\.timezone\)/,
    );
    expect(CODE).toMatch(/const selectedDayEndLocal = addDays\(selectedDayLocal, 1\)/);
    expect(CODE).not.toMatch(/86_?400_?000|24 \* 60 \* 60 \* 1000/);
  });
});

describe("OFF TODAY THE PAGE ASKS NO HISTORY QUESTION — the load-bearing rule", () => {
  it("the BEFORE-TODAY loader is still skipped off Today", () => {
    // This is the retired model: its only output channel is a boolean, so a
    // failed or truncated read is forced to render as an affirmative "New
    // client". It must never run off Today.
    //
    // PERF-01B moved the START of this read off the roster's critical path, so
    // the gate now sits on the CALL rather than on an inline `await`. That is
    // the same rule and a stricter reading of it: what matters was never where
    // the result is awaited, it is whether the query RUNS. Pinned two ways —
    // the gate itself, and the fact that there is exactly ONE call site for it
    // to gate, so no second ungated caller can appear elsewhere in the file.
    expect(CODE).toMatch(/viewingToday\s*\?\s*getBeforeTodayPreviews\(/);
    expect(CODE.match(/getBeforeTodayPreviews\(/g) ?? []).toHaveLength(1);
  });

  it("the workflow INPUTS are empty off today, so no row can carry a history claim", () => {
    // `hasHistory` is a required field. The only way to build an item off
    // Today would be to invent one, so no item is built: every non-Today row
    // gets `workflow === null` and the preparation block — already guarded on
    // it — goes quiet on its own.
    expect(CODE).toMatch(
      /const todayWorkflowInputs: TodayWorkflowInput\[\] = \(\s*viewingToday \? visibleAppointments : \[\]\s*\)\.map/,
    );
  });

  it("the plan note renders off Today, and ONLY off Today", () => {
    // On Today the row already prints this same field as its "Remember" line
    // from the Before-Today model; printing it twice under two labels is a bug
    // this row has had once already.
    expect(CODE).toMatch(/\{!workflow && prepSummary\.remember && \(/);
  });
});

describe("#598 survives on every day", () => {
  it("card status and the consultation action are outside the history block", () => {
    // They describe the client NOW, so they are true on any day. If either
    // moved inside the `{workflow && …}` block it would vanish on tomorrow.
    // Bounded by the row-body link's own closing tag, whatever that element is
    // called: UI-01C swapped it to PendingContainerLink, and a hard-coded
    // `</Link>` then ran past it to the next ordinary link on the page and
    // swept the whole actions column into "the history block".
    const fromWorkflow = CODE.slice(CODE.indexOf("{workflow && ("));
    // FIDELITY C: the history block now lives in the row's <details>; it ends where the off-Today prep note begins.
    const rowBodyEnd = fromWorkflow.indexOf("{!workflow && prepSummary.remember");
    expect(
      rowBodyEnd,
      "the row-body link must close after the history block",
    ).toBeGreaterThan(-1);
    const historyBlock = fromWorkflow.slice(0, rowBodyEnd);
    expect(historyBlock).not.toMatch(/CardOnFilePill|resolveCardOnFileStatus/);
    expect(historyBlock).not.toMatch(/tab=treatment/);
    expect(CODE).toMatch(/<CardOnFilePill status=\{cardOnFile\}/);
    expect(CODE).toMatch(/\?tab=treatment/);
  });

  it("the card load is still ONE bounded, studio-scoped batch for the day's clients", () => {
    expect(CODE).toMatch(/loadCardOnFileForStudio\(studio\.id, selectedDayClientIds\)/);
    expect((CODE.match(/loadCardOnFileForStudio\(/g) ?? []).length).toBe(1);
  });
});
