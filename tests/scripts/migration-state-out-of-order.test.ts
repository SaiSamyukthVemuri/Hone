import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs utility without type declarations
import { evaluateOutOfOrder, evaluateReservedAboveHosted, getMigrationState, pendingMigrationVersions, PERMANENTLY_SKIPPED } from "../../scripts/migration-state.mjs";

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
// the pure helper, using the 0248-stage declaration as a literal.
describe("getMigrationState wiring: a 0247 file with the 0248-stage declaration", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mstate-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  // A literal, so the test does not move when the live record does: the shape the
  // 0248 stage declared (0248 hosted, 0247 deliberately not).
  const declaration = [{ version: "0248", unhosted_below: ["0247"] }];

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
    hosted_out_of_order: declaration,
  };

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

describe("reserved numbers above the hosted head (reserved_unallocated_above_hosted)", () => {
  const ok = { numbers: [248, 249, 252], hostedMaxNumber: 249 };
  const run = (reserved: unknown, o: Partial<typeof ok> = {}) =>
    evaluateReservedAboveHosted({ ...ok, ...o, reserved });

  it("accepts a named reservation with no file between hosted and the repo max", () => {
    expect(run([{ version: "0250", holder: "General lane: draft, unsealed" }])).toEqual([]);
  });
  it("an absent declaration is empty, not invalid", () => {
    expect(run(undefined)).toEqual([]);
  });
  it("NEGATIVE CONTROL: not an array", () => {
    expect(run({ version: "0250" }).join(" ")).toMatch(/must be an array/);
  });
  it("NEGATIVE CONTROL: malformed version", () => {
    expect(run([{ version: "250", holder: "x" }]).join(" ")).toMatch(/no four-digit version/);
  });
  it("NEGATIVE CONTROL: no holder named", () => {
    expect(run([{ version: "0250", holder: "  " }]).join(" ")).toMatch(/names no holder/);
  });
  it("NEGATIVE CONTROL: duplicate", () => {
    expect(run([{ version: "0250", holder: "Alpha lane" }, { version: "0250", holder: "Beta lane" }]).join(" ")).toMatch(/twice/);
  });
  it("NEGATIVE CONTROL: at or below the hosted head belongs in hosted_out_of_order", () => {
    expect(run([{ version: "0249", holder: "Alpha lane" }]).join(" ")).toMatch(/at or below hosted_migration_max/);
  });
  it("NEGATIVE CONTROL: once the file exists the reservation must be removed", () => {
    expect(run([{ version: "0252", holder: "Alpha lane" }]).join(" ")).toMatch(/has a repo file/);
  });
  it("NEGATIVE CONTROL: a reservation above the repo max is stale", () => {
    expect(run([{ version: "0253", holder: "Alpha lane" }]).join(" ")).toMatch(/above the repo max/);
  });
  it("the real record wires through getMigrationState and is valid", () => {
    const s = getMigrationState();
    expect(s.invalid_reserved_declarations).toEqual([]);
    expect(Array.isArray(s.reserved_above_hosted)).toBe(true);
  });
  it("NEGATIVE CONTROL (G-1): a holder that cites no PR or lane is refused", () => {
    expect(run([{ version: "0250", holder: "someone, unsealed" }]).join(" ")).toMatch(/cites no PR/);
    expect(run([{ version: "0250", holder: "ID-photo store (#1296), held" }])).toEqual([]);
  });
  it("COMBINED CONTROL (G-3, the M6 guarantee): once hosted_migration_max passes a still-declared reservation the record fails; it passes only after the reservation is converted to an unhosted_below declaration", () => {
    const numbers = [249, 252];
    const reserved = [{ version: "0250", holder: "Alpha lane" }, { version: "0251", holder: "Beta lane" }];
    // before: hosted 249, the pending file 0252 sits above two reserved numbers
    expect(evaluateReservedAboveHosted({ reserved, numbers, hostedMaxNumber: 249 })).toEqual([]);
    // 0252 is applied: hosted passes the reservations. The record is invalid twice over.
    const passed = evaluateReservedAboveHosted({ reserved, numbers, hostedMaxNumber: 252 });
    expect(passed.join(" ")).toMatch(/0250 is at or below hosted_migration_max/);
    expect(passed.join(" ")).toMatch(/0251 is at or below hosted_migration_max/);
    expect(evaluateOutOfOrder({ numbers, hostedMaxNumber: 252, declared: [] }).undeclared_gaps).toEqual(["0250", "0251"]);
    // converted: reservations removed, the stage declared out of order
    const declared = [{ version: "0252", unhosted_below: ["0250", "0251"] }];
    expect(evaluateReservedAboveHosted({ reserved: [], numbers, hostedMaxNumber: 252 })).toEqual([]);
    const ok2 = evaluateOutOfOrder({ numbers, hostedMaxNumber: 252, declared });
    expect(ok2.undeclared_gaps).toEqual([]);
    expect(ok2.invalid_declarations).toEqual([]);
  });
  it("G-4: next_free_migration is outside reservations: it is above every reservation", () => {
    const s = getMigrationState();
    for (const v of s.reserved_above_hosted) expect(Number(v)).toBeLessThan(s.next_free_migration_number);
    expect(s.next_free_migration_number).toBe(s.repo_migration_max_number + 1);
  });
});
