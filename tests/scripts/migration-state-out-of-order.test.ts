import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs utility without type declarations
import { evaluateOutOfOrder, getMigrationState, pendingMigrationVersions, PERMANENTLY_SKIPPED } from "../../scripts/migration-state.mjs";

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

// PEER-1264 C3: drive getMigrationState itself (scan + record + wiring), not only
// the pure helper, using the REAL declaration from the canonical record.
describe("getMigrationState wiring: a 0247 file with the real declaration", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mstate-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const real = JSON.parse(readFileSync("docs/production/migration-state.json", "utf8"));

  const fixture = (name: string, files: string[], record: Record<string, unknown>) => {
    const dir = join(tmp, name, "migrations");
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), "-- fixture\n");
    const canonicalFile = join(tmp, name, "state.json");
    writeFileSync(canonicalFile, JSON.stringify(record));
    return getMigrationState({ dir, canonicalFile });
  };
  const record = {
    hosted_migration_max: "0248",
    hosted_applied_at: null,
    hosted_note: "fixture",
    hosted_out_of_order: real.hosted_out_of_order,
  };

  it("the real declaration is 0248 hosted with 0247 unhosted (premise of the fixture)", () => {
    expect(real.hosted_out_of_order).toEqual([{ version: "0248", unhosted_below: ["0247"] }]);
  });
  it("with the 0247 file present, pending is [0247] and the declaration stays valid", () => {
    const st = fixture("with-0247", ["0246_a.sql", "0247_b.sql", "0248_c.sql"], record);
    expect(st.pending_migrations).toEqual(["0247"]);
    expect(st.undeclared_gaps).toEqual([]);
    expect(st.invalid_out_of_order_declarations).toEqual([]);
    expect(st.repo_migration_max).toBe("0248");
  });
  it("without the 0247 file, pending is empty (today's state)", () => {
    const st = fixture("without-0247", ["0246_a.sql", "0248_c.sql"], record);
    expect(st.pending_migrations).toEqual([]);
  });
  it("NEGATIVE CONTROL: the same files with no declaration lose 0247 (pre-fix) and report the gap-free repo as parity", () => {
    const st = fixture("undeclared", ["0246_a.sql", "0247_b.sql", "0248_c.sql"], { ...record, hosted_out_of_order: [] });
    expect(st.pending_migrations).toEqual([]);
  });
});
