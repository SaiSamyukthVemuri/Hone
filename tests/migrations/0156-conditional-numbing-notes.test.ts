import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0156 — conditional numbing notes. Additive nullable column +
// carries it through the two authoritative atomic RPCs. Carries the repo
// migration-max tripwire.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0156_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
// The executable DDL only (comment lines stripped) for "never references X" checks.
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");

describe("0156 — conditional numbing notes (repo migration-max tripwire)", () => {
  it("is present, 0155 precedes it, exactly one 0156, nothing 0158+ (repo max pin now lives in the 0157 test)", () => {
    expect(FILE).toMatch(/^0156_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0155_"))).toBe(true);
    // Collision guard: exactly ONE 0156 migration. The absolute repo-max pin
    // moved to the 0157 test (0157 = whole-session copy setup now follows).
    expect(files.filter((f) => /^0156_/.test(f))).toHaveLength(1);
    expect(files.filter((f) => /^01(5[8-9]|[6-9]\d)_/.test(f))).toEqual([]);
  });

  it("adds ONE nullable text column, no default, no NOT NULL, no backfill", () => {
    expect(SQL).toMatch(
      /alter table public\.session_blocks\s+add column if not exists numbing_notes text\s*;/,
    );
    expect(SQL).not.toMatch(/numbing_notes text[^;]*not null/i);
    expect(SQL).not.toMatch(/numbing_notes[^;]*default/i);
    // No backfill / existing-row rewrite. The ONLY UPDATE in the migration is
    // the update RPC's single-block, row-scoped SET (where b.id = p_block_id) —
    // there is no bulk backfill UPDATE of existing rows.
    const updates = CODE.match(/update public\.session_blocks/gi) ?? [];
    expect(updates).toHaveLength(1);
    expect(CODE).toMatch(/where b\.id = p_block_id/);
  });

  it("makes NO RLS / policy / trigger / table / second-column change", () => {
    expect(CODE).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(CODE).not.toMatch(/enable row level security|disable row level security/i);
    expect(CODE).not.toMatch(/create trigger|drop trigger/i);
    expect(CODE).not.toMatch(/create table/i);
    // Only numbing_notes is added; no other new column.
    expect(CODE.match(/add column if not exists/gi) ?? []).toHaveLength(1);
    // No CHECK/length constraint added on the note (documented decision).
    expect(CODE).not.toMatch(/check \([^)]*numbing_notes/i);
  });

  it("carries numbing_notes through BOTH authoritative atomic RPCs", () => {
    expect(SQL).toMatch(
      /create or replace function public\.create_session_block_with_areas/,
    );
    expect(SQL).toMatch(
      /create or replace function public\.update_session_block_with_areas/,
    );
    // create: numbing_notes in the insert column list AND the values list.
    expect(SQL).toMatch(/numbing_status, numbing_notes\s*\n\s*\) values/);
    expect(SQL).toMatch(/r\.numbing_status, r\.numbing_notes\s*\n\s*\)/);
    // update: numbing_notes in the SET list.
    expect(SQL).toMatch(/numbing_notes = r\.numbing_notes/);
  });

  it("preserves OLD-app payload compatibility (absent key -> NULL via jsonb_populate_record)", () => {
    // Both RPCs build the row from p_block with jsonb_populate_record, so an old
    // payload that omits numbing_notes resolves it to NULL (no fabrication).
    expect(SQL.match(/jsonb_populate_record\(null::public\.session_blocks, p_block\)/g) ?? [])
      .toHaveLength(2);
    // Signatures unchanged (value travels inside p_block, not a new param).
    expect(SQL).not.toMatch(/p_numbing_notes/);
  });

  it("documents a MIGRATION-FIRST rollout and touches no unrelated surface", () => {
    expect(SQL).toMatch(/MIGRATION-FIRST \(DB-first\)/i);
    expect(SQL).toMatch(/app-first is NOT safe/i);
    for (const forbidden of [
      /stripe/i, /payment/i, /\bcharge/i, /appointment/i, /\bbooking/i,
      /\bconsent/i, /\bemail/i, /\bsms\b/i, /probe_lots\b/, /electrolysis_entries\.probe_lot_id/,
    ]) {
      expect(CODE).not.toMatch(forbidden);
    }
    expect(SQL).toMatch(/alter table public\.session_blocks/i);
  });
});

// Rollout-contract guard: the runbook + migration header state DB-first and must
// never claim app-first is safe (mirrors the 0155 guard).
describe("0156 rollout is documented as MIGRATION-FIRST (no app-first claim)", () => {
  const ROLLOUT = readFileSync(
    join(process.cwd(), "docs/runbooks/0156-conditional-numbing-notes-rollout.md"),
    "utf8",
  );
  const FORBIDDEN = [
    /app[-\s]?first\s+(deployment\s+)?(is\s+)?(perfectly\s+|totally\s+|completely\s+)?safe/i,
    /app[-\s]?first\s+(is\s+)?fine/i,
    /safe\s+to\s+(deploy|ship|merge)\s+(the\s+)?app(lication)?\s+(first|before)/i,
    /inert\s+until\s+(the\s+)?migration/i,
  ];
  for (const [label, text] of [
    ["rollout runbook", ROLLOUT],
    ["migration header", SQL],
  ] as const) {
    it(`${label} never claims app-first is safe`, () => {
      for (const bad of FORBIDDEN) expect(text).not.toMatch(bad);
    });
  }
  it("the runbook states the DB-first order (migration before merge)", () => {
    expect(ROLLOUT).toMatch(/MIGRATION-FIRST|DB-first/i);
    expect(ROLLOUT).toMatch(/app-first is NOT\s+safe/i);
    // Tolerate markdown bold around BEFORE and line wraps.
    expect(ROLLOUT).toMatch(/apply migration\s+0156\s+to production \*{0,2}BEFORE\*{0,2}\s+merging/i);
    expect(ROLLOUT).toMatch(/do not apply 0156 to production or any remote/i);
  });
});
