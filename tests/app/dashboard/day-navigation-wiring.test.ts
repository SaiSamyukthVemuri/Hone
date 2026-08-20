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
  it("the BEFORE-TODAY loader is still skipped off Today", () => {
    // This is the retired model: its only output channel is a boolean, so a
    // failed or truncated read is forced to render as an affirmative "New
    // client". It must never run off Today.
    expect(CODE).toMatch(
      /const beforeTodayPreviews = viewingToday\s*\?\s*await getBeforeTodayPreviews\(/,
    );
  });

  it("the APPOINTMENT-PREP loader now runs for the selected day", () => {
    // The opposite call from the Before-Today model, and for a structural
    // reason: this loader has no clock, is bounded by each appointment's own
    // `starts_at`, and reports a failed or truncated read as `unavailable`
    // rather than as an absence. That is what makes it safe on any day — and
    // it is what gives a practitioner something to prepare with.
    expect(CODE).not.toMatch(/const prepLoads = !viewingToday/);
    expect(CODE).toMatch(
      /const prepLoads = await loadLastChartedTreatmentsForClients\(\{/,
    );
    // Still one request PER APPOINTMENT, carrying its own boundary.
    expect(CODE).toMatch(/requestKey: a\.id/);
    expect(CODE).toMatch(/before: a\.starts_at/);
    expect(CODE).toMatch(/excludeAppointmentId: a\.id/);
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

  it("every RELATIONSHIP claim is still behind the workflow null", () => {
    // The rule that survives: nothing may say new-vs-returning off Today.
    // These all live inside `{workflow && (`, which is null off Today.
    expect(CODE).toMatch(/\{workflow && \(/);
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

  it("the treatment memory is NOT behind it — it has its own authority", () => {
    // Clinical preparation evidence and relationship status are different
    // facts from different loaders. Tying the first to the second is what
    // emptied the future-day roster.
    expect(CODE).not.toMatch(/\{workflow\?\.hasHistory && \(/);
    expect(CODE).toMatch(
      /\{\(prepSummary\.hasTreatment \|\| prepSummary\.unavailable\) && \(/,
    );
  });

  it("the plan note is CARRIED from the loader, not dropped", () => {
    // `narrative.plan` is already loaded and was being thrown away here. It is
    // the newest recorded "for next visit" note, it survives both "nothing
    // charted" and a failed block read, and on a future day it is the single
    // most useful thing the practitioner can read.
    expect(CODE).toMatch(
      /planNote: load\.narrative\.plan\?\.text\?\.trim\(\) \|\| null/,
    );
    // …and the no-load fallback must not invent one.
    expect(CODE).toMatch(/memory: null,\s*unavailable: false,\s*planNote: null,/);
  });

  it("the plan note renders off Today, and ONLY off Today", () => {
    // On Today the row already prints this same field as its "Remember" line
    // from the Before-Today model; printing it twice under two labels is a bug
    // this row has had once already.
    expect(CODE).toMatch(/\{!workflow && prepSummary\.remember && \(/);
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

describe("both Dashboard exits to the Calendar carry the selected day", () => {
  it("no bare /calendar link survives", () => {
    // Two of them: the section header's "Book appointment" and the empty
    // state's "View calendar".
    expect(CODE).not.toMatch(/href="\/calendar"/);
    expect((CODE.match(/calendarHrefForDashboardDay\(/g) ?? []).length).toBe(2);
  });

  it("both build the href from the RESOLVED day, never the raw param", () => {
    expect(CODE).toMatch(
      /calendarHrefForDashboardDay\(\{\s*selectedDay: selectedDayLocal,\s*todayLocal,\s*\}\)/,
    );
    // The empty state receives the same two values as props.
    expect(CODE).toMatch(
      /calendarHrefForDashboardDay\(\{ selectedDay, todayLocal \}\)/,
    );
    expect(CODE).not.toMatch(/calendarHrefForDashboardDay\([^)]*sp\.day/);
  });

  it("ONE authority builds the URL — no hand-rolled second copy", () => {
    expect(CODE).not.toMatch(/`\/calendar\?day=\$\{/);
  });
});

describe("the heading prints each fact exactly once", () => {
  it("the sub-line is CONDITIONAL, not unconditional", () => {
    // The shipped defect: `dayHeading` falls through to the same function the
    // sub-line prints, so from two days out the page rendered
    // "Sunday, August 23" stacked over "Sunday, August 23".
    expect(CODE).toMatch(/\{daySubLabel\(selectedDayLocal, todayLocal\) && \(/);
    // The old unconditional call is gone.
    expect(CODE).not.toMatch(
      /<p className="text-sm text-neutral-600 dark:text-neutral-400">\s*\{formatSelectedDayLabel\(selectedDayLocal\)\}/,
    );
  });

  it("the page no longer imports the raw label formatter for the sub-line", () => {
    // One authority for "what goes under the heading": `daySubLabel`, which
    // returns null rather than repeating the heading.
    expect(CODE).toMatch(/daySubLabel/);
  });
});

describe("the day control is one group, stable across days", () => {
  it("all three segments render on EVERY day", () => {
    // The middle segment used to be omitted on today, which changed the
    // group's width and moved "Next →" out from under a repeating thumb.
    expect(CODE).not.toMatch(/\{!viewingToday && \(\s*<Link/);
    expect(CODE).toMatch(/\{viewingToday \? \(/);
    // Present-but-inert on today, and it says so to assistive tech.
    expect(CODE).toMatch(/aria-current="page"[\s\S]{0,120}data-testid="dashboard-today"/);
  });

  it("the segments share ONE bordered boundary", () => {
    expect(CODE).toMatch(/<nav aria-label="Change day" className=\{DAY_NAV_GROUP\}>/);
  });
});
