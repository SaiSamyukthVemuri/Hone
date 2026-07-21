import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source/structural contract for migration 0141 (existing-user invitation
// reconciliation). Complements the behavioural DB suite
// (tests/db/invitation-reconciliation.db.test.ts) by pinning the self-scoped,
// no-fabricated-consent, and authorization properties in the SQL itself.

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

describe("0141 — centralized policy versions + trigger uses them", () => {
  it("defines IMMUTABLE current_terms_version / current_privacy_version", () => {
    expect(fnBlock("current_terms_version\\(\\)")).toMatch(/immutable/i);
    expect(fnBlock("current_privacy_version\\(\\)")).toMatch(/immutable/i);
  });
  it("handle_new_user stamps via the version source, NOT a re-inlined literal", () => {
    const h = fnBlock("handle_new_user\\(\\)");
    expect(h).toMatch(/public\.current_terms_version\(\)/);
    expect(h).toMatch(/public\.current_privacy_version\(\)/);
    // The old hardcoded acceptance_version literal is gone from the trigger.
    expect(h).not.toMatch(/acceptance_version text := '2026-05-22'/);
  });
});

describe("0141 — RPCs are self-scoped SECURITY DEFINER with pinned search_path", () => {
  for (const fn of [
    "reconcile_my_pending_invitation\\(\\)",
    "accept_my_pending_invitation\\(\\)",
    "my_pending_invitation\\(\\)",
  ]) {
    it(`${fn} is SECURITY DEFINER + pinned search_path + derives auth.uid()`, () => {
      const b = fnBlock(fn);
      expect(b).toMatch(/security definer/i);
      expect(b).toMatch(/set search_path = pg_catalog, pg_temp/i);
      expect(b).toMatch(/auth\.uid\(\)/);
      // Reads the verified email from auth.users (never a caller argument).
      if (!fn.startsWith("my_pending")) {
        expect(b).toMatch(/from auth\.users where id = v_uid/i);
      }
    });
  }

  it("the mutating RPCs take NO caller identity arguments", () => {
    // reconcile/accept are argument-less; identity is internal only.
    expect(CODE).toMatch(/function public\.reconcile_my_pending_invitation\(\)/);
    expect(CODE).toMatch(/function public\.accept_my_pending_invitation\(\)/);
  });
});

describe("0141 — no fabricated consent (evidence rules)", () => {
  it("reconcile copies a SINGLE current-version row's evidence, never now()", () => {
    const r = fnBlock("reconcile_my_pending_invitation\\(\\)");
    // Evidence filter requires BOTH terms and privacy at the CURRENT version,
    // both non-null, from ONE row.
    expect(r).toMatch(/terms_accepted_at is not null/i);
    expect(r).toMatch(/terms_version = public\.current_terms_version\(\)/i);
    expect(r).toMatch(/privacy_accepted_at is not null/i);
    expect(r).toMatch(/privacy_version = public\.current_privacy_version\(\)/i);
    // The automatic path must NOT stamp now() — it passes copied v_ev.* values.
    expect(r).toMatch(/v_ev\.terms_accepted_at/);
    expect(r).not.toMatch(/now\(\)[^;]*terms_accepted_at/i);
  });
  it("no valid evidence -> acceptance_required, inserts nothing", () => {
    const r = fnBlock("reconcile_my_pending_invitation\\(\\)");
    expect(r).toMatch(/if not found then[\s\S]*acceptance_required/i);
  });
  it("accept stamps the ACTUAL transaction time + current versions", () => {
    const a = fnBlock("accept_my_pending_invitation\\(\\)");
    expect(a).toMatch(/v_now timestamptz := now\(\)/i);
    expect(a).toMatch(/v_now, public\.current_terms_version\(\)/);
    expect(a).toMatch(/v_now, public\.current_privacy_version\(\)/);
  });
});

describe("0141 — safety: conflict, concurrency, consumption-vs-legal time", () => {
  it("never overwrites another user's membership (conflict)", () => {
    const r = fnBlock("reconcile_my_pending_invitation\\(\\)");
    expect(r).toMatch(/user_id is distinct from v_uid[\s\S]*conflict/i);
  });
  it("serializes per-email with an advisory xact lock + FOR UPDATE", () => {
    const r = fnBlock("reconcile_my_pending_invitation\\(\\)");
    expect(r).toMatch(/pg_advisory_xact_lock\(hashtext\('hone:invite:'/i);
    expect(r).toMatch(/for update/i);
  });
  it("accepted_at is consumption time (now), distinct from legal terms time", () => {
    const l = fnBlock("link_invited_membership\\(");
    expect(l).toMatch(/set status = 'accepted', accepted_at = now\(\)/i);
    // The practitioner insert uses the passed evidence params, not now().
    expect(l).toMatch(/p_terms_accepted_at, p_terms_version/);
  });
  it("initializes onboarding state idempotently", () => {
    const l = fnBlock("link_invited_membership\\(");
    expect(l).toMatch(/insert into public\.studio_onboarding[\s\S]*on conflict \(studio_id\) do nothing/i);
  });
});

describe("0141 — authorization grants", () => {
  it("self-service RPCs: revoke public+anon, grant authenticated", () => {
    for (const fn of [
      "public.reconcile_my_pending_invitation()",
      "public.accept_my_pending_invitation()",
      "public.my_pending_invitation()",
    ]) {
      expect(CODE).toContain(fn);
    }
    expect(CODE).toMatch(/grant execute on function %s to authenticated/i);
    expect(CODE).toMatch(/revoke execute on function %s from anon/i);
    expect(CODE).toMatch(/revoke execute on function %s from public/i);
  });
  it("internal helpers are execute-locked from every browser role", () => {
    expect(CODE).toContain("public.link_invited_membership(");
    expect(CODE).toContain("public.current_terms_version()");
    expect(CODE).toContain("public.current_privacy_version()");
    // The internal loop revokes from authenticated too (not just public/anon).
    expect(CODE).toMatch(/revoke execute on function %s from authenticated/i);
  });
});
