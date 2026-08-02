import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// L18 Phase 1A — static drift guard: runtime direct row DML on the two entry
// tables.
// ===========================================================================
//
// Migration 0164 added ONE narrow reviewed create command — `create_laser_entry`
// — and `addLaserEntryAction` now calls it. Direct table grants are still in
// place (this phase revokes nothing), so nothing at the database layer stops a
// future change from reintroducing a direct write. This guard is that stop.
//
// SCOPE, STATED PRECISELY. This phase closes the LASER creation path only.
// `electrolysis_entries` is NOT command-bound in any respect: ALL THREE of its
// runtime writers remain direct, and this guard must never be read as claiming
// otherwise.
//
// It is deliberately NOT a generic, growable allowlist. There are exactly THREE
// permitted exceptions, each pinned to an exact file AND an exact enclosing
// function. Renaming, moving, or adding one fails CI, and so does removing the
// required label. The count itself is asserted, so a fourth can never be
// appended quietly.
//
// THE EXCEPTIONS EXPIRE in the combined session_blocks/electrolysis_entries
// phase. Every one of them can write session_blocks AND electrolysis_entries
// for a single user intent:
//   * createTreatmentAreaWithEntryAction — block then entry; compensates with a
//     soft delete if the entry fails.
//   * updateTreatmentAreaWithEntryAction — block then entry; NO compensation.
//   * addElectrolysisEntryAction — when the form omits `block_id` (a legacy
//     caller shape it deliberately still supports) it calls
//     ensureBlockForSession, which INSERTs a session_blocks row before the
//     entry write. A failed entry write leaves that block behind. An earlier
//     revision of this phase wrongly classified it as entry-only.
// Making any of them genuinely atomic requires a command that owns BOTH writes
// — session_blocks work, out of scope here. When that phase lands, these three
// exceptions and this comment must go with it.

const TABLES = ["electrolysis_entries", "laser_entries"] as const;

const EXCEPTION_LABEL = "TEMPORARY L18 BLOCK-ENTRY ATOMICITY EXCEPTION";

/** The ONLY runtime call sites permitted to write these tables directly. */
const EXCEPTIONS: ReadonlyArray<{ file: string; fn: string }> = [
  {
    file: "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
    fn: "addElectrolysisEntryAction",
  },
  {
    file: "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    fn: "createTreatmentAreaWithEntryAction",
  },
  {
    file: "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    fn: "updateTreatmentAreaWithEntryAction",
  },
];

const ROOTS = ["app", "lib", "components"];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

type Site = { file: string; fn: string; table: string; op: string };

/**
 * Find every runtime direct write on the entry tables, attributing each to its
 * enclosing top-level function. Attribution walks the `.from("<table>")`
 * statement chain to bracket depth zero, so an operation belonging to a later,
 * different chain in the same function is never miscounted — the same method
 * that corrected the writer census from 26 to 25.
 */
function directWriteSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    const fnStarts = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map(
      (m) => ({ idx: m.index ?? 0, name: m[1] }),
    );
    const fromRe = /\.from\(\s*"(electrolysis_entries|laser_entries)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(src)) !== null) {
      const table = m[1];
      let i = m.index + m[0].length;
      let depth = 0;
      let chain = "";
      while (i < src.length) {
        const ch = src[i];
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) depth--;
        else if (ch === ";" && depth <= 0) break;
        chain += ch;
        i++;
      }
      const op = /\.(insert|update|delete|upsert)\s*\(/.exec(chain);
      if (!op) continue;
      const owner = fnStarts.filter((f) => f.idx < m!.index).pop();
      sites.push({
        file: file.split("\\").join("/"),
        fn: owner?.name ?? "(top-level)",
        table,
        op: op[1],
      });
    }
  }
  return sites;
}

