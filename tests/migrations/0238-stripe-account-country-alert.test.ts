import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/0238_stripe_account_country_alert.sql"), "utf8");
const CODE = SQL.replace(/^\s*--.*$/gm, "");
const TOP = CODE.replace(/\$\$[\s\S]*?\$\$/g, "");
const SIG = "claim_stripe_account_country_alert(uuid, text, boolean)";

describe("0238 bounded Stripe country incident contract", () => {
  it("owns the new maximum and is allocated exactly once", () => {
    expect(isRepoMax("0238")).toBe(true);
    expect(countVersion("0238")).toBe(1);
    expect(fileForVersion("0238")).toBe("0238_stripe_account_country_alert.sql");
  });
  it("wraps creation in its own transaction with five-second lock timeout", () => {
    expect(CODE.trim().startsWith("begin;")).toBe(true);
    expect(CODE).toMatch(/begin;\s*set local lock_timeout = '5s';/);
    expect(CODE.trim().endsWith("commit;")).toBe(true);
  });
  it("adds one function, no table/index/trigger or apply-time data mutation", () => {
    expect(CODE.match(/create or replace function/g)).toHaveLength(1);
    expect(TOP).not.toMatch(/\b(create table|create .*index|alter table|create trigger|insert into|update public|delete from|truncate)\b/i);
    expect(CODE).not.toMatch(/function public\.record_stripe_account_jurisdiction\(/);
  });
  it("revokes every default role and grants only service_role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke execute on function public.${SIG} from ${role};`);
    }
    expect(CODE.match(/grant execute[^;]+;/g)).toEqual([`grant execute on function public.${SIG} to service_role;`]);
    expect(CODE).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
  });
  it("accepts only exact bound identifiers, never caller-supplied reason/country/payload", () => {
    const signature = CODE.slice(CODE.indexOf("(\n"), CODE.indexOf(")\nreturns"));
    expect(signature).not.toMatch(/p_(reason|country|message|safe_details|route)/);
    expect(CODE).toMatch(/s\.studio_id = p_studio_id\s+and s\.stripe_account_id = p_stripe_account_id\s+and s\.stripe_livemode = p_stripe_livemode\s+for update;/);
    expect(CODE).toContain("v_reason := 'country_conflict'");
    expect(CODE).toContain("v_reason := 'country_mismatch'");
    expect(CODE).toContain("v_settings.stripe_account_country <> v_payment_country");
  });
  it("locks jurisdiction then settings before checking/inserting the incident", () => {
    const share = CODE.indexOf("for share;");
    const lock = CODE.indexOf("for update;");
    const check = CODE.indexOf("from public.ops_alerts a");
    const insert = CODE.indexOf("insert into public.ops_alerts");
    expect(share).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(share);
    expect(check).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(check);
    expect(CODE).toContain("current_setting('transaction_isolation') <> 'read committed'");
    expect(CODE).toContain("errcode = '40001'");
  });
  it("reuses only matching unresolved studio/account/mode/reason incidents", () => {
    for (const text of ["a.studio_id = p_studio_id", "a.event = 'stripe_account_country_mismatch'",
      "a.resolved_at is null", "a.safe_details->>'stripe_account_id' = p_stripe_account_id",
      "a.safe_details->>'livemode' = p_stripe_livemode::text", "a.safe_details->>'reason' = v_reason"]) {
      expect(CODE).toContain(text);
    }
    expect(CODE.indexOf("select 'existing'::text")).toBeLessThan(CODE.indexOf("insert into public.ops_alerts"));
    expect(CODE).toContain("select 'created'::text");
  });
  it("does not rewrite country/conflict/history or send provider notifications from SQL", () => {
    expect(CODE).not.toMatch(/\b(update|delete|truncate)\s+(public\.)?\w+/i);
    expect(CODE).not.toMatch(/http_post|net\.|pg_net|vault\.|stripe_account_country\s*=/);
    expect(CODE).toContain("jsonb_build_object('stripe_account_id', p_stripe_account_id");
    expect(CODE).toContain("'recorded_account_country', v_settings.stripe_account_country");
  });
});
