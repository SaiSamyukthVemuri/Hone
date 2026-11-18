import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B 3E defect #4 source contract: no raw DB text in results or logs.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ACTIONS = read("app/(app)/settings/availability/actions.ts");

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

  it("does not log any client / note / appointment / practitioner / token payload", () => {
    // The only console call is the bounded marker; no console.* carries data.
    const consoleCalls = ACTIONS.match(/console\.\w+\([^)]*\)/g) ?? [];
    for (const c of consoleCalls) {
      expect(c).toMatch(/availability_action_db_error/);
    }
  });
});
