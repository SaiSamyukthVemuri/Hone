import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source/structural contract for migration 0141 (invitation reconciliation +
// one authoritative consent). Complements the behavioural DB suite
// (tests/db/invitation-reconciliation.db.test.ts).

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");
const FILES = readdirSync(MIGRATIONS_DIR);
const FILE = FILES.find((f) => f.startsWith("0141_"));
const SQL = FILE ? readFileSync(join(MIGRATIONS_DIR, FILE), "utf8") : "";
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

function fnBlock(name: string): string {
  return (
    CODE.match(
      new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\$\\$;`, "i"),
    )?.[0] ?? ""
  );
}

describe("0141 — file present + single transaction", () => {
  it("exists with a purpose-encoding filename", () => {
    expect(FILE).toBe("0141_onboarding_invitation_reconciliation.sql");
    expect(SQL.length).toBeGreaterThan(2000);
  });
  it("installs as ONE transaction", () => {
    expect(CODE).toMatch(/^\s*begin;/im);
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
  });
});

describe("0141 — Defect 2: handle_new_user no longer fabricates consent", () => {
  it("handle_new_user is a NO-OP: no membership insert, no acceptance stamp", () => {
    const h = fnBlock("handle_new_user\\(\\)");
    expect(h).toBeTruthy();
    expect(h).not.toMatch(/insert into public\.practitioners/i);
    expect(h).not.toMatch(/terms_accepted_at/i);
    expect(h).not.toMatch(/current_terms_version/i);
    expect(h).toMatch(/return new;/i);
  });
});

describe("0141 — Defect 1: acceptance command is service-role only", () => {
  it("admin_accept_pending_invitation(uuid) is SECURITY DEFINER + pinned path", () => {
    const a = fnBlock("admin_accept_pending_invitation\\(p_user_id uuid\\)");
    expect(a).toMatch(/security definer/i);
    expect(a).toMatch(/set search_path = pg_catalog, pg_temp/i);
    // Derives the verified email from the passed user id; no caller email/etc.
    expect(a).toMatch(/select email into v_email from auth\.users where id = p_user_id/i);
  });
  it("is REVOKED from public/anon/authenticated and GRANTED to service_role", () => {
    // Named in the service-role-only revoke/grant loop.
    expect(CODE).toContain("public.admin_accept_pending_invitation(uuid)");
    expect(CODE).toMatch(/revoke execute on function %s from authenticated/i);
    expect(CODE).toMatch(/revoke execute on function %s from anon/i);
    expect(CODE).toMatch(/revoke execute on function %s from public/i);
    expect(CODE).toMatch(/grant execute on function %s to service_role/i);
  });
  it("there is NO authenticated-callable accept_my_pending_invitation", () => {
    expect(CODE).not.toMatch(/grant execute on function public\.accept_my_pending_invitation/i);
  });
});

describe("0141 — reconcile stays authenticated + self-scoped", () => {
  it("reconcile + my_pending_invitation are SECURITY DEFINER, granted to authenticated only", () => {
    for (const fn of ["reconcile_my_pending_invitation\\(\\)", "my_pending_invitation\\(\\)"]) {
      const b = fnBlock(fn);
      expect(b).toMatch(/security definer/i);
      expect(b).toMatch(/auth\.uid\(\)/);
    }
    expect(CODE).toMatch(/grant execute on function %s to authenticated/i);
    expect(CODE).toMatch(/revoke execute on function %s from anon/i);
  });
});

describe("0141 — no fabricated consent (evidence rules)", () => {
  it("reconcile copies a SINGLE current-version row's evidence, never now()", () => {
    const r = fnBlock("reconcile_my_pending_invitation\\(\\)");
    expect(r).toMatch(/terms_version = public\.current_terms_version\(\)/i);
    expect(r).toMatch(/privacy_version = public\.current_privacy_version\(\)/i);
    expect(r).toMatch(/v_ev\.terms_accepted_at/);
    // same-user INACTIVE target -> acceptance_required (not an auto-link).
    expect(r).toMatch(/v_same\.active[\s\S]*?acceptance_required/i);
  });
  it("admin_accept stamps the ACTUAL transaction time + current versions", () => {
    const a = fnBlock("admin_accept_pending_invitation\\(p_user_id uuid\\)");
    expect(a).toMatch(/v_now timestamptz := now\(\)/i);
    expect(a).toMatch(/v_now, public\.current_terms_version\(\)/);
    expect(a).toMatch(/v_now, public\.current_privacy_version\(\)/);
  });
});

describe("0141 — Defect 3: linker reactivates in place (UPDATE, never dup INSERT)", () => {
  it("link_invited_membership UPDATEs a same-user row, else INSERTs", () => {
    const l = fnBlock("link_invited_membership\\(");
    expect(l).toMatch(/where studio_id = p_invite\.studio_id and user_id = p_uid/i);
    expect(l).toMatch(/if found then[\s\S]*?update public\.practitioners set/i);
    expect(l).toMatch(/else[\s\S]*?insert into public\.practitioners/i);
    expect(l).toMatch(/active\s*=\s*true/i);
  });
  it("never overwrites another user's membership (conflict guard)", () => {
    const r = fnBlock("reconcile_my_pending_invitation\\(\\)");
    expect(r).toMatch(/user_id is distinct from v_uid[\s\S]*?conflict/i);
  });
});

describe("0141 — concurrency + authorization posture", () => {
  it("serializes per-email with an advisory xact lock + FOR UPDATE", () => {
    for (const fn of ["reconcile_my_pending_invitation\\(\\)", "admin_accept_pending_invitation\\(p_user_id uuid\\)"]) {
      const b = fnBlock(fn);
      expect(b).toMatch(/pg_advisory_xact_lock\(hashtext\('hone:invite:'/i);
      expect(b).toMatch(/for update/i);
    }
  });
  it("internal helpers + version fns are execute-locked from all browser roles", () => {
    expect(CODE).toContain("public.link_invited_membership(");
    expect(CODE).toContain("public.current_terms_version()");
    expect(CODE).toMatch(/revoke execute on function %s from authenticated/i);
  });
});

describe("0141 — Defect 4d: welcome-email single-attempt claim", () => {
  it("claim_welcome_email_attempt is an atomic conditional upsert, service-role only", () => {
    const c = fnBlock("claim_welcome_email_attempt\\(p_studio_id uuid\\)");
    expect(c).toMatch(/security definer/i);
    // Atomic claim: insert ... on conflict do update ... where <recent guard>.
    expect(c).toMatch(/insert into public\.studio_onboarding[\s\S]*?on conflict \(studio_id\) do update/i);
    expect(c).toMatch(/welcome_email_last_sent_at < now\(\) - interval '10 seconds'/i);
    // Browser roles cannot call it.
    expect(CODE).toMatch(/revoke execute on function %s from authenticated/i);
    expect(CODE).toMatch(/grant execute on function %s to service_role/i);
    expect(CODE).toContain("public.claim_welcome_email_attempt(uuid)");
  });
});
