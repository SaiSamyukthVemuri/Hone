import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrationState } from "./helpers/migration-state";

// CLAUDE.md §2: only the CURRENT maximum migration's own test may assert isRepoMax. This test enforces exactly that:
// at most one per-migration test asserts `isRepoMax("NNNN")).toBe(true)`, and if one does it must be the derived current max.
// An older test that still pins itself, or two tests pinning at once, is what made every migration PR edit every other.

export type Pin = { file: string; version: string };

/** Every `isRepoMax("NNNN")).toBe(true)` (or toBeTruthy) in the given sources. Pure. */
export function findMaxPins(files: Array<{ name: string; text: string }>): Pin[] {
  const out: Pin[] = [];
  const re = /isRepoMax\(\s*["'](\d{4})["']\s*\)\s*\)\s*\.\s*(?:toBe\(\s*true\s*\)|toBeTruthy\(\s*\))/g;
  for (const f of files) for (const m of f.text.matchAll(re)) out.push({ file: f.name, version: m[1] });
  return out;
}

/** The violations of the rule for a set of pins and the derived max. Pure. */
export function pinViolations(pins: Pin[], max: string): string[] {
  const v: string[] = [];
  const files = [...new Set(pins.map((p) => p.file))];
  if (files.length > 1) v.push(`more than one test pins the repo max: ${files.join(", ")}`);
  for (const p of pins) if (p.version !== max) v.push(`${p.file} pins ${p.version} but the derived repo max is ${max}`);
  return v;
}

describe("max-pin tripwire (pure)", () => {
  const pinSrc = (v: string) => `expect(isRepoMax("${v}")).toBe(true);`;
  it("finds a pin and ignores the false form", () => {
    expect(findMaxPins([{ name: "a", text: pinSrc("0340") }, { name: "b", text: 'expect(isRepoMax("0100")).toBe(false);' }])).toEqual([{ file: "a", version: "0340" }]);
  });
  it("one pin on the current max is allowed; none is allowed", () => {
    expect(pinViolations([{ file: "a", version: "0340" }], "0340")).toEqual([]);
    expect(pinViolations([], "0340")).toEqual([]);
  });
  it("NEGATIVE CONTROL: a stale pin (an older test that pins itself after a newer migration landed) is a violation", () => {
    expect(pinViolations([{ file: "a", version: "0332" }], "0340").join(" ")).toMatch(/pins 0332 .* 0340/);
  });
  it("NEGATIVE CONTROL: two tests pinning at once is a violation even when one is current", () => {
    expect(pinViolations([{ file: "a", version: "0340" }, { file: "b", version: "0339" }], "0340").join(" ")).toMatch(/more than one/);
  });
});

describe("max-pin tripwire (this tree)", () => {
  const sources = readdirSync("tests/migrations")
    .filter((f) => /^\d{4}-.*\.test\.ts$/.test(f))
    .map((f) => ({ name: f, text: readFileSync(`tests/migrations/${f}`, "utf8") }));
  it("at most one per-migration test pins the repo max, and it pins the derived current max", () => {
    expect(pinViolations(findMaxPins(sources), migrationState().repo_migration_max)).toEqual([]);
  });
});
