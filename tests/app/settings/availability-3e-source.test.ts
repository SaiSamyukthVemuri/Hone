import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B 3E defect #3 + #4 source contracts (no DB / DOM needed).

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ACTIONS = read("app/(app)/settings/availability/actions.ts");
const RECURRING = read("app/(app)/settings/availability/RecurringBreaksSection.tsx");

describe("defect #4 — owner-facing action results never interpolate raw DB text", () => {
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
    // The marker encodes only the three safe tokens — no message, no row data.
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

describe("defect #3 — RecurringBreaksSection honours the studio 12h/24h preference", () => {
  it("uses the shared formatClockLabel + a timeFormat prop, not a hardcoded 12h formatter", () => {
    expect(RECURRING).toMatch(/import \{ formatClockLabel, type TimeFormat \}/);
    expect(RECURRING).toMatch(/timeFormat: TimeFormat;/);
    expect(RECURRING).toMatch(/formatClockLabel\(trimSeconds\(r\.start_local_time\), timeFormat\)/);
    expect(RECURRING).not.toMatch(/function formatTime12h/);
  });
});
