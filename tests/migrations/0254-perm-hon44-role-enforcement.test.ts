import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0254_perm_hon44_role_enforcement.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const chain0167 = readFileSync("supabase/migrations/0167_session_write_commands.sql", "utf8");
const chain0187 = readFileSync("supabase/migrations/0187_appointment_settlement.sql", "utf8");

function fn(source: string, name: string): string {
  const i = source.indexOf(`create or replace function public.${name}(`);
  expect(i, name).toBeGreaterThan(-1);
  return source.slice(i, source.indexOf("\n$$;", i) + 4);
}

describe("0254 PERM-HON44 role enforcement: shape and boundaries", () => {
  it("uses its reserved filename once, in one bounded transaction", () => {
    expect(countVersion("0254")).toBe(1);
    expect(fileForVersion("0254")).toBe("0254_perm_hon44_role_enforcement.sql");
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code.trim()).toMatch(/commit;$/);
  });

  it("the two replaced commands are the chain's own text plus ONLY the owner check (and the price audit)", () => {
    const strip = (t: string) =>
      t
        .replace(/^\s*--.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
    // settlement: removing the added block must reproduce 0187 byte for byte (modulo whitespace)
    const settlement = fn(code, "record_appointment_settlement");
    const addedOwner = /if not public\.is_studio_owner\(p_studio_id\) then\s*return query select 'owner_only'::text, null::uuid, null::timestamptz;\s*return;\s*end if;/;
    expect(settlement).toMatch(addedOwner);
    expect(strip(settlement.replace(addedOwner, ""))).toBe(strip(fn(chain0187, "record_appointment_settlement")));
    // session price: the owner check and the audit are the only additions
    const price = fn(code, "set_session_price");
    expect(price).toMatch(/if not public\.is_studio_owner\(v_studio_id\) then\s*raise exception 'Only the studio owner can change prices\.' using errcode = 'insufficient_privilege';/);
    expect(price).toContain("insert into public.audit_logs");
    expect(strip(fn(chain0167, "set_session_price"))).toContain(strip("v_studio_id := public.assert_session_writable(p_session_id, p_client_id);"));
  });

  it("the price audit carries no amount", () => {
    const price = fn(code, "set_session_price");
    const audit = price.slice(price.indexOf("insert into public.audit_logs"));
    expect(audit).toMatch(/'cleared', p_price_cents is null/);
    expect(audit).toMatch(/'changed', v_before is distinct from p_price_cents/);
    expect(audit).not.toMatch(/'(price|amount|before|after|from|to)'/);
  });

  it("every new definer function pins search_path and is revoked by name from all four roles", () => {
    for (const name of ["edit_client_pinned_note", "audit_pinned_note_delete", "audit_client_pricing_change"]) {
      const start = code.indexOf(`create function public.${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const body = code.slice(start, code.indexOf("$$;", code.indexOf("$$", start) + 2) + 3);
      expect(body, name).toMatch(/security definer\s+set search_path = ''/);
      expect(code, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\)\\s+from public, anon, authenticated, service_role;`));
    }
    expect(code).toMatch(/grant execute on function public\.edit_client_pinned_note\(uuid, uuid, uuid, text, text\) to authenticated;/);
    expect(code).not.toMatch(/grant execute on function public\.audit_/);
  });

  it("changes no table grants, creates no table, and leaves the services price list and the platform alone", () => {
    expect(code).not.toMatch(/\b(grant|revoke)\s+(select|insert|update|delete|all)[^;]*\bon\s+(table\s+)?public\./i);
    expect(code).not.toMatch(/create\s+table|alter\s+table|drop\s+table/i);
    expect(code).not.toMatch(/public\.services|rls_auto_enable|btree_gist/);
  });

  it("replaces the member-wide policies by name, with owner-only ones, and asserts the end state by catalog", () => {
    for (const name of [
      "payment_charge_attempts_member_read",
      "manual_fee_charge_attempts_member_read",
      "appointment_settlements_member_select",
      "client_pricing: members insert",
      "client_pricing: members update",
      "client_pricing: members delete",
      "client_pinned_notes_studio_member_delete",
    ]) {
      expect(code, name).toContain(`drop policy if exists "${name}"`);
    }
    expect(code).toContain("can read for a non-owner");
    expect(code).toContain("is not owner-gated");
    expect(code).toContain("unexpected EXECUTE privileges");
  });
});
