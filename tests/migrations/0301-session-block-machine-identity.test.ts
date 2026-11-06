import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0301 session_blocks machine identity: source contract. Behaviour is proved in
// tests/db/session-block-machine-identity.db.test.ts. No repo-max pin (CLAUDE.md section 2).
const sql = readFileSync("supabase/migrations/0301_session_block_machine_identity.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const base = readFileSync("supabase/migrations/0223_machine_inventory_and_setup_readings.sql", "utf8");

const paramNames = (src: string, fn: string): string[] => {
  const start = src.indexOf(`create or replace function public.${fn}(`);
  expect(start, fn).toBeGreaterThan(-1);
  const end = src.indexOf("\nreturns", start);
  return [...src.slice(start, end).replace(/^\s*--.*$/gm, "").matchAll(/^\s*(p_\w+)\s/gm)].map((m) => m[1]);
};

describe("0301: shape", () => {
  it("owns one filename and opens its own transaction with lock_timeout inside", () => {
    expect(countVersion("0301")).toBe(1);
    expect(fileForVersion("0301")).toBe("0301_session_block_machine_identity.sql");
    expect(code.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(code.trim()).toMatch(/commit;$/);
  });
  it("is additive: nullable columns, no default, no backfill, no drop", () => {
    expect(code).toMatch(/add column if not exists machine_profile_id\s+text,/);
    expect(code).toMatch(/studio_machine_id\s+uuid references public\.studio_machines \(id\),/);
    expect(code).toMatch(/machine_mode_key\s+text;/);
    const added = code.match(/alter table public\.session_blocks\s+add column[^;]*;/i)![0];
    expect(added).not.toMatch(/not null/i);
    expect(code).not.toMatch(/add column[^;]*\bdefault\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|column)\b/i);
    // the only UPDATE is inside apply_block_machine_identity, scoped to one block
    const updates = code.match(/\bupdate\s+public\./gi) ?? [];
    expect(updates).toHaveLength(1);
    expect(code).toMatch(/where b\.id = p_block_id\s+and b\.studio_id = p_studio_id/);
  });
});

describe("0301: the initial-save wrapper forwards 0223's parameters, by name and in order", () => {
  it("declares 0223's list plus p_machine_profile_id and forwards every one by name", () => {
    const orig = paramNames(base, "create_block_with_initial_setup");
    const wrap = paramNames(sql, "create_block_with_initial_setup_and_identity");
    expect(orig).toHaveLength(30);
    expect(wrap).toEqual([...orig, "p_machine_profile_id"]);
    const call = code.slice(code.indexOf("v_result := public.create_block_with_initial_setup("));
    const forwarded = [...call.slice(0, call.indexOf(");")).matchAll(/(p_\w+) => (p_\w+)/g)];
    expect(forwarded.map((m) => m[1])).toEqual(orig);
    for (const m of forwarded) expect(m[2]).toBe(m[1]);
  });
});

describe("0301: grants", () => {
  const revoked = (sig: string) =>
    ["public", "anon", "authenticated", "service_role"].every((r) =>
      new RegExp(`revoke execute on function public\\.${sig.replace(/[()]/g, "\\$&")}[^;]*from ${r};`).test(code),
    );
  const internal = "apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz, text, text)";
  const commands = [
    "record_block_machine_identity(uuid, uuid, uuid, text, uuid, text, text, timestamptz)",
    "record_setup_submission_with_identity(uuid, uuid, text, text, jsonb, uuid, uuid, timestamptz)",
  ];
  it("the internal writer is granted to no API role", () => {
    expect(revoked(internal)).toBe(true);
    expect(code).not.toMatch(/grant execute on function public\.apply_block_machine_identity/);
  });
  it("each command revokes public, anon, authenticated and service_role by name, then grants authenticated only", () => {
    for (const sig of commands) {
      expect(revoked(sig), sig).toBe(true);
      expect(code).toContain(`grant execute on function public.${sig} to authenticated;`);
    }
    const grants = [...code.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to (\w+);/g)];
    expect(grants.map((g) => g[2])).toEqual(["authenticated", "authenticated", "authenticated"]);
    expect(code.match(/revoke execute on function public\.create_block_with_initial_setup_and_identity/g)).toHaveLength(4);
  });
  it("derives studio and actor; the caller supplies neither", () => {
    expect(code).not.toMatch(/p_studio_id\b[^,)]*,\s*\n?\s*p_block_id/);
    expect(code.match(/assert_session_writable\(p_session_id, p_client_id\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("0301: wording", () => {
  it("says the practitioner, with no pronouns", () => {
    expect(sql).not.toMatch(/\b(she|he|her|his|hers)\b/i);
  });
});

describe("0301: the write receipts table (Codex 4488743493 and 4488743496)", () => {
  it("is created once, with RLS on, no policy, and direct privileges revoked from every API role by name", () => {
    expect(code.match(/create table if not exists public\.block_write_receipts/g)).toHaveLength(1);
    expect(code).toMatch(/alter table public\.block_write_receipts enable row level security;/);
    expect(code).not.toMatch(/create policy[^;]*block_write_receipts/i);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code, role).toContain(`revoke all on public.block_write_receipts from ${role};`);
    }
    expect(code).not.toMatch(/grant [a-z, ]+ on public\.block_write_receipts/i);
  });
  it("is unique per (block, kind, key) and keeps no clinical or free-text column", () => {
    const table = code.slice(code.indexOf("create table if not exists public.block_write_receipts"), code.indexOf("comment on table public.block_write_receipts"));
    expect(table).toMatch(/unique \(session_block_id, kind, idempotency_key\)/);
    const textCols = [...table.matchAll(/^\s+(\w+) text\b/gm)].map((m) => m[1]);
    expect(textCols.sort()).toEqual(["idempotency_key", "kind", "machine_mode_key", "machine_profile_id", "payload_digest"]);
  });
  it("a replay is answered from the receipt BEFORE the stale check, and never reads the block's current version into the answer", () => {
    const apply = code.slice(code.indexOf("create or replace function public.apply_block_machine_identity"), code.indexOf("create or replace function public.record_block_machine_identity"));
    expect(apply.indexOf("from public.block_write_receipts r")).toBeGreaterThan(-1);
    expect(apply.indexOf("from public.block_write_receipts r")).toBeLessThan(apply.indexOf("stale_block_version"));
    expect(apply).toMatch(/'updated_at', v_receipt\.resulting_updated_at/);
  });
  it("the readings replay returns the stored version from its receipt, not the block's", () => {
    const wrap = code.slice(code.indexOf("create or replace function public.record_setup_submission_with_identity"));
    expect(wrap).toMatch(/'block_updated_at', v_receipt\.resulting_updated_at/);
    expect(wrap).not.toMatch(/select b\.updated_at/);
  });
});
