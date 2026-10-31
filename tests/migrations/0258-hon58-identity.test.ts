import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0258 — HON-58 client identity. The number is RESERVED by OPS for HON-58
// (01-ops/MIGRATION-RESERVATIONS.md, 2026-10-27T18:58Z; 0247-0257 belong to the
// staged workstream). Merging stays held behind that ordering: hosted max is
// 0246 and nothing here is applied hosted without its own exact-stage approval.
// Behaviour is proved in tests/db/hon58-identity.db.test.ts; this file pins the
// SOURCE contract. Per CLAUDE.md §2 it does not hard-code the repo max.

const FILE = "supabase/migrations/0258_hon58_identity.sql";
const sql = readFileSync(FILE, "utf8");
// Executable SQL: no comment lines and no COMMENT ON statements (their text names the denied roles).
const code = sql.replace(/^\s*--.*$/gm, "").replace(/comment on [^;]*;/gi, "");

describe("0258 hon58 identity: source contract", () => {
  it("owns exactly one filename and is a byte-for-byte copy of the reviewed proposal", () => {
    expect(countVersion("0258")).toBe(1);
    expect(fileForVersion("0258")).toBe("0258_hon58_identity.sql");
    expect(sql).toBe(readFileSync("docs/proposals/hon58-identity.sql", "utf8"));
  });

  it("opens its own transaction with lock_timeout inside it", () => {
    expect(code.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(code.trim()).toMatch(/commit;$/);
  });

  it("is additive: no backfill DML, no destructive DDL, no index, no booking function", () => {
    expect(code).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from|truncate|drop\s+(table|column|function|policy))/i);
    expect(code).not.toMatch(/\bcreate\s+(unique\s+)?index\b/i);
    expect(code).not.toMatch(/\bdefault\b[^;]*preferred_name|preferred_name[^;]*\bdefault\b/i);
    expect(code).not.toMatch(/public\.(book|create_public|public_booking)/i);
  });

  it("adds a nullable preferred_name with a shape check and a one-row-per-client legal identity table", () => {
    expect(code).toContain("add column preferred_name text;");
    expect(code).toContain("clients_preferred_name_shape");
    expect(code).toContain("create table public.client_legal_identities");
    expect(code).toContain("client_id         uuid primary key");
    expect(code).toContain("references public.clients (id, studio_id) on delete cascade");
    expect(code).toContain("source = 'staff_entry'");
  });

  it("gates legal identity through ONE predicate that is exactly is_studio_member (receptionists denied)", () => {
    expect(code).toMatch(/create function public\.can_use_client_legal_identity\(target_studio_id uuid\)[\s\S]*?select public\.is_studio_member\(target_studio_id\);/);
    const policies = [...code.matchAll(/create policy \w+\s+on public\.client_legal_identities for (\w+) to (\w+)/g)];
    expect(policies.map((m) => [m[1], m[2]])).toEqual([["select", "authenticated"], ["insert", "authenticated"], ["update", "authenticated"]]);
    for (const m of code.matchAll(/(using|with check) \(([^)]*\))\)/g)) expect(m[2]).toContain("can_use_client_legal_identity(studio_id)");
    expect(code).not.toMatch(/receptionist/i);
    expect(code).not.toMatch(/\bfor\s+delete\b|\bfor\s+all\b/i);
  });

  it("revokes every default grant by name and grants only authenticated, never service_role or anon", () => {
    expect(code).toContain("revoke all on public.client_legal_identities from public, anon, authenticated, service_role;");
    expect(code).toContain("grant select, insert, update on public.client_legal_identities to authenticated;");
    expect(code).toContain("revoke all on function public.can_use_client_legal_identity(uuid) from public, anon, authenticated, service_role;");
    expect(code).toContain("revoke all on function public.client_legal_identities_guard() from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/grant[^;]*\bservice_role\b/i);
    expect(code).not.toMatch(/grant[^;]*\banon\b/i);
    expect(code).not.toMatch(/grant[^;]*\bdelete\b/i);
  });

  it("is not a security definer and sets search_path on both functions", () => {
    expect(code).not.toMatch(/security\s+definer/i);
    expect([...code.matchAll(/set search_path = public/g)]).toHaveLength(2);
  });
});
