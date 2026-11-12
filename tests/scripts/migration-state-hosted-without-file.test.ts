import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs utility without type declarations
import { evaluateOutOfOrder, getMigrationState, PERMANENTLY_SKIPPED } from "../../scripts/migration-state.mjs";

// `hosted_without_repo_file`: migrations production HAS applied whose file is not in this tree yet (the carrier PR has not merged).
// They are neither a gap nor "unhosted_below" (that field means "deliberately NOT hosted"), and they are not hosted_out_of_order
// entries either (that rule requires a repo file). Each is declared with the apply record it comes from.
// Every case drives the pure evaluator so the controls do not depend on the live repository state.

const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i).filter((n) => !PERMANENTLY_SKIPPED.includes(n));
const REC = "01-ops/RECORD-0301-APPLIED-20261106.md";
const recFor = (v: string) => `01-ops/RECORD-${v}-APPLIED-20261106.md`;
const run = (numbers: number[], hostedMaxNumber: number, hostedWithoutFile: unknown, declared: unknown[] = []) =>
  evaluateOutOfOrder({ numbers, hostedMaxNumber, declared, hostedWithoutFile });
// Files 1..299 and 303, hosted max 303: 0300..0302 have no file.
const NUMBERS = range(1, 299).concat(303);

describe("hosted_without_repo_file", () => {
  it("accepts a hosted number with no repo file when it is declared with its apply record", () => {
    const r = run(range(1, 300).concat(302), 302, [{ version: "0301", apply_record: REC }]);
    expect(r).toEqual({ undeclared_gaps: [], invalid_declarations: [] });
  });

  it("NEGATIVE CONTROL: the same hole with no declaration is an undeclared gap", () => {
    const r = run(range(1, 300).concat(302), 302, []);
    expect(r.undeclared_gaps).toEqual(["0301"]);
  });

  it("an omitted field behaves as an empty list", () => {
    const r = evaluateOutOfOrder({ numbers: range(1, 300).concat(302), hostedMaxNumber: 302, declared: [] });
    expect(r.undeclared_gaps).toEqual(["0301"]);
  });

  it("covers only the numbers it names", () => {
    const r = run(NUMBERS, 303, [{ version: "0301", apply_record: REC }]);
    expect(r.undeclared_gaps).toEqual(["0300", "0302"]);
  });

  it("accepts several entries", () => {
    const r = run(NUMBERS, 303, [
      { version: "0300", apply_record: recFor("0300") },
      { version: "0301", apply_record: REC },
      { version: "0302", apply_record: recFor("0302") },
    ]);
    expect(r).toEqual({ undeclared_gaps: [], invalid_declarations: [] });
  });

  it("NEGATIVE: a number that HAS a repo file is refused (it is not 'without a file')", () => {
    const r = run(range(1, 302), 302, [{ version: "0301", apply_record: REC }]);
    expect(r.invalid_declarations.join(" ")).toMatch(/0301 is declared hosted_without_repo_file but has a repo file/);
  });

  it("NEGATIVE: a number listed here AND in some unhosted_below is refused (both hosted and unhosted)", () => {
    const r = run(range(1, 300).concat(302, 303), 303, [{ version: "0301", apply_record: REC }], [
      { version: "0303", unhosted_below: ["0301"] },
    ]);
    expect(r.invalid_declarations.join(" ")).toMatch(/0301 is declared both hosted_without_repo_file and unhosted_below/);
  });

  it("NEGATIVE: a number that is also a hosted_out_of_order entry is refused", () => {
    const r = run(range(1, 300).concat(302), 302, [{ version: "0302", apply_record: REC }], [
      { version: "0302", unhosted_below: ["0301"] },
    ]);
    expect(r.invalid_declarations.join(" ")).toMatch(/0302 is declared both hosted_without_repo_file and a hosted_out_of_order entry/);
  });

  it("NEGATIVE: a number above the hosted max is refused (declared hosted but not hosted)", () => {
    const r = run(range(1, 300), 300, [{ version: "0301", apply_record: REC }]);
    expect(r.invalid_declarations.join(" ")).toMatch(/0301 is declared hosted_without_repo_file but is above hosted_migration_max/);
  });

  it("NEGATIVE: no apply record, a blank one, or a non-string one is refused", () => {
    for (const bad of [undefined, "", "   ", 7, null]) {
      const r = run(range(1, 300).concat(302), 302, [{ version: "0301", apply_record: bad }]);
      expect(r.invalid_declarations.join(" "), String(bad)).toMatch(/0301 must name the apply record it comes from/);
    }
  });

  // Insurance F1: every shape gets its own wrong-folder, wrong-version and wrong-suffix case, plus anchors.
  const refused = (v: string, rec: string) =>
    run(range(1, Number(v) - 1).concat(Number(v) + 1), Number(v) + 1, [{ version: v, apply_record: rec }]).invalid_declarations.join(" ");
  const NOT_A_PATH = /apply_record is not an operator apply-record path/;
  const SHAPE2 = (v: string) => `01-ops/${v}-APPLY-RESULT-20261108T1929Z.md`;
  const SHAPE3 = (v: string) => `01-ops/rmin-${v}-apply-20261108/NOTES.md`;

  it("accepts shape 2 and shape 3 for the matching version", () => {
    expect(refused("0313", SHAPE2("0313"))).toBe("");
    expect(refused("0303", SHAPE3("0303"))).toBe("");
  });

  it.each([
    ["shape 2 wrong folder", "0313", "docs/0313-APPLY-RESULT-20261108T1929Z.md"],
    ["shape 2 wrong version (another record's)", "0313", SHAPE2("0302")],
    ["shape 2 wrong suffix (.txt)", "0313", "01-ops/0313-APPLY-RESULT-20261108T1929Z.md.txt"],
    ["shape 2 wrong suffix (.json)", "0313", "01-ops/0313-APPLY-RESULT-20261108T1929Z.json"],
    ["shape 2 truncated time", "0313", "01-ops/0313-APPLY-RESULT-20261108T19Z.md"],
    ["shape 3 wrong folder", "0303", "docs/rmin-0303-apply-20261108/NOTES.md"],
    ["shape 3 wrong version (another record's)", "0303", SHAPE3("0302")],
    ["shape 3 wrong suffix (NOTES.md.txt)", "0303", "01-ops/rmin-0303-apply-20261108/NOTES.md.txt"],
    ["shape 3 wrong file name (README.md, NOTES.md is not a wildcard)", "0303", "01-ops/rmin-0303-apply-20261108/README.md"],
    ["shape 3 wrong file name (ANYTHING.md)", "0303", "01-ops/rmin-0303-apply-20261108/other-NOTES.md"],
    ["shape 3 deeper path", "0303", "01-ops/rmin-0303-apply-20261108/x/NOTES.md"],
    ["anchor: prefix before 01-ops (shape 1)", "0301", "x/01-ops/RECORD-0301-APPLIED-20261106.md"],
    ["anchor: prefix before 01-ops (shape 2)", "0313", "x/" + SHAPE2("0313")],
    ["anchor: prefix before 01-ops (shape 3)", "0303", "x/" + SHAPE3("0303")],
    ["anchor: trailing text (shape 1)", "0301", "01-ops/RECORD-0301-APPLIED-20261106.md/extra"],
    ["anchor: trailing text (shape 2)", "0313", SHAPE2("0313") + "/extra"],
    ["anchor: trailing text (shape 3)", "0303", SHAPE3("0303") + "/extra"],
    ["anchor: a second line carrying a valid path", "0301", "x\n01-ops/RECORD-0301-APPLIED-20261106.md"],
    ["anchor: a valid path then a second line", "0301", "01-ops/RECORD-0301-APPLIED-20261106.md\nx"],
  ])("NEGATIVE: %s is refused", (_name, v, rec) => {
    expect(refused(v, rec as string)).toMatch(NOT_A_PATH);
  });

  it("NEGATIVE: a duplicate is refused", () => {
    const r = run(range(1, 300).concat(302), 302, [
      { version: "0301", apply_record: REC },
      { version: "0301", apply_record: REC },
    ]);
    expect(r.invalid_declarations.join(" ")).toMatch(/0301 is declared twice in hosted_without_repo_file/);
  });

  const malformed = (bad: unknown) => run(range(1, 300).concat(302), 302, [{ version: bad, apply_record: REC }]).invalid_declarations.join(" ");
  it('NEGATIVE: the three-digit STRING "301" is refused (the four-digit rule is pinned, not parseInt)', () => {
    expect(malformed("301")).toMatch(/hosted_without_repo_file entry has no four-digit version/);
  });
  it("NEGATIVE: the NUMBER 301 is refused", () => {
    expect(malformed(301)).toMatch(/hosted_without_repo_file entry has no four-digit version/);
  });
  it("NEGATIVE: other malformed versions are refused", () => {
    for (const bad of ["03011", "0301x", " 0301", "abc", null, undefined]) {
      expect(malformed(bad), String(bad)).toMatch(/hosted_without_repo_file entry has no four-digit version/);
    }
  });

  it("accepts each of the three real apply-record shapes, for the matching version", () => {
    for (const rec of [
      "01-ops/RECORD-0301-APPLIED-20261106.md",
      "01-ops/0313-APPLY-RESULT-20261108T1929Z.md",
      "01-ops/rmin-0303-apply-20261108/NOTES.md",
    ]) {
      const v = rec.match(/\d{4}/)![0];
      const n = Number(v);
      const r = run(range(1, n - 1).concat(n + 1), n + 1, [{ version: v, apply_record: rec }]);
      expect(r.invalid_declarations, rec).toEqual([]);
    }
  });
  it("NEGATIVE: an apply_record of the wrong shape, the wrong folder or ANOTHER version's record is refused", () => {
    for (const bad of ["notes.md", "01-ops/a.md", "docs/RECORD-0301-APPLIED-20261106.md", "01-ops/RECORD-0302-APPLIED-20261106.md", "01-ops/RECORD-0301-APPLIED-2026.md", "01-ops/RECORD-0301-APPLIED-20261106.md.txt", "../01-ops/RECORD-0301-APPLIED-20261106.md"]) {
      const r = run(range(1, 300).concat(302), 302, [{ version: "0301", apply_record: bad }]);
      expect(r.invalid_declarations.join(" "), bad).toMatch(/0301 apply_record is not an operator apply-record path for 0301/);
    }
  });

  it("NEGATIVE: an unknown key is refused", () => {
    const r = run(range(1, 300).concat(302), 302, [{ version: "0301", apply_record: REC, note: "x" }]);
    expect(r.invalid_declarations.join(" ")).toMatch(/0301 has an unknown key: note/);
  });

  it("NEGATIVE: a non-array value is refused", () => {
    expect(run(NUMBERS, 303, { version: "0301" }).invalid_declarations).toEqual(["hosted_without_repo_file must be an array"]);
    expect(run(NUMBERS, 303, "0301").invalid_declarations).toEqual(["hosted_without_repo_file must be an array"]);
  });

  it("does not stop a real gap elsewhere from failing", () => {
    const r = run(range(1, 298).concat(300, 302), 302, [{ version: "0301", apply_record: REC }]);
    expect(r.undeclared_gaps).toEqual(["0299"]);
  });
});

