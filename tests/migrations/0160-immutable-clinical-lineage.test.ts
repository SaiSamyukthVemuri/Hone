import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0160 — a treatment record belongs to ONE client and ONE encounter.
//
// Closes same-studio wrong-client / wrong-record re-parenting: RLS correctly refuses
// a cross-STUDIO move, but within a studio the member policies are
// `using (is_studio_member(studio_id)) with check (is_studio_member(studio_id))` and
// that predicate still holds after the parent changes, so a raw PostgREST PATCH
// could move a session onto another client's chart. Depends on 0159.
//
// Carries the repo migration-max tripwire (moved here from the 0159 test).

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0160_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, "\n<<body elided>>\n");

function fn(name: string): string {
  const start = CODE.indexOf(`create or replace function public.${name}(`);
  expect(start, `public.${name} is defined`).toBeGreaterThan(-1);
  const open = CODE.indexOf("$$", start);
  return CODE.slice(start, CODE.indexOf("$$", open + 2) + 2);
}

describe("0160 — immutable clinical lineage", () => {
  // The repo-max pin now lives in the 0163 test; 0162 is the current PRODUCTION max.
  it("is present, 0159 precedes it, exactly one 0160, and nothing 0164+ yet", () => {
    expect(FILE).toMatch(/^0160_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0159_"))).toBe(true);
    expect(files.filter((f) => /^0160_/.test(f))).toHaveLength(1);
    const nums = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("states its dependency on 0159 explicitly", () => {
    expect(SQL).toMatch(/DEPENDS ON: migration 0159/i);
  });

  it("the current docs state the APPLIED status and max, so they cannot silently desync", () => {
    // 0160 is APPLIED in production as of 2026-07-30. Before the apply this test
    // asserted the docs said "unapplied" and that repo max was one ahead of hosted;
    // both are now the false claims, so the assertions are reversed.
    const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    for (const f of [
      "docs/production/current-state.md",
      "docs/14_AI_HANDOFF.md",
      "docs/09_DATABASE_AND_RLS.md",
    ]) {
      const flat = read(f).replace(/\s+/g, " ");
      expect(flat, `${f} names 0160`).toMatch(/0160/);
      expect(
        flat,
        `${f} must not still describe 0160 as unapplied/pending — it was applied 2026-07-30`,
      ).not.toMatch(
        // Scoped to the MIGRATION's status. "…source merge is pending" is a different
        // claim about the PR, not about whether the migration ran.
        /0160(?![^.]{0,40}source merge)[^.]{0,70}\b(?:is |remains )?(?:NOT applied|not applied|unapplied|not authorized|migration is pending|apply is pending)/i,
      );
      expect(
        flat,
        `${f} must not still claim the repo max is one ahead of the hosted max`,
      ).not.toMatch(/repo max \(0160\) is deliberately one ahead/i);
    }
    const dbRls = read("docs/09_DATABASE_AND_RLS.md").replace(/\s+/g, " ");
    // 0162 was applied 2026-08-02, so the production max advanced past 0161.
    // 0160 itself remains applied and immutable — that is asserted above.
    expect(
      dbRls,
      "docs/09 must state the production migration max is 0165",
    ).toMatch(/production migration max = 0165/i);
    // 0163 is now APPLIED, so repo max and hosted max MATCH again. (This pin
    // oscillates by design: parity while nothing is pending, split while a
    // migration is written and unapplied.)
    expect(
      dbRls,
      "docs/09 must record 0165 as applied, not as written-but-unapplied",
    ).toMatch(/0165[\s\S]{0,200}applied 2026-08-02/i);
    // 0164 is written but NOT APPLIED, so repo and hosted deliberately DIFFER
    // again. (This pin oscillates by design: parity while nothing is pending,
    // split while a migration is written and unapplied.)
    expect(
      dbRls,
      "docs/09 must state repository and hosted migration state match",
    ).toMatch(/repository and hosted migration state \*{0,2}match/i);
    expect(
      dbRls,
      "docs/09 must not still describe 0165 as NOT APPLIED",
    ).not.toMatch(/0165[^.\n]{0,120}\bNOT\s*\n?APPLIED\b/i);
    expect(
      dbRls,
      "docs/09 must not still claim hosted max is 0161",
    ).not.toMatch(/hosted max is (?:still )?0161/i);
    expect(
      dbRls,
      "docs/09 must name 0166 as the next number to allocate",
    ).toMatch(/Current repo max `0165`, so the next is\s*`0166`/i);
  });

  it("the applied 0160 checksum is pinned in the ledger and matches the file on disk", () => {
    const APPLIED_SHA = "e56a1ee7efc95e561cd17a0c33750ee4aaaf2a956f425576af39ce4a0e6094d4";
    expect(
      createHash("sha256").update(SQL).digest("hex"),
      "0160 is APPLIED in production with this checksum. Never edit an applied migration — " +
        "write a new one (0161).",
    ).toBe(APPLIED_SHA);
    const ledger = readFileSync(join(process.cwd(), "docs/production/migration-ledger.md"), "utf8");
    expect(
      ledger,
      "the ledger must carry 0160's COMPLETE sha256, not an abbreviation",
    ).toContain(APPLIED_SHA);
    expect(ledger, "the ledger must record the exact apply window").toMatch(
      /2026-07-30T17:52:48Z\s*→\s*17:52:51Z/,
    );
  });

  it("current docs state the lineage defect is enforced, and do NOT overclaim", () => {
    const cs = readFileSync(join(process.cwd(), "docs/production/current-state.md"), "utf8");
    const flat = cs.replace(/\s+/g, " ");
    expect(
      flat,
      "current-state must say the re-parenting defect is database-enforced, deployed and verified",
    ).toMatch(/database-enforced,\s*deployed and production-verified/i);
    expect(flat, "…and that it ran in an explicit transaction with no 25P01").toMatch(
      /explicit `BEGIN` \/ `SET LOCAL lock_timeout` \/ `COMMIT` transaction/,
    );
    expect(flat, "…naming every protected identity column").toMatch(/electrolysis_entries\.block_id/);
    expect(flat, "…and that block_id is clearable only to NULL").toMatch(
      /clearable only to `NULL`/i,
    );
    expect(flat, "ordinary charting must still be described as editable").toMatch(
      /Ordinary charting remains fully editable/i,
    );
    expect(
      flat,
      "current-state must NOT claim 0160 closed all clinical write risk",
    ).toMatch(/0160 does not close all clinical write risks/i);
    for (const l of ["L18", "L19", "L20", "L21"]) {
      expect(flat, `${l} must still be named as open`).toContain(l);
    }
  });

  it("L20 and L21 remain OPEN, and the broader DML boundary is not declared closed", () => {
    const kl = readFileSync(join(process.cwd(), "docs/production/known-limitations.md"), "utf8");
    for (const heading of [
      "## L18 — `authenticated` still holds direct row DML on five clinical tables",
      "## L19 — `TRUNCATE` is still granted broadly outside the clinical tables",
      "## L20 — `service_role` retains `TRIGGER` on the clinical tables",
      "## L21 — hard-deleting a session in the SAME transaction",
    ]) {
      expect(kl, `${heading} must still exist — 0160 closed none of these`).toContain(heading);
    }
    const flat = kl.replace(/\s+/g, " ");
    expect(flat, "L20 must be marked as remaining open").toMatch(
      /its guards are effective against every role reachable from the application\. \*\*This limitation remains OPEN\.\*\*/i,
    );
    expect(flat, "L21 must be marked as remaining open").toMatch(
      /not\*\* a blocker for migration 0160, which is now applied\. \*\*This limitation remains OPEN\.\*\*/i,
    );
  });

  it("the capability manifest reports the corrected hosted max", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "docs/roadmap/CAPABILITY_MANIFEST.json"), "utf8"),
    );
    expect(
      manifest.hosted_migration_max,
      "the manifest's hosted_migration_max is a current-state field and must read 0160",
    ).toBe("0160");
    expect(manifest.as_of).toBe("2026-07-30");
  });
});

