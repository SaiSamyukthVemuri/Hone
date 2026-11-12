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
      { version: "0300", apply_record: "01-ops/a.md" },
      { version: "0301", apply_record: REC },
      { version: "0302", apply_record: "01-ops/b.md" },
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

  it("NEGATIVE: a duplicate is refused", () => {
    const r = run(range(1, 300).concat(302), 302, [
      { version: "0301", apply_record: REC },
      { version: "0301", apply_record: REC },
    ]);
    expect(r.invalid_declarations.join(" ")).toMatch(/0301 is declared twice in hosted_without_repo_file/);
  });

  it("NEGATIVE: a malformed version is refused", () => {
    for (const bad of ["301", "03011", "abc", 301, null, undefined]) {
      const r = run(range(1, 300).concat(302), 302, [{ version: bad, apply_record: REC }]);
      expect(r.invalid_declarations.join(" "), String(bad)).toMatch(/hosted_without_repo_file entry has no four-digit version/);
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
    const st = fixture("ok", files, { ...base, hosted_without_repo_file: [{ version: "0002", apply_record: REC }] });
    expect(st.hosted_without_repo_file).toEqual([{ version: "0002", apply_record: REC }]);
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
      hosted_without_repo_file: [{ version: "0002", apply_record: REC }],
    });
    expect(st.invalid_out_of_order_declarations.join(" ")).toMatch(/0002 is declared hosted_without_repo_file but has a repo file/);
  });
});
