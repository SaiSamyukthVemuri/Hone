import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// L18 Phase 2 — static drift guard: runtime direct row DML on the charting
// tables.
// ===========================================================================
//
// PHASE 1A (migration 0164) closed the LASER creation path only, and carried
// THREE named exceptions — `addElectrolysisEntryAction`,
// `createTreatmentAreaWithEntryAction`, `updateTreatmentAreaWithEntryAction`.
// Each could write `session_blocks` AND `electrolysis_entries` for a single
// user intent across two transactions, so a failed second write left the two
// describing different treatments (or left an orphan block behind).
//
// PHASE 2 (migration 0166) retires all three. `create_block_with_entry`,
// `update_block_with_entry`, `add_electrolysis_pass` and
// `soft_delete_session_block` own both halves of every one of those workflows
// in a single transaction, so the exception list is now EMPTY and the guard is
// an absolute one: **no runtime code may issue row DML against these tables.**
//
// Direct table grants still exist at the database layer — this phase revokes
// nothing — so nothing below the application stops a future change from
// reintroducing a direct write. This guard is that stop, and it is deliberately
// NOT a growable allowlist: there is no list left to append to.
//
// `session_block_areas` is included because the area rows are part of the same
// atomic intent; 0129 and 0166 own them, and no action may touch them directly.

const TABLES = [
  "sessions",
  "session_blocks",
  "session_block_areas",
  "electrolysis_entries",
  "laser_entries",
  "treatment_images",
] as const;

// L18 Phase 4 closed `treatment_images`, the last direct-writer surface. There
// is no longer an out-of-scope table on this guard: every L18 table is measured
// and every one must be zero.

/**
 * The exception list is EMPTY and must stay empty. A future phase that needs a
 * temporary exception must add it here deliberately, and the count assertions
 * below force that to be a visible, reviewed change.
 */
const EXCEPTIONS: ReadonlyArray<{ file: string; fn: string }> = [];

/** The four commands migration 0166 introduces. */
const COMMANDS = [
  "create_block_with_entry",
  "update_block_with_entry",
  "add_electrolysis_pass",
  "soft_delete_session_block",
] as const;

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
 * Find every runtime direct write on the charting tables, attributing each to
 * its enclosing top-level function. Attribution walks the `.from("<table>")`
 * statement chain to bracket depth zero, so an operation belonging to a later,
 * different chain in the same function is never miscounted — the same method
 * that corrected the writer census in Phase 1A. A proximity grep over the same
 * tree reported 25 matches at a 6-line window and 27 at 12 lines; neither
 * number is trustworthy, which is why this walks the chain instead.
 */
