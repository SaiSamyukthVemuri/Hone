import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0157 — whole-session "Copy areas and settings": one idempotency
// ledger table + one atomic batch-copy RPC. Additive; carries the repo
// migration-max tripwire.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0157_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");

describe("0157 — whole-session copy (repo migration-max tripwire)", () => {
  it("is present, 0156 precedes it, exactly one 0157, and it is the repo max (nothing 0158+)", () => {
    expect(FILE).toMatch(/^0157_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0156_"))).toBe(true);
    expect(files.filter((f) => /^0157_/.test(f))).toHaveLength(1);
    expect(files.filter((f) => /^01(5[8-9]|[6-9]\d)_/.test(f))).toEqual([]);
    const nums = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(nums[nums.length - 1]).toBe(157);
  });

  it("adds the idempotency ledger table with the (session_id, idempotency_key) UNIQUE, member-only RLS", () => {
    expect(SQL).toMatch(
      /create table if not exists public\.session_copy_operations/,
    );
    expect(SQL).toMatch(
      /constraint session_copy_operations_idem_uniq unique \(session_id, idempotency_key\)/,
    );
    expect(SQL).toMatch(
      /alter table public\.session_copy_operations enable row level security/,
    );
    // Member SELECT only; NO browser insert/update/delete policy (writes only via
    // the SECURITY DEFINER RPC).
    expect(SQL).toMatch(/for select to authenticated/i);
    expect(SQL).not.toMatch(/for insert to authenticated/i);
    expect(SQL).not.toMatch(/for update to authenticated/i);
    expect(SQL).not.toMatch(/for delete/i);
    expect(SQL).toMatch(/revoke all on public\.session_copy_operations from anon/);
  });

  it("the copy RPC is SECURITY DEFINER, member-gated, idempotent, and setup-only", () => {
    expect(SQL).toMatch(
      /create or replace function public\.copy_session_setup/,
    );
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
    // Authorization + lineage.
    expect(SQL).toMatch(/is_studio_member\(p_studio_id\)/);
    expect(SQL).toMatch(/from public\.sessions[\s\S]{0,120}deleted_at is null/);
    // Idempotency: prior batch returns its ids (no new rows).
    expect(SQL).toMatch(/idempotent_replay/);
    expect(SQL).toMatch(
      /session_id = p_session_id and idempotency_key = p_idempotency_key/,
    );
    // Least-privilege grants.
    expect(SQL).toMatch(
      /revoke all on function public\.copy_session_setup\(uuid, uuid, jsonb, text\) from public, anon/,
    );
    expect(SQL).toMatch(/grant execute on function public\.copy_session_setup.*to authenticated, service_role/);
  });

  it("SETUP-ONLY: the block + entry INSERT column lists carry NO outcome columns", () => {
    // The two INSERT statements (block, entry) must not name any outcome column.
    for (const outcome of [
      "comments",
      "observation_chips",
      "hairs_treated",
      "tolerance_rating",
      "reaction_type",
      "reaction_notes",
      "caution_for_next_session",
      "caution_note",
      "numbing_status",
      "numbing_notes",
      "probe_lot_number",
      "probe_lot_confirmed",
      "probe_inventory_item_id",
      "probe_lot_id",
    ]) {
      expect(CODE).not.toMatch(new RegExp(`\\b${outcome}\\b`));
    }
  });

  it("is additive: no ALTER/DROP of existing tables, no backfill, no change to the 0129/0155/0156 block RPCs", () => {
    expect(CODE).not.toMatch(/alter table public\.session_blocks/i);
    expect(CODE).not.toMatch(/alter table public\.electrolysis_entries/i);
    expect(CODE).not.toMatch(/drop /i);
    // Only the NEW copy RPC is (re)created — not the existing block/area RPCs.
    expect(CODE).not.toMatch(/create or replace function public\.create_session_block_with_areas/);
    expect(CODE).not.toMatch(/create or replace function public\.update_session_block_with_areas/);
    // No bulk backfill UPDATE.
    expect(CODE).not.toMatch(/update public\.(session_blocks|electrolysis_entries)/i);
  });

  it("documents a MIGRATION-FIRST rollout and touches no unrelated surface", () => {
    expect(SQL).toMatch(/MIGRATION-FIRST \(DB-first\)/i);
    expect(SQL).toMatch(/app-first is NOT safe/i);
    for (const forbidden of [
      /stripe/i, /payment/i, /appointment/i, /\bconsent/i, /\bemail/i, /\bsms\b/i,
      /probe_lots\b/, /electrolysis_entries\.probe_lot_id/,
    ]) {
      expect(CODE).not.toMatch(forbidden);
    }
  });
});

describe("0157 rollout is documented as MIGRATION-FIRST (no app-first claim)", () => {
  const ROLLOUT = readFileSync(
    join(process.cwd(), "docs/runbooks/0157-whole-session-copy-rollout.md"),
    "utf8",
  );
  const FORBIDDEN = [
    /app[-\s]?first\s+(deployment\s+)?(is\s+)?(perfectly\s+|totally\s+)?safe/i,
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
    expect(ROLLOUT).toMatch(/apply migration\s+0157\s+to production \*{0,2}BEFORE\*{0,2}\s+merging/i);
    expect(ROLLOUT).toMatch(/do not apply 0157 to production or any remote/i);
  });
});