describe("0160 — the guards", () => {
  it("the strict guard compares OLD vs NEW only, and needs no elevated rights", () => {
    const body = fn("guard_immutable_clinical_lineage");
    expect(body).toMatch(/security invoker/);
    expect(body).toMatch(/set search_path = ''/);
    expect(body).toMatch(/v_old is distinct from v_new/);
    // Driven by TG_ARGV so each table names its own immutable columns.
    expect(body).toMatch(/foreach v_col in array tg_argv/);
    // It reads no table — the less authority a guard holds, the less to abuse.
    expect(body).not.toMatch(/\bfrom public\./);
  });

  it("the CLEARABLE guard exists and tolerates a transition to NULL", () => {
    // electrolysis_entries(session_id, block_id) -> session_blocks is ON DELETE SET
    // NULL (block_id). A blunt guard would reject that cascade and make block
    // deletion impossible — the trap 0093 already navigated for treatment_images.
    const body = fn("guard_clearable_clinical_lineage");
    expect(body).toMatch(/v_old is distinct from v_new and v_new is not null/);
    expect(SQL).toMatch(/ON DELETE SET NULL/);
    expect(SQL).toMatch(/0093/);
  });

  it("pins exactly the lineage columns, per table, on UPDATE only", () => {
    const expected: Array<[string, string, string[]]> = [
      ["sessions_immutable_lineage", "sessions", ["client_id", "studio_id"]],
      ["session_blocks_immutable_lineage", "session_blocks", ["session_id", "studio_id"]],
      ["electrolysis_entries_immutable_lineage", "electrolysis_entries", ["session_id"]],
      ["laser_entries_immutable_lineage", "laser_entries", ["session_id"]],
    ];
    for (const [trg, tbl, cols] of expected) {
      expect(CODE, trg).toMatch(new RegExp(`drop trigger if exists ${trg} on public\\.${tbl};`));
      expect(CODE, trg).toMatch(
        new RegExp(
          `create trigger ${trg}\\s+before update of ${cols.join(", ")} on public\\.${tbl}\\s+for each row execute function public\\.guard_immutable_clinical_lineage\\(${cols
            .map((c) => `'${c}'`)
            .join(", ")}\\);`,
        ),
      );
      // UPDATE only: INSERT is where lineage is legitimately established.
      expect(CODE, trg).not.toMatch(new RegExp(`create trigger ${trg}\\s+before insert`));
    }
    expect(CODE).toMatch(
      /create trigger electrolysis_entries_clearable_lineage\s+before update of block_id on public\.electrolysis_entries\s+for each row execute function public\.guard_clearable_clinical_lineage\('block_id'\);/,
    );
  });

  it("deliberately does NOT re-guard treatment_images — 0093 already does it, better", () => {
    expect(CODE).not.toMatch(/create trigger treatment_images_immutable_lineage/);
    expect(CODE).not.toMatch(/on public\.treatment_images/);
    expect(SQL).toMatch(/treatment_images_enforce_integrity/);
    expect(SQL).toMatch(/DELIBERATELY NOT COVERED HERE/);
  });
});