describe("L18 Phase 1A — entry-table direct DML guard", () => {
  const sites = directWriteSites();

  it("1. addLaserEntryAction contains NO direct laser_entries DML", () => {
    const offenders = sites.filter((s) => s.fn === "addLaserEntryAction");
    expect(
      offenders,
      "addLaserEntryAction must write only through create_laser_entry (0164)",
    ).toEqual([]);
  });

  it("2. no runtime direct writer on laser_entries exists at all", () => {
    const laser = sites.filter((s) => s.table === "laser_entries");
    expect(
      laser,
      "laser_entries has no permitted direct writer in or after this phase",
    ).toEqual([]);
  });

  it("3. electrolysis direct DML is NOT claimed closed by this phase", () => {
    const elec = sites.filter((s) => s.table === "electrolysis_entries");
    expect(
      elec.length,
      "all three electrolysis writers must still be direct — this phase does " +
        "not make electrolysis_entries command-bound",
    ).toBeGreaterThan(0);
    const fns = [...new Set(elec.map((s) => s.fn))].sort();
    expect(fns).toEqual([
      "addElectrolysisEntryAction",
      "createTreatmentAreaWithEntryAction",
      "updateTreatmentAreaWithEntryAction",
    ]);
  });

  it("4. no runtime direct writer exists outside the pinned exceptions", () => {
    const unexpected = sites.filter(
      (s) => !EXCEPTIONS.some((e) => e.file === s.file && e.fn === s.fn),
    );
    expect(
      unexpected,
      "a new direct row-DML writer on electrolysis_entries / laser_entries was " +
        "introduced. Route it through a narrow reviewed command instead — this " +
        "guard has no generic allowlist to add it to.",
    ).toEqual([]);
  });

  it("5. the exceptions are exactly the three block-coupled electrolysis actions", () => {
    const names = [...new Set(sites.map((s) => s.fn))].sort();
    expect(names).toEqual([
      "addElectrolysisEntryAction",
      "createTreatmentAreaWithEntryAction",
      "updateTreatmentAreaWithEntryAction",
    ]);
  });

  it("6. each exception is in its exact current file and function scope", () => {
    for (const e of EXCEPTIONS) {
      const found = sites.filter((s) => s.file === e.file && s.fn === e.fn);
      expect(
        found.length,
        `${e.fn} must still live in ${e.file} and still write an entry table ` +
          "directly. If it moved, was renamed, or stopped writing, update this " +
          "guard deliberately — do not widen it.",
      ).toBeGreaterThan(0);
    }
  });

  it("7. the exception count is exactly three and cannot silently grow", () => {
    expect(EXCEPTIONS).toHaveLength(3);
    const distinct = new Set(sites.map((s) => `${s.file}::${s.fn}`));
    expect(
      distinct.size,
      "exactly three runtime functions may write these tables directly",
    ).toBe(3);
  });

  it("8. a renamed, moved or newly added exception fails CI", () => {
    // The assertion above is exact-set equality on (file, function), so any
    // rename/move/addition changes the set and fails. This case pins the
    // property itself so the exactness is never relaxed to a subset check.
    const declared = EXCEPTIONS.map((e) => `${e.file}::${e.fn}`).sort();
    const actual = [...new Set(sites.map((s) => `${s.file}::${s.fn}`))].sort();
    expect(actual).toEqual(declared);
  });

  it("9. each exception carries the required label in source", () => {
    for (const e of EXCEPTIONS) {
      const src = readFileSync(e.file, "utf8");
      const start = src.indexOf(`function ${e.fn}`);
      expect(start, `${e.fn} not found in ${e.file}`).toBeGreaterThan(-1);
      // The label must appear in the run-up to the function (its doc comment).
      const preamble = src.slice(Math.max(0, start - 2500), start);
      expect(
        preamble.includes(EXCEPTION_LABEL),
        `${e.fn} must be labelled "${EXCEPTION_LABEL}" so the exception is ` +
          "visible at the call site, not only in this guard",
      ).toBe(true);
    }
  });

  it("10. this guard states when the exceptions expire", () => {
    const self = readFileSync("tests/security/entry-direct-dml-guard.test.ts", "utf8");
    expect(self).toMatch(/THE EXCEPTIONS EXPIRE in the combined/i);
    // Newline-tolerant: the expiry sentence wraps across comment lines.
    expect(self.replace(/\s*\n\s*\/\/\s*/g, " ")).toMatch(
      /session_blocks\/electrolysis_entries phase/i,
    );
  });

  it("covers both entry tables", () => {
    expect(TABLES).toEqual(["electrolysis_entries", "laser_entries"]);
  });

  it("the migrated action calls the 0164 command, and no electrolysis command exists", () => {
    const src = readFileSync(
      "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
      "utf8",
    );
    expect(src).toMatch(/rpc\("create_laser_entry"/);
    expect(
      src,
      "there is no electrolysis command in this phase",
    ).not.toMatch(/create_electrolysis_entry/);
  });

  it("the actions module never reaches for the admin client", () => {
    const src = readFileSync(
      "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
      "utf8",
    );
    expect(
      src,
      "ordinary practitioner charting must not run through createAdminClient()",
    ).not.toMatch(/createAdminClient/);
  });
});
