import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 0307 front-desk commands: source contract. The behaviour is proved on a real database in
// tests/db/receptionist-frontdesk-commands.db.test.ts; this pins the shape so a refactor cannot widen what a
// receptionist may write or loosen who may call it.

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0307_receptionist_noshow_and_client_contact.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const fn = (name: string) => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`));
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
};
const COMMANDS = ["receptionist_mark_no_show", "receptionist_create_client", "receptionist_update_client_contact"];

describe("0307 receptionist front-desk commands", () => {
  it("opens its own transaction with a lock timeout and ends committed", () => {
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/set local lock_timeout = '5s';/);
    expect(code).toMatch(/commit;\s*$/);
  });
  it("creates exactly one table and no policy, trigger or index; the audit table has no grant and no policy", () => {
    expect(code.match(/create table /g)).toHaveLength(1);
    expect(code).not.toMatch(/\bcreate\s+(policy|trigger|(unique\s+)?index)\b/i);
    expect(code).toMatch(/alter table public\.receptionist_client_audit enable row level security/);
    expect(code).toMatch(/revoke all on public\.receptionist_client_audit from public, anon, authenticated, service_role;/);
    expect(code).not.toMatch(/grant\s+(select|insert|update|delete|all)[^;]*receptionist_client_audit/i);
  });
  it("every command is a security definer with an empty-schema search path, resolves the actor from the JWT and refuses others with 42501", () => {
    for (const name of COMMANDS) {
      const body = fn(name);
      expect(body).toMatch(/security definer/);
      expect(body).toMatch(/set search_path to 'pg_catalog', 'pg_temp'/);
      expect(body).toMatch(/public\.receptionist_actor_id\(p_studio_id\)/);
      expect(body).toMatch(/errcode = '42501'/);
      expect(body).not.toMatch(/p_actor|p_receptionist|p_user/);
    }
  });
  it("every command is revoked from all four roles by name and granted to authenticated only", () => {
    expect(code).toMatch(/revoke all on function public\.receptionist_mark_no_show\(uuid, uuid\) from public, anon, authenticated, service_role;/);
    expect(code).toMatch(/revoke all on function public\.receptionist_create_client\(uuid, text, text, text, text\) from public, anon, authenticated, service_role;/);
    expect(code).toMatch(/revoke all on function public\.receptionist_update_client_contact\(uuid, uuid, jsonb, jsonb\) from public, anon, authenticated, service_role;/);
    const grants = code.match(/grant execute on function [^;]+;/g) ?? [];
    expect(grants).toHaveLength(3);
    for (const g of grants) expect(g).toMatch(/ to authenticated;$/);
  });
  it("the contact command writes only preferred_name, phone and email", () => {
    const body = fn("receptionist_update_client_contact");
    const update = body.match(/update public\.clients\s+set ([\s\S]*?)\s+where/);
    expect(update).not.toBeNull();
    const assigned = [...update![1].matchAll(/(\w+)\s*=/g)].map((m) => m[1]);
    expect(assigned).toEqual(["preferred_name", "phone", "email"]);
    expect(body).toMatch(/c_keys constant text\[\] := array\['preferred_name', 'phone', 'email'\]/);
  });
  it("the create command inserts only name, preferred name, phone and email", () => {
    const body = fn("receptionist_create_client");
    expect(body).toMatch(/insert into public\.clients \(studio_id, name, preferred_name, phone, email\)/);
  });
  it("the no-show command mirrors the practitioner rules: confirmed only, ended only, no money or message", () => {
    const body = fn("receptionist_mark_no_show");
    expect(body).toMatch(/v_appt\.status <> 'confirmed'/);
    expect(body).toMatch(/v_appt\.ends_at > pg_catalog\.now\(\)/);
    expect(body).toMatch(/set status = 'no_show'/);
    expect(body).not.toMatch(/\b(payments?|charges?|refunds?|outbox|messages?)\b/i);
  });
  it("the audit stores field names, never a value", () => {
    expect(code).toMatch(/fields\s+text\[\] not null/);
    for (const name of ["receptionist_create_client", "receptionist_update_client_contact"]) {
      const insert = fn(name).match(/insert into public\.receptionist_client_audit \(([^)]*)\)/);
      expect(insert?.[1].replace(/\s+/g, "")).toBe("studio_id,client_id,receptionist_id,action,fields");
    }
  });
});