describe("0160 — it does not re-freeze ordinary charting", () => {
  it("pins no clinical-content column anywhere", () => {
    // The whole point of the product decision is that treatment records stay
    // editable. Only lineage is immutable — never a clinical value.
    for (const col of [
      "session_notes",
      "next_session_note",
      "energy_level",
      "minutes_performed",
      "hairs_treated",
      "observation_chips",
      "primary_area",
      "laterality",
      "numbing_status",
      "record_status",
      "deleted_at",
      "practitioner_id",
      "started_at",
      "price_paid_cents",
    ]) {
      expect(CODE, col).not.toMatch(new RegExp(`'${col}'`));
    }
  });

  it("adds nothing from the retired signed-record system", () => {
    for (const gone of [
      "clinical_record_snapshots",
      "build_session_snapshot",
      "finalize_session",
      "correct_finalized_session",
      "content_hash",
      "snapshot",
    ]) {
      expect(CODE, gone).not.toMatch(new RegExp(gone, "i"));
    }
    // Word-bounded: "re-assigned" legitimately contains the letters of "signed".
    expect(CODE).not.toMatch(/\bsigned\b/i);
  });

  it("touches no grant, no policy and no RLS posture", () => {
    expect(CODE).not.toMatch(/\bgrant\b/i);
    expect(CODE).not.toMatch(/\brevoke\b/i);
    expect(CODE).not.toMatch(/\bcreate policy\b/i);
    expect(CODE).not.toMatch(/\brow level security\b/i);
  });
});

