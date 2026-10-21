import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0249_session_payment_claim_admission_fence.sql", "utf8");
const predecessor = readFileSync("supabase/migrations/0187_appointment_settlement.sql", "utf8");
const withoutComments = (text: string) => text.replace(/^\s*--.*$/gm, "");
const normalize = (text: string) => withoutComments(text).replace(/\s+/g, " ").trim();
const functionOf = (text: string) => {
  const start = text.indexOf("create or replace function public.claim_session_payment_charge_attempt(");
  const end = text.indexOf("$$;", text.indexOf("as $$", start)) + 3;
  return text.slice(start, end);
};
const fn = functionOf(sql);
const prior = functionOf(predecessor);
const body = (text: string) => text.slice(text.indexOf("as $$") + 5, text.lastIndexOf("$$;"));
const code = withoutComments(sql);
const pending = body(fn).slice(body(fn).indexOf("if v_row.status = 'pending_stripe' then"), body(fn).indexOf("-- Any other non-'ready'"));

describe("0249 existing claim RPC protocol-admission fence", () => {
  it("owns the actual maximum and exactly one allocated SQL file", () => {
    expect(isRepoMax("0249")).toBe(true);
    expect(countVersion("0249")).toBe(1);
    expect(fileForVersion("0249")).toBe("0249_session_payment_claim_admission_fence.sql");
    expect(code.trim()).toMatch(/^begin;/);
    expect(code.trim()).toMatch(/commit;$/);
    expect(code).toContain("set local lock_timeout = '5s'");
  });
  it("preserves EXACT existing arguments, tuple (no mode field), language and security path", () => {
    expect(fn.slice(0, fn.indexOf("as $$"))).toBe(prior.slice(0, prior.indexOf("as $$")));
    expect(fn.slice(0, fn.indexOf("as $$"))).not.toContain("stripe_livemode");
    expect(fn).toContain("language plpgsql security definer\nset search_path = pg_catalog, pg_temp");
  });
  it("returns recognized not_ready for pending/no original before known-ID recovery, without DML", () => {
    expect(pending).toMatch(/if nullif\(v_row\.stripe_payment_intent_id, ''\) is null then[\s\S]*?select 'not_ready'::text[\s\S]*?return;\s*end if;[\s\S]*?select 'already_pending'::text/);
    expect(withoutComments(pending)).not.toMatch(/\b(update|insert|delete)\b/i);
    expect(code).not.toContain("protocol_mismatch");
  });
  it("admits ONLY the exact locked-row v2 key on fresh ready/null original/key/money facts", () => {
    expect(fn).toContain("or p_idempotency_key is distinct from\n       ('hone:' || v_row.charge_reason || ':' || v_row.id::text || ':v2:create')");
    for (const field of ["stripe_payment_intent_id", "stripe_idempotency_key", "stripe_charge_id", "charged_at"]) {
      expect(fn).toContain(`v_row.${field} is not null`);
    }
    expect(fn.indexOf("if v_row.status <> 'ready' then")).toBeLessThan(fn.indexOf("or p_idempotency_key is distinct from"));
    expect(fn.indexOf("or p_idempotency_key is distinct from")).toBeLessThan(fn.indexOf("update public.payment_charge_attempts"));
    expect(fn).not.toMatch(/p_idempotency_key\s+(?:like|~)/i);
  });
  it("inverse-removing exactly the two guards yields the entire reviewed0187 function body", () => {
    const restored = body(fn)
      .replace(/(if v_row.status = 'pending_stripe' then)\s*(?:--[^\n]*\n\s*)*if nullif\(v_row\.stripe_payment_intent_id, ''\) is null then[\s\S]*?end if;/, "$1")
      .replace(/if v_row\.stripe_payment_intent_id is not null\s+or v_row\.stripe_idempotency_key is not null\s+or v_row\.stripe_charge_id is not null\s+or v_row\.charged_at is not null\s+or p_idempotency_key is distinct from\s+\('hone:' \|\| v_row\.charge_reason \|\| ':' \|\| v_row\.id::text \|\| ':v2:create'\) then/, "if v_row.stripe_payment_intent_id is not null then");
    expect(normalize(restored)).toBe(normalize(body(prior)));
  });
  it("keeps advisory-before-row locks, auth/settlement/terminal outcomes and only the original UPDATE", () => {
    expect(fn.indexOf("pg_advisory_xact_lock")).toBeLessThan(fn.indexOf("for update;"));
    for (const token of ["pr.active = true", "pr.studio_id = v_row.studio_id", "appointment_has_blocking_settlement", "'settled_externally'", "'not_authorized'", "'already_succeeded'"]) expect(fn).toContain(token);
    expect(withoutComments(fn).match(/\bupdate public.payment_charge_attempts\b/g)).toHaveLength(1);
    expect(fn).toContain("stripe_idempotency_key = p_idempotency_key");
    expect(fn).toContain("and status = 'ready'");
  });
  it("preserves existing owner and service-only ACL with full named revokes/effective checks", () => {
    const signature = "public.claim_session_payment_charge_attempt(uuid, uuid, text)";
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toContain(`revoke all privileges on function ${signature} from ${role};`);
    }
    expect(code.match(/\bgrant execute on function/g)).toHaveLength(1);
    expect(code).toContain(`grant execute on function ${signature} to service_role;`);
    expect(code).toContain("pg_catalog.pg_get_userbyid(p.proowner) is distinct from 'postgres'");
    for (const role of ["anon", "authenticated", "service_role"]) expect(code).toContain(`pg_catalog.has_function_privilege('${role}', v_function, 'EXECUTE')`);
    expect(code).toContain("a.grantee not in (p.proowner, 'service_role'::regrole::oid)");
    expect(code).toContain("or a.privilege_type <> 'EXECUTE' or a.is_grantable");
  });
  it("touches only the existing claim function/ACL; no top-level row changes, adjacent RPC or schema expansion", () => {
    const outside = code.replace(withoutComments(fn), "");
    expect(code.match(/create or replace function/g)).toHaveLength(1);
    expect(outside).not.toMatch(/\b(insert|update|delete|alter|truncate|drop)\b/i);
    expect(code).not.toMatch(/create (?:table|trigger|policy|index)|grant .* to (?:anon|authenticated|public)\b/i);
    for (const name of ["reconcile_bound_payment_event", "claim_payment_refund", "complete_saved_card_setup"]) expect(code).not.toContain(`function public.${name}`);
  });
});
