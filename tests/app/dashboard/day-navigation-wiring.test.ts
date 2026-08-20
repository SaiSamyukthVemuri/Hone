import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The day-navigation ARITHMETIC is proved in tests/lib/dashboard. This file
// proves the PAGE is wired to it — and, more importantly, that off Today the
// page asks no history question at all.
//
// Source pins, because the Dashboard is an async server component with a dozen
// awaited loaders and the repo has no harness that renders it. Same idiom as
// operational-hierarchy.test.ts.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PAGE = read("app/(app)/dashboard/page.tsx");
const SNAPSHOT = read("app/(app)/dashboard/practice-snapshot.tsx");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CODE = strip(PAGE);
const SNAPSHOT_CODE = strip(SNAPSHOT);

describe("the selected day is resolved once, defensively, from the URL", () => {
  it("the raw param never reaches a date helper unvalidated", () => {
    expect(CODE).toMatch(
      /const selectedDayLocal = resolveSelectedDay\(sp\.day, todayLocal\)/,
    );
    // No second reader of the raw param. A second, unvalidated read is how a
    // `2026-02-31` reaches the date helpers.
    expect((CODE.match(/sp\.day/g) ?? []).length).toBe(1);
  });

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

  it("the 'am I on today' test compares against that ONE value", () => {
    // Not a fresh clock read: a render straddling local midnight would then
    // have the roster window and the history gate disagree.
    expect(CODE).toMatch(
      /const viewingToday = isViewingTodayFn\(selectedDayLocal, todayLocal\)/,
    );
    expect((CODE.match(/todayInTz\(/g) ?? []).length).toBe(1);
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
  it("the two HISTORICAL loaders are SKIPPED, not merely hidden", () => {
    // Skipped rather than loaded-and-suppressed, so there is no answer sitting
    // in scope for a future edit to render by accident. It is also cheaper.
    expect(CODE).toMatch(
      /const beforeTodayPreviews = viewingToday\s*\?\s*await getBeforeTodayPreviews\(/,
    );
    expect(CODE).toMatch(
      /const prepLoads = !viewingToday\s*\?\s*new Map<string, AppointmentPrepLoad>\(\)/,
    );
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

  it("every history-implying render site is behind that same null", () => {
    // If any of these stopped being guarded, a non-Today row would state
    // something about history that was never asked.
    expect(CODE).toMatch(/\{workflow && \(/);
    expect(CODE).toMatch(/\{workflow\?\.hasHistory && \(/);
    const block = CODE.slice(CODE.indexOf("{workflow && ("));
    for (const claim of [
      "New client · No charted history yet",
      "Remember: {workflow.remember}",
      "Latest setup:",
      "workflow.missingRecords.length > 0",
    ]) {
      expect(block, claim).toContain(claim);
    }
  });

  it("the page states NOTHING about history in the unasked direction either", () => {
    // Not "New client", and equally not "History unavailable": V1 did not ask,
    // and an unavailability notice would answer a question nobody posed.
    // Comment-stripped: the page documents this very rule in prose, so a raw
    // grep would be satisfied by the explanation rather than the code.
    expect(CODE).not.toMatch(/History unavailable/);
    expect(CODE).not.toMatch(/Returning client/);
  });

  it("the primary action is never handed a fabricated absence", () => {
    // The trap this replaces: a bare `hasHistory: workflow?.hasHistory ?? false`
    // handed straight to the resolver manufactures a "no history" answer off
    // Today and sends a ten-year client to the brand-new-client affordance.
    //
    // The page no longer calls the resolver at all — the wrapper is the
    // authority, and `hasHistory` survives ONLY inside the `asked: true` arm,
    // where an answer genuinely exists.
    expect(CODE).not.toMatch(/resolveNextAction\(\{/);
    expect(CODE).toMatch(/resolveDayNextAction\(\{/);
    // The only `hasHistory` fed to an action lives inside the `asked: true`
    // arm. The other two reads are the workflow INPUT (built only for today —
    // pinned above) and the render guard (behind `workflow &&`, null off
    // today), so neither can be reached on another day.
    const actionCall = CODE.slice(
      CODE.indexOf("resolveDayNextAction({"),
      CODE.indexOf("});", CODE.indexOf("resolveDayNextAction({")),
    );
    // Every mention of history in the call sits on the `asked: true` side.
    expect(actionCall).toMatch(/asked: true, hasHistory:/);
    expect(actionCall).toMatch(/: \{ asked: false \}/);
    expect(actionCall.replace(/\{ asked: true, hasHistory: workflow\?\.hasHistory \?\? false \}/, "")).not.toMatch(
      /hasHistory/,
    );
    expect(CODE).toMatch(
      /history: historyAsked\s*\?\s*\{ asked: true, hasHistory: workflow\?\.hasHistory \?\? false \}\s*:\s*\{ asked: false \}/,
    );
    expect(CODE).toMatch(/historyAsked=\{viewingToday\}/);
  });

  it("resolveNextAction itself is UNTOUCHED, so today's action cannot drift", () => {
    const nextAction = read("lib/dashboard/next-action.ts");
    expect(nextAction).toMatch(/hasHistory: boolean;/);
    expect(nextAction).toMatch(/if \(input\.hasHistory\) \{/);
  });
});

describe("time-relative surfaces stay anchored to the REAL present", () => {
  it("the Current pill cannot appear on a day that is not today", () => {
    // Gated by CONSTRUCTION — the empty set is built when the briefing is not
    // on today, so no downstream reader can reintroduce the highlight.
    expect(CODE).toMatch(
      /const currentAppointmentIdSet = !viewingToday\s*\?\s*new Set<string>\(\)\s*:\s*currentAppointmentIds\(/,
    );
  });
});

describe("the two day controls do not fight each other", () => {
  it("day links carry the period", () => {
    for (const id of ["dashboard-prev-day", "dashboard-today", "dashboard-next-day"]) {
      expect(PAGE, id).toMatch(new RegExp(`data-testid="${id}"`));
    }
    const uses = [...CODE.matchAll(/dashboardDayHref\(\{[\s\S]*?\}\)/g)];
    expect(uses).toHaveLength(3);
    for (const u of uses) expect(u[0]).toMatch(/\bperiod,?\s*\}/);
    expect(CODE).not.toMatch(/href="\/dashboard\?day=/);
  });

  it("period links carry the DAY — they are not hardcoded back to /dashboard", () => {
    expect(SNAPSHOT_CODE).not.toMatch(/`\/dashboard\?period=\$\{/);
    expect(SNAPSHOT_CODE).toMatch(
      /href=\{dashboardDayHref\(\{ day: selectedDay, todayLocal, period: p\.key \}\)\}/,
    );
    expect(CODE).toMatch(
      /<PracticeSnapshot[\s\S]{0,300}?selectedDay=\{selectedDayLocal\}[\s\S]{0,120}?todayLocal=\{todayLocal\}/,
    );
  });

  it("the outward control is disabled at the horizon, never a rejected link", () => {
    expect(CODE).toMatch(/\{canGoBack \? \(/);
    expect(CODE).toMatch(/\{canGoForward \? \(/);
    expect((CODE.match(/data-disabled="true"/g) ?? []).length).toBe(2);
  });
});

describe("#598 survives on every day", () => {
  it("card status and the consultation action are outside the history block", () => {
    // They describe the client NOW, so they are true on any day. If either
    // moved inside the `{workflow && …}` block it would vanish on tomorrow.
    const historyBlock = CODE.slice(
      CODE.indexOf("{workflow && ("),
      CODE.indexOf("</Link>", CODE.indexOf("{workflow && (")),
    );
    expect(historyBlock).not.toMatch(/CardOnFilePill|resolveCardOnFileStatus/);
    expect(historyBlock).not.toMatch(/tab=consultation/);
    expect(CODE).toMatch(/<CardOnFilePill status=\{cardOnFile\}/);
    expect(CODE).toMatch(/tab=consultation/);
  });

  it("the card load is still ONE bounded, studio-scoped batch for the day's clients", () => {
    expect(CODE).toMatch(/loadCardOnFileForStudio\(studio\.id, selectedDayClientIds\)/);
    expect((CODE.match(/loadCardOnFileForStudio\(/g) ?? []).length).toBe(1);
  });
});