describe("0160 — ZERO data operations, nothing destructive", () => {
  it("runs no DML at apply time and drops nothing it must keep", () => {
    expect(TOP_LEVEL).not.toMatch(/\binsert into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete from\b/i);
    expect(TOP_LEVEL).not.toMatch(/\btruncate\b/i);
    expect(CODE).not.toMatch(/\bdrop (table|column|function|index)\b/i);
    expect(CODE).not.toMatch(/\balter table\b/i);
    expect(CODE).not.toMatch(/\bbackfill\b/i);
  });

  it("bounds the apply and explains the correct remedy for a mis-filed record", () => {
    expect(CODE).toMatch(/^set local lock_timeout = '5s';$/m);
    // The guard pushes people toward soft-delete + re-chart, which keeps an
    // attributable trail instead of silently rewriting history in place. Say so in
    // the error the practitioner would actually see.
    expect(fn("guard_immutable_clinical_lineage")).toMatch(/File it on the correct client instead/);
    expect(SQL).toMatch(/soft-delet/i);
  });

  it("records that it needs no application change, and why", () => {
    expect(SQL).toMatch(/NEEDS NO APPLICATION CHANGE/i);
    expect(SQL).toMatch(/26/); // the verified call-site count
    expect(SQL).toMatch(/INSERT only/i);
  });
});

// ---------------------------------------------------------------------------
// TRANSACTION CONTRACT (added after the migration-0159 production apply).
//
// Applying 0159 emitted `WARNING (25P01): SET LOCAL can only be used in
// transaction blocks` — `supabase db push` does NOT wrap a migration file in an
// explicit transaction, so `SET LOCAL lock_timeout` never armed and the file was
// not atomic. 0160 must therefore open its own transaction.
//
// These assertions parse EXECUTABLE statements. Grepping the raw file for
// "begin"/"commit" would pass on a migration that merely mentions them in a
// comment or in a PL/pgSQL function body, which is exactly the failure mode
// worth guarding.
// ---------------------------------------------------------------------------

/**
 * Executable SQL statements, with comments and dollar-quoted function bodies
 * removed. PL/pgSQL bodies contain their own `begin`/`end`, so leaving them in
 * would make a body's `begin` masquerade as transaction control.
 */
function executableStatements(sql: string): string[] {
  const withoutBodies = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$BODY$$");
  const withoutBlockComments = withoutBodies.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  return withoutLineComments
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s.length > 0);
}

