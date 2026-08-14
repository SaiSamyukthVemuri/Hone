import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B 3E defect #3 + #4 source contracts (no DB / DOM needed).

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ACTIONS = read("app/(app)/settings/availability/actions.ts");
const RECURRING = read("app/(app)/settings/availability/RecurringBreaksSection.tsx");
const TIMED = read("app/(app)/settings/availability/TimedBlocksSection.tsx");
const DRAWER = read("app/(app)/calendar/TimedBlockEditDrawer.tsx");

describe("defect #4: owner-facing action results never interpolate raw DB text", () => {
  it("has NO `${...message}` interpolation anywhere in the actions file", () => {
    // Catches `${error.message}`, `${loadErr.message}`, `${lookupErr.message}`, …
    const matches = ACTIONS.match(/\$\{[^}]*\.message\s*\}/g) ?? [];
    expect(matches).toEqual([]);
  });

  it("has NO bare `error: <ident>.message` return", () => {
    const matches = ACTIONS.match(/error:\s*\w+\.message/g) ?? [];
    expect(matches).toEqual([]);
  });

  it("routes unexpected DB errors through the bounded operational logger (action:stage:code only)", () => {
    expect(ACTIONS).toMatch(/function logAvailabilityDbError/);
    // The marker encodes only the three safe tokens, no message, no row data.
    expect(ACTIONS).toMatch(
      /availability_action_db_error:\$\{action\}:\$\{stage\}:\$\{code \?\? "unknown"\}/,
    );
    // It must be called from the error branches.
    expect((ACTIONS.match(/logAvailabilityDbError\(/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });

  it("does not log any client / note / appointment / practitioner / token payload", () => {
    // The only console call is the bounded marker; no console.* carries data.
    const consoleCalls = ACTIONS.match(/console\.\w+\([^)]*\)/g) ?? [];
    for (const c of consoleCalls) {
      expect(c).toMatch(/availability_action_db_error/);
    }
  });

  it("removed the old studio_id-only lookupConflictMessage in favour of the resource-aware RPC", () => {
    expect(ACTIONS).not.toMatch(/function lookupConflictMessage/);
    expect(ACTIONS).toMatch(/find_scoped_calendar_conflict/);
    expect(ACTIONS).toMatch(/find_recurring_break_conflict/);
  });
});

describe("defect #3: RecurringBreaksSection honours the studio 12h/24h preference", () => {
  it("uses the shared formatClockLabel + a timeFormat prop, not a hardcoded 12h formatter", () => {
    expect(RECURRING).toMatch(/import \{[\s\S]*formatClockLabel[\s\S]*type TimeFormat[\s\S]*\}/);
    expect(RECURRING).toMatch(/timeFormat: TimeFormat;/);
    expect(RECURRING).toMatch(/formatClockLabel\(trimSeconds\(r\.start_local_time\), timeFormat\)/);
    expect(RECURRING).not.toMatch(/function formatTime12h/);
  });
});

describe("item #5: conflict messages honour the studio TimeFormat (no hardcoded hour12)", () => {
  it("formatTimeInTz delegates to the shared formatTimeForStudio with a TimeFormat", () => {
    expect(ACTIONS).toMatch(/function formatTimeInTz\(iso: string, tz: string, format: TimeFormat\)/);
    expect(ACTIONS).toMatch(/return formatTimeForStudio\(new Date\(iso\), tz, format\)/);
    // The only remaining "hour12" is in a comment, never in executable code.
    const code = ACTIONS.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/hour12/);
    // Every conflict-describe call passes the resolved studio format.
    expect((ACTIONS.match(/format: resolveTimeFormat\(studio\),/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

describe("item #4: all-day timed blocks are fully editable (not delete+recreate)", () => {
  it("updateTimedBlockAction has an all-day branch (buildAllDayBlockUtcRange used on create AND update)", () => {
    expect(ACTIONS).toMatch(/const allDay = trimmed\(formData\.get\("all_day"\)\)/);
    // buildAllDayBlockUtcRange is referenced by BOTH create and update actions.
    expect((ACTIONS.match(/buildAllDayBlockUtcRange\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("both edit surfaces detect all-day by local-midnight boundaries (isAllDayInterval), never 24h duration", () => {
    for (const src of [TIMED, DRAWER]) {
      expect(src).toMatch(/isAllDayInterval\(/);
    }
    // The stale "converting between modes is delete + recreate" note is gone.
    expect(TIMED).not.toMatch(/delete \+ recreate/);
  });
});

describe("item #3: the submit button is disabled while pending (prevents duplicate creation)", () => {
  it("both section submit buttons bind disabled={pending} and drive a single in-flight transition", () => {
    for (const src of [TIMED, RECURRING]) {
      expect(src).toMatch(/disabled=\{pending\}/);
      expect(src).toMatch(/startTransition\(/);
      // The label flips to a busy state so the owner sees the in-flight save.
      expect(src).toMatch(/Saving…/);
    }
  });
});