function directWriteSites(): Site[] {
  const sites: Site[] = [];
  const group = TABLES.join("|");
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    const fnStarts = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map(
      (m) => ({ idx: m.index ?? 0, name: m[1] }),
    );
    const fromRe = new RegExp(`\\.from\\(\\s*["'](${group})["']\\s*\\)`, "g");
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

/** Same statement-chain walk, for a single table outside TABLES. */
function directWriteSitesFor(table: string): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    const fnStarts = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map(
      (m) => ({ idx: m.index ?? 0, name: m[1] }),
    );
    const fromRe = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g");
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(src)) !== null) {
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

describe("L18 Phase 4 — command-bound table direct DML guard", () => {
  const sites = directWriteSites();

  // The census IS the deliverable, so print it in full rather than asserting a
  // bare zero: a reader of a CI log can see exactly what was measured, and a
  // regression names the offending file and function.
  it("0. the runtime writer census is reported in full", () => {
    const report = TABLES.map((t) => {
      const rows = sites.filter((s) => s.table === t);
      return (
        `${t}: ${rows.length}` +
        rows.map((s) => `\n    ${s.op.toUpperCase()} ${s.file} :: ${s.fn}`).join("")
      );
    }).join("\n");
    // eslint-disable-next-line no-console
    console.log(`\nL18 runtime writer census —\n${report}\n`);
    expect(report).toContain("session_blocks: ");
  });

  it("1. session_blocks has NO runtime direct writer", () => {
    expect(
      sites.filter((s) => s.table === "session_blocks"),
      "every session_blocks write must go through a 0166 command",
    ).toEqual([]);
  });

  it("2. electrolysis_entries has NO runtime direct writer", () => {
    expect(
      sites.filter((s) => s.table === "electrolysis_entries"),
      "every electrolysis_entries write must go through a 0166 command",
    ).toEqual([]);
  });

  it("3. session_block_areas has NO runtime direct writer", () => {
    expect(
      sites.filter((s) => s.table === "session_block_areas"),
      "area rows are written only by the commands that own the block",
    ).toEqual([]);
  });

  it("4. laser_entries has NO runtime direct writer (Phase 1A, still held)", () => {
    expect(sites.filter((s) => s.table === "laser_entries")).toEqual([]);
  });

  it("5. the total census is zero across all four tables", () => {
    expect(
      sites,
      "a direct row-DML writer on a charting table was introduced. Route it " +
        "through a reviewed command — this guard has no allowlist to add it to.",
    ).toEqual([]);
  });

  it("6. the exception list is empty and cannot silently grow", () => {
    expect(EXCEPTIONS).toHaveLength(0);
    expect(new Set(sites.map((s) => `${s.file}::${s.fn}`)).size).toBe(0);
  });

  it("7. the retired Phase 1A exception label is gone from the source tree", () => {
    const label = "TEMPORARY L18 BLOCK-ENTRY ATOMICITY EXCEPTION";
    const offenders = sourceFiles().filter((f) => readFileSync(f, "utf8").includes(label));
    expect(
      offenders,
      "the three block-coupled exceptions are retired; their label must not " +
        "survive on a function that no longer has an exception",
    ).toEqual([]);
  });

  it("8. the three retired actions now call the 0166 commands", () => {
    const blockSrc = readFileSync(
      "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
      "utf8",
    );
    const actionsSrc = readFileSync(
      "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
      "utf8",
    );
    expect(blockSrc).toMatch(/"create_block_with_entry"/);
    expect(blockSrc).toMatch(/rpc\("update_block_with_entry"/);
    expect(blockSrc).toMatch(/rpc\("soft_delete_session_block"/);
    expect(actionsSrc).toMatch(/rpc\("add_electrolysis_pass"/);
    // Phase 1A's laser command is untouched.
    expect(actionsSrc).toMatch(/rpc\("create_laser_entry"/);
  });

  it("9. no application-side compensation survives", () => {
    const blockSrc = readFileSync(
      "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
      "utf8",
    );
    // The compensating soft delete existed only because the block could commit
    // without its entry. That is now impossible, so the compensation is gone —
    // not merely unused.
    expect(blockSrc).not.toMatch(/Cleanup: retire the just-created block/);
  });

  it("10. every block/entry command a runtime writer calls is a reviewed one", () => {
    const called = new Set<string>();
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(
        /rpc\(\s*"([a-z_]*block[a-z_]*|[a-z_]*electrolysis[a-z_]*)"/g,
      )) {
        called.add(m[1]);
      }
    }
    const unknown = [...called].filter(
      (c) =>
        !(COMMANDS as readonly string[]).includes(c) &&
        // 0129's pre-existing area commands remain legitimate callees.
        !["create_session_block_with_areas", "update_session_block_with_areas"].includes(c),
    );
    expect(unknown, "an unreviewed block/entry command appeared").toEqual([]);
  });

  it("11. the guard covers all six command-bound tables", () => {
    expect(TABLES).toEqual([
      "sessions",
      "session_blocks",
      "session_block_areas",
      "electrolysis_entries",
      "laser_entries",
      "treatment_images",
    ]);
  });

  it("13. sessions has NO runtime direct writer (L18 Phase 3)", () => {
    expect(
      sites.filter((s) => s.table === "sessions"),
      "every sessions write must go through a 0167 command",
    ).toEqual([]);
  });

  it("14. treatment_images has NO runtime direct writer (L18 Phase 4)", () => {
    expect(
      directWriteSitesFor("treatment_images"),
      "every treatment_images write must go through a 0168 command",
    ).toEqual([]);
  });

  it("16. the three 0168 image commands are called, and the reads are untouched", () => {
    const src = readFileSync("app/(app)/clients/[id]/images/actions.ts", "utf8");
    for (const cmd of [
      "create_treatment_image_metadata",
      "set_treatment_image_note",
      "archive_treatment_image",
    ]) {
      expect(src, `${cmd} must be called`).toContain(`"${cmd}"`);
    }
    // Signed-URL generation and the listing reads are deliberately unchanged.
    expect(src).toMatch(/createSignedUrl/);
    expect(src).toMatch(/\.from\("treatment_images"\)[\s\S]{0,80}\.select\(/);
  });

  it("17. EVERY L18 table is at zero — no exception list remains", () => {
    expect(sites).toEqual([]);
    expect(EXCEPTIONS).toHaveLength(0);
  });

  it("15. the eight 0167 session commands are the only session writers", () => {
    const src = [
      "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
      "app/(app)/clients/[id]/sessions/new/actions.ts",
      "app/(app)/clients/[id]/treatment-plans-actions.ts",
      "app/(app)/records/actions.ts",
    ]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const cmd of [
      "start_session",
      "set_session_price",
      "set_next_session_note",
      "set_session_performer",
      "edit_session_started_at",
      "soft_delete_session",
      "set_session_treatment_plan",
      "set_session_aftercare_explained",
    ]) {
      expect(src, `${cmd} must be called`).toContain(`"${cmd}"`);
    }
  });

  it("12. no charting-table write runs through the admin client", () => {
    expect(
      readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts", "utf8"),
      "ordinary practitioner charting must not run through createAdminClient()",
    ).not.toMatch(/createAdminClient\(/);

    // block-actions.ts DOES construct an admin client, for one pre-existing,
    // registered use that has nothing to do with the charting tables:
    // `rememberMachineFrequencyDefault` writes the practitioner's own
    // `practitioners.default_machine_frequency`. Assert that narrow scope
    // rather than banning the import, so this case stays honest.
    const blockSrc = readFileSync(
      "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
      "utf8",
    );
    const adminUses = [...blockSrc.matchAll(/createAdminClient\(\)/g)];
    expect(adminUses).toHaveLength(1);
    const at = adminUses[0].index ?? 0;
    const owner = [...blockSrc.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)]
      .filter((f) => (f.index ?? 0) < at)
      .pop()?.[1];
    expect(owner).toBe("rememberMachineFrequencyDefault");
    // ...and it touches only `practitioners`.
    const stmt = blockSrc.slice(adminUses[0].index ?? 0, (adminUses[0].index ?? 0) + 400);
    expect(stmt).toMatch(/\.from\("practitioners"\)/);
    for (const t of TABLES) expect(stmt).not.toContain(`"${t}"`);
  });
});
