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

describe("EVERY SELECTED DAY ASKS THE SAME HISTORY QUESTION — the load-bearing rule", () => {
  // THE RULE INVERTED, deliberately.
  //
  // V1's rule was "off Today, do not ask". That was the right call at the time:
  // the only model available off Today was a boolean, so a failed or truncated
  // read was forced to render as an affirmative "New client", and not asking was
  // safer than answering wrongly. The cost was a future day with almost no
  // preparation on it — the day a practitioner actually opens to prepare.
  //
  // V2 asks on every day, because the answer is no longer a boolean. Preparation
  // is a set of OBSERVATIONS, each rendered only when it was actually read, so a
  // capped or failed read makes the row quieter and never wrong. There is
  // nothing left to suppress off Today.

  it("the retired Before-Today pipeline is not called at all", () => {
    // It asked a strictly weaker question than the loader that replaced it: no
    // `before` bound, no `record_status` void filter, no own-appointment
    // exclusion, and `error` never bound on any of its four reads. Running it
    // only on Today hid that; running it on every day would have spread it.
    expect(CODE).not.toMatch(/getBeforeTodayPreviews/);
    expect(CODE).not.toMatch(/beforeTodayPreviews/);
    expect(CODE).not.toMatch(/buildTodayWorkflow/);
  });

  it("the APPOINTMENT-PREP loader runs for the selected day", () => {
    // This loader has no clock, is bounded by each appointment's own
    // `starts_at`, and reports a failed or truncated read as `unavailable`
    // rather than as an absence. That is what makes it safe on any day.
    expect(CODE).not.toMatch(/const prepLoads = !viewingToday/);
    expect(CODE).toMatch(
      /const prepLoads = await loadLastChartedTreatmentsForClients\(\{/,
    );
    // Still one request PER APPOINTMENT, carrying its own boundary.
    expect(CODE).toMatch(/requestKey: a\.id/);
    expect(CODE).toMatch(/before: a\.starts_at/);
    expect(CODE).toMatch(/excludeAppointmentId: a\.id/);
  });

  it("the SAME preparation block renders on every day", () => {
    // One renderer, one model. Two renderers is what let Today and a selected
    // day disagree about the same appointment.
    expect(CODE).toMatch(/<PreVisitPrepBlock prep=\{prep\} viewingToday=\{viewingToday\} \/>/);
    expect((CODE.match(/<PreVisitPrepBlock/g) ?? []).length).toBe(1);
  });

  it("`viewingToday` reaches the block as WORDING only", () => {
    // It must not gate a fact. The same evidence has to produce the same
    // preparation whether she opens the appointment today or three days early;
    // only the temporal label may differ.
    const BLOCK = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/pre-visit-prep-block.tsx"),
      "utf8",
    );
    const BLOCK_CODE = BLOCK.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    // In the RENDERED markup it appears exactly once, and that once chooses
    // between two labels. (Outside the markup it is only the prop name and its
    // type annotation.)
    const JSX = BLOCK_CODE.slice(BLOCK_CODE.indexOf("return ("));
    expect((JSX.match(/viewingToday/g) ?? []).length).toBe(1);
    expect(JSX).toMatch(/viewingToday \? PREP_LABEL_TODAY : PREP_LABEL_OTHER_DAY/);
    // It never guards a fact.
    for (const fact of ["prep.remember", "prep.caution", "prep.latestSetup", "prep.directRecordReminders"]) {
      const guard = new RegExp(`viewingToday[^\\n]*${fact.replace(".", "\\.")}`);
      expect(BLOCK_CODE).not.toMatch(guard);
    }
  });

  it("NO relationship claim is made on any day, in either direction", () => {
    for (const claim of [
      /New client/,
      /No charted history/,
      /Returning client/,
      /History unavailable/,
      /No prior charted treatment/,
    ]) {
      expect(CODE).not.toMatch(claim);
    }
  });

  it("the treatment memory keeps its own authority", () => {
    // Clinical preparation evidence and relationship status are different facts
    // from different loaders. Tying the first to the second is what emptied the
    // future-day roster.
    expect(CODE).not.toMatch(/\{workflow\?\.hasHistory && \(/);
    expect(CODE).toMatch(
      /\{\(prepSummary\.hasTreatment \|\| prepSummary\.unavailable\) && \(/,
    );
  });

  it("the plan note is CARRIED from the loader, not dropped", () => {
    // `narrative.plan` is the newest recorded "for next visit" note. It survives
    // both "nothing charted" and a failed block read, and on a future day it is
    // the single most useful thing the practitioner can read.
    expect(CODE).toMatch(
      /planNote: load\?\.narrative\.plan\?\.text\?\.trim\(\) \|\| null/,
    );
  });

  it("the plan note renders EXACTLY ONCE, on every day", () => {
    // It used to render from two different authorities depending on the day —
    // and they disagreed, because the Today one had no appointment bound and
    // could surface a note written in a session that had already happened today.
    expect(CODE).not.toMatch(/prepSummary\.remember/);
    const BLOCK = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/pre-visit-prep-block.tsx"),
      "utf8",
    );
    expect((BLOCK.match(/Remember: /g) ?? []).length).toBe(1);
  });

  it("the primary action is never handed a fabricated absence", () => {
    // The trap: a bare `hasHistory: <boolean> ?? false` handed to the resolver
    // manufactures a "no history" answer and sends a ten-year client to the
    // brand-new-client affordance.
    //
    // The page asks POSITIVELY — did we observe a prep fact? — and treats
    // "observed nothing" as NOT ASKED. The `{ asked: true, hasHistory: false }`
    // branch, the only one that asserts an absence, is unreachable from here.
    expect(CODE).not.toMatch(/resolveNextAction\(\{/);
    expect(CODE).toMatch(/resolveDayNextAction\(\{/);
    expect(CODE).toMatch(
      /history:\s*historyAsked && hasObservedPrepFact\(prep\)\s*\?\s*\{ asked: true, hasHistory: true \}\s*:\s*\{ asked: false \}/,
    );
    expect(CODE).not.toMatch(/hasHistory: false/);
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