describe("hosted_without_repo_file through getMigrationState", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ms-hwf-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const fixture = (name: string, files: string[], record: Record<string, unknown>) => {
    const dir = join(tmp, name, "migrations");
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), "-- fixture\n");
    const canonicalFile = join(tmp, name, "state.json");
    writeFileSync(canonicalFile, JSON.stringify(record));
    return getMigrationState({ dir, canonicalFile });
  };
  const base = { hosted_migration_max: "0003", hosted_applied_at: null, hosted_note: "fixture" };
  const files = ["0001_a.sql", "0002_b.sql", "0003_c.sql"].filter((f) => f !== "0002_b.sql");

  it("exposes the list, and a hosted number with no file is neither a gap nor pending", () => {
    const st = fixture("ok", files, { ...base, hosted_without_repo_file: [{ version: "0002", apply_record: recFor("0002") }] });
    expect(st.hosted_without_repo_file).toEqual([{ version: "0002", apply_record: recFor("0002") }]);
    expect(st.undeclared_gaps).toEqual([]);
    expect(st.invalid_out_of_order_declarations).toEqual([]);
    expect(st.pending_migrations).toEqual([]);
  });

  it("the field defaults to an empty list when the record omits it", () => {
    const st = fixture("omitted", ["0001_a.sql", "0002_b.sql", "0003_c.sql"], base);
    expect(st.hosted_without_repo_file).toEqual([]);
  });

  it("NEGATIVE CONTROL: without the declaration the same tree reports the gap", () => {
    const st = fixture("gap", files, base);
    expect(st.undeclared_gaps).toEqual(["0002"]);
  });

  it("a declared number whose file later lands is refused, so a stale entry cannot linger", () => {
    const st = fixture("landed", ["0001_a.sql", "0002_b.sql", "0003_c.sql"], {
      ...base,
      hosted_without_repo_file: [{ version: "0002", apply_record: recFor("0002") }],
    });
    expect(st.invalid_out_of_order_declarations.join(" ")).toMatch(/0002 is declared hosted_without_repo_file but has a repo file/);
  });
});
