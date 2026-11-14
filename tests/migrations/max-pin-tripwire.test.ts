import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrationState } from "./helpers/migration-state";

// CLAUDE.md §2: only the CURRENT maximum migration's own test may assert isRepoMax. This test enforces exactly that:
// at most one test asserts `isRepoMax(...)` is TRUE, and if one does it must be the derived current max.
// An older test that still pins itself, or two tests pinning at once, is what made every migration PR edit every other.
// It also bans the other spellings §2 names: a hard-coded `toBe(0166)` and a prefix regex that "trips on the next one".
// It reads every test under tests/migrations, tests/docs and tests/scripts except this file.

export type Pin = { file: string; version: string };
export type HandTrip = { file: string; text: string };

const TRUE_FORMS = String.raw`(?:toBe\(\s*true\s*\)|toEqual\(\s*true\s*\)|toStrictEqual\(\s*true\s*\)|toBeTruthy\(\s*\)|not\s*\.\s*(?:toBe\(\s*false\s*\)|toEqual\(\s*false\s*\)|toBeFalsy\(\s*\)))`;

/**
 * Every assertion that isRepoMax(...) is true, in any spelling: a literal or a constant argument, toBe(true), toEqual(true),
 * toStrictEqual(true), toBeTruthy(), not.toBe(false), not.toBeFalsy(). Pure.
 * The pinned version is the literal argument, else the NNNN prefix of the file name, else "?" (never equal to the max).
 */
export function findMaxPins(files: Array<{ name: string; text: string }>): Pin[] {
  const out: Pin[] = [];
  const re = new RegExp(String.raw`isRepoMax\(\s*([^()]*?)\s*\)\s*\)\s*\.\s*${TRUE_FORMS}`, "g");
  for (const f of files) {
    for (const m of f.text.matchAll(re)) {
      const lit = m[1].match(/^["'](\d{4})["']$/)?.[1];
      const prefix = f.name.match(/(?:^|\/)(\d{4})-/)?.[1];
      out.push({ file: f.name, version: lit ?? prefix ?? "?" });
    }
  }
  return out;
}

/** Hard-coded "the max is N" spellings: `.toBe(0166)` and a `/^NN(…)_/` prefix regex. Pure. */
export function findHandTrips(files: Array<{ name: string; text: string }>): HandTrip[] {
  const out: HandTrip[] = [];
  const res = [/\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*0\d{3}\s*\)/g, /\/\^\d{2}\([^/\n]*\)_\//g];
  for (const f of files) for (const re of res) for (const m of f.text.matchAll(re)) out.push({ file: f.name, text: m[0] });
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
  it("NEGATIVE CONTROL: every spelling of 'isRepoMax is true' is found", () => {
    const spellings = [
      'expect(isRepoMax("0301")).toBe(true);',
      'expect(isRepoMax("0301")).toEqual(true);',
      'expect(isRepoMax("0301")).toStrictEqual(true);',
      'expect(isRepoMax("0301")).toBeTruthy();',
      'expect(isRepoMax("0301")).not.toBe(false);',
      'expect(isRepoMax("0301")).not.toBeFalsy();',
      'expect(\n  isRepoMax( "0301" )\n).toBe( true );',
    ];
    for (const text of spellings) expect(findMaxPins([{ name: "x", text }]), text).toEqual([{ file: "x", version: "0301" }]);
  });
  it("NEGATIVE CONTROL: a constant argument is a pin too, attributed to the file's own number, never to the max", () => {
    const pins = findMaxPins([{ name: "0301-thing.test.ts", text: "expect(isRepoMax(VERSION)).toBe(true);" }, { name: "docs-thing.test.ts", text: "expect(isRepoMax(v)).toBe(true);" }]);
    expect(pins).toEqual([{ file: "0301-thing.test.ts", version: "0301" }, { file: "docs-thing.test.ts", version: "?" }]);
    expect(pinViolations([pins[1]], "0340").join(" ")).toMatch(/pins \? /);
  });
  it("the false form with a constant argument is not a pin", () => {
    expect(findMaxPins([{ name: "0301-a.test.ts", text: "expect(isRepoMax(VERSION)).toBe(false);" }])).toEqual([]);
  });
  it("NEGATIVE CONTROL: the other spellings CLAUDE.md names are found: toBe(0166) and a trip-on-the-next-one regex", () => {
    expect(findHandTrips([{ name: "a", text: "expect(state.repo_migration_max).toBe(0166);" }])).toEqual([{ file: "a", text: ".toBe(0166)" }]);
    expect(findHandTrips([{ name: "b", text: "expect(f).toMatch(/^02(3[1-9]|[4-9]\\d)_/);" }]).length).toBe(1);
    expect(findHandTrips([{ name: "c", text: 'expect(count).toBe(10); expect(x).toBe("0166");' }])).toEqual([]);
  });
});

describe("max-pin tripwire (this tree)", () => {
  const dirs = ["tests/migrations", "tests/docs", "tests/scripts"];
  const sources = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => /\.test\.ts$/.test(f) && !(d === "tests/migrations" && f === "max-pin-tripwire.test.ts"))
      .map((f) => ({ name: f, text: readFileSync(`${d}/${f}`, "utf8") })),
  );
  it("at most one test pins the repo max, and it pins the derived current max", () => {
    expect(pinViolations(findMaxPins(sources), migrationState().repo_migration_max)).toEqual([]);
  });
  it("no test hard-codes the repo max as a number or a prefix regex", () => {
    expect(findHandTrips(sources)).toEqual([]);
  });
});
