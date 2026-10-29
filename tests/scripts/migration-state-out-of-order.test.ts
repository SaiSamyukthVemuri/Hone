import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs utility without type declarations
import { evaluateOutOfOrder, pendingMigrationVersions, PERMANENTLY_SKIPPED } from "../../scripts/migration-state.mjs";

// The out-of-order stage rule (0248 hosted ahead of 0247) must admit EXACTLY
// the declared shape. Every case drives the pure evaluator so the controls do
// not depend on the live repository state.

const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i).filter((n) => !PERMANENTLY_SKIPPED.includes(n));
const run = (numbers: number[], hostedMaxNumber: number, declared: unknown[] = []) =>
  evaluateOutOfOrder({ numbers, hostedMaxNumber, declared });

describe("out-of-order stage declaration", () => {
  it("accepts a declared stage: 0248 hosted, 0247 deliberately not", () => {
    const r = run(range(1, 246).concat(248), 248, [{ version: "0248", unhosted_below: ["0247"] }]);
    expect(r).toEqual({ undeclared_gaps: [], invalid_declarations: [] });
  });

  it("accepts the same declaration once the 0247 file is also in the repo", () => {
    const r = run(range(1, 248), 248, [{ version: "0248", unhosted_below: ["0247"] }]);
    expect(r).toEqual({ undeclared_gaps: [], invalid_declarations: [] });
  });

  it("NEGATIVE: an UNDECLARED gap below the hosted max fails", () => {
    const r = run(range(1, 246).concat(248), 248, []);
    expect(r.undeclared_gaps).toEqual(["0247"]);
  });

  it("NEGATIVE: a declaration covers only the versions it names", () => {
    const r = run(range(1, 245).concat(248), 248, [{ version: "0248", unhosted_below: ["0247"] }]);
    expect(r.undeclared_gaps).toEqual(["0246"]);
  });

  it("NEGATIVE: a declared entry that is not hosted (above the hosted max) fails", () => {
    const r = run(range(1, 246).concat(248), 246, [{ version: "0248", unhosted_below: ["0247"] }]);
    expect(r.invalid_declarations.join(" ")).toMatch(/0248 is declared hosted but is above hosted_migration_max/);
  });

  it("NEGATIVE: a declared entry with no repo file fails", () => {
    const r = run(range(1, 246), 248, [{ version: "0248", unhosted_below: ["0247"] }]);
    expect(r.invalid_declarations.join(" ")).toMatch(/0248 is declared hosted but has no repo file/);
  });

  it("NEGATIVE: malformed, empty, upward or contradictory declarations fail", () => {
    const nums = range(1, 250);
    expect(run(nums, 250, [{ version: "248", unhosted_below: ["0247"] }]).invalid_declarations).not.toEqual([]);
    expect(run(nums, 250, [{ version: "0248" }]).invalid_declarations).not.toEqual([]);
    expect(run(nums, 250, [{ version: "0248", unhosted_below: ["0249"] }]).invalid_declarations.join(" "))
      .toMatch(/not below it/);
    expect(
      run(nums, 250, [
        { version: "0248", unhosted_below: ["0247"] },
        { version: "0247", unhosted_below: ["0246"] },
      ]).invalid_declarations.join(" "),
    ).toMatch(/both hosted and unhosted/);
    expect(
      run(nums, 250, [
        { version: "0248", unhosted_below: ["0247"] },
        { version: "0248", unhosted_below: ["0247"] },
      ]).invalid_declarations.join(" "),
    ).toMatch(/declared twice/);
  });

  it("permanently skipped slots are still not gaps", () => {
    expect(run(range(1, 246), 246).undeclared_gaps).toEqual([]);
  });
});

// F-OOO-1: a declared-unhosted version WITH a repo file is pending, even though it
// sits below the hosted max.
describe("pending migrations include declared-unhosted versions with a repo file", () => {
  const entries = (nums: number[]) => nums.map((n) => ({ number: n, version: String(n).padStart(4, "0") }));
  const declared = [{ version: "0248", unhosted_below: ["0247"] }];

  it("0247 file present, hosted max 0248, declared unhosted: pending is 0247", () => {
    expect(pendingMigrationVersions({ entries: entries(range(1, 248)), hostedMaxNumber: 248, declared })).toEqual(["0247"]);
  });
  it("0247 file present AND something above the max: both are pending", () => {
    expect(pendingMigrationVersions({ entries: entries(range(1, 248).concat(250)), hostedMaxNumber: 248, declared })).toEqual(["0247", "0250"]);
  });
  it("NEGATIVE CONTROL: with no declaration, the below-max 0247 is invisible (the pre-fix behaviour)", () => {
    expect(pendingMigrationVersions({ entries: entries(range(1, 248)), hostedMaxNumber: 248, declared: [] })).toEqual([]);
  });
  it("a declared version with no repo file adds nothing", () => {
    expect(pendingMigrationVersions({ entries: entries(range(1, 246).concat(248)), hostedMaxNumber: 248, declared })).toEqual([]);
  });
  it("a malformed declaration adds nothing and does not throw", () => {
    expect(pendingMigrationVersions({ entries: entries(range(1, 248)), hostedMaxNumber: 248, declared: [{ version: "0248", unhosted_below: ["x", 247, null] }] })).toEqual([]);
  });
});