describe("0160 — transaction contract (learned from the 0159 apply)", () => {
  const statements = executableStatements(SQL);

  it("opens with BEGIN as the very first executable statement", () => {
    expect(
      statements[0]?.toLowerCase(),
      "`supabase db push` does not wrap migrations in a transaction, so 0160 must " +
        "open one itself or its lock_timeout will not arm and the apply will not be atomic",
    ).toBe("begin");
  });

  it("sets a LOCAL lock_timeout, and does so inside the transaction", () => {
    const beginAt = statements.findIndex((s) => s.toLowerCase() === "begin");
    const setAt = statements.findIndex((s) => /^set\s+local\s+lock_timeout/i.test(s));
    expect(setAt, "0160 must set a lock_timeout").toBeGreaterThan(-1);
    expect(
      setAt,
      "SET LOCAL must come AFTER BEGIN — outside a transaction block it raises 25P01 " +
        "and silently does nothing (this is exactly what happened to 0159)",
    ).toBeGreaterThan(beginAt);
    expect(statements[setAt]).toMatch(/^set local lock_timeout = '5s'$/i);
  });

  it("never uses a session-global SET lock_timeout", () => {
    const globalSet = statements.filter((s) => /^set\s+lock_timeout/i.test(s));
    expect(
      globalSet,
      "a session-global SET would leak a modified lock_timeout into the pooled " +
        "connection that runs the next migration; SET LOCAL reverts at COMMIT/ROLLBACK",
    ).toEqual([]);
  });

  it("closes with COMMIT as the final executable statement", () => {
    expect(statements[statements.length - 1]?.toLowerCase()).toBe("commit");
  });

  it("opens and closes exactly one transaction, and never rolls back mid-file", () => {
    const begins = statements.filter((s) => s.toLowerCase() === "begin");
    const commits = statements.filter((s) => s.toLowerCase() === "commit");
    const rollbacks = statements.filter((s) => /^rollback/i.test(s));
    expect(begins).toHaveLength(1);
    expect(commits).toHaveLength(1);
    expect(rollbacks).toEqual([]);
  });

  it("contains no statement that is illegal inside a transaction block", () => {
    const FORBIDDEN: Array<[RegExp, string]> = [
      [/\bconcurrently\b/i, "CREATE/DROP INDEX CONCURRENTLY cannot run in a transaction"],
      [/\balter\s+type\b[\s\S]*\badd\s+value\b/i, "ALTER TYPE ... ADD VALUE is restricted in a transaction"],
      [/\bcreate\s+database\b/i, "CREATE DATABASE cannot run in a transaction"],
      [/\bdrop\s+database\b/i, "DROP DATABASE cannot run in a transaction"],
      [/\bvacuum\b/i, "VACUUM cannot run in a transaction"],
      [/\bcreate\s+tablespace\b/i, "CREATE TABLESPACE cannot run in a transaction"],
      [/\bdrop\s+tablespace\b/i, "DROP TABLESPACE cannot run in a transaction"],
      [/\bcluster\b/i, "CLUSTER cannot run in a transaction"],
      [/\bdiscard\b/i, "DISCARD cannot run in a transaction"],
      [/\bcreate\s+subscription\b/i, "CREATE SUBSCRIPTION cannot run in a transaction"],
    ];
    for (const [re, why] of FORBIDDEN) {
      const hit = statements.find((s) => re.test(s));
      expect(hit, `0160 opens an explicit transaction, so: ${why}`).toBeUndefined();
    }
  });

  it("does not modify the already-applied migration 0159", () => {
    // 0159 is APPLIED in production. Its recorded checksum must keep describing
    // the file on disk; a migration file is never edited after it is applied.
    const applied = readFileSync(
      join(MIG_DIR, "0159_retire_signed_clinical_records.sql"),
      "utf8",
    );
    const sha = createHash("sha256").update(applied).digest("hex");
    expect(
      sha,
      "migration 0159 was applied to production 2026-07-30 with this exact checksum. " +
        "If you need to change its behaviour, write a NEW migration — never edit an applied one.",
    ).toBe("ea39fc360cc75609a92a3686d677486720e9d234c4b70b81a07913c31fb889f8");
    expect(
      applied,
      "0159 keeps its original `set local lock_timeout` line: it is a historical artifact, " +
        "not something to retro-fix. 0160 is where the transaction lesson is applied.",
    ).toMatch(/set local lock_timeout = '5s';/);
  });
});
