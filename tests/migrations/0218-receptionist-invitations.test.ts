import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0218 — STUDIO-READY-02b (#824): inviting a receptionist. SOURCE
// CONTRACT. Behaviour is proved in tests/db/receptionist-invitation.db.test.ts.
// This pins what that cannot see:
//   * the linker's practitioner path is BYTE-IDENTICAL to 0141's body;
//   * neither acceptance caller is re-emitted;
//   * the role CHECK only widens, and the new columns are additive;
//   * the linker's privileges are restated (service_role only);
//   * no row is written at top level.
// ===========================================================================

const VERSION = "0218";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read("0218_receptionist_invitations.sql");
const R0141 = read("0141_onboarding_invitation_reconciliation.sql");
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The body of `public.<fn>` between its first $$ pair. */
function bodyOf(sql: string, fn: string): string {
  const start = sql.indexOf(`create or replace function public.${fn}(`);
  expect(start, `${fn} not defined`).toBeGreaterThan(-1);
  const open = sql.indexOf("$$", start);
  return sql.slice(open + 2, sql.indexOf("$$", open + 2));
}

describe("0218 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this (CLAUDE.md §2).
    expect(isRepoMax(VERSION), "0218 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(TOP_LEVEL.trim()).toMatch(/^begin;\s+set local lock_timeout = '5s';/);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/);
  });
});

describe("0218 changes only what it says", () => {
  it("the linker's practitioner path is byte-identical to 0141", () => {
    const next = bodyOf(SQL, "link_invited_membership");
    const prev = bodyOf(R0141, "link_invited_membership");
    // Everything from 0141's own first statement onward must reappear verbatim
    // after the receptionist branch.
    const anchor = "  -- The caller's own row in the target studio (any active state).";
    const tailPrev = prev.slice(prev.indexOf(anchor));
    const tailNext = next.slice(next.indexOf(anchor));
    expect(prev.indexOf(anchor)).toBeGreaterThan(-1);
    expect(tailNext).toBe(tailPrev);
  });

  it("the receptionist branch writes studio_receptionists, never practitioners, and returns before the practitioner path", () => {
    const body = bodyOf(SQL, "link_invited_membership");
    const branch = body.slice(body.indexOf("if p_invite.role = 'receptionist' then"), body.indexOf("  -- The caller's own row"));
    expect(branch).toMatch(/insert into public\.studio_receptionists/);
    expect(branch).toMatch(/update public\.studio_receptionists set/);
    expect(branch).not.toMatch(/public\.practitioners/);
    expect(branch).toMatch(/return jsonb_build_object\(/);
    // Lock order as in 0216: the membership-kind lock before the row lock.
    expect(branch.indexOf("studio_membership_kind_lock")).toBeLessThan(branch.indexOf("for update"));
  });

  it("re-emits NEITHER acceptance caller", () => {
    for (const fn of ["reconcile_my_pending_invitation", "admin_accept_pending_invitation", "my_pending_invitation"]) {
      expect(CODE, fn).not.toMatch(new RegExp(`function\\s+public\\.${fn}\\s*\\(`, "i"));
    }
  });

  it("the role CHECK only widens: the old roles plus receptionist", () => {
    expect(flat(TOP_LEVEL)).toContain(
      "add constraint pending_invitations_role_check check (role in ('owner', 'practitioner', 'receptionist'));",
    );
    expect(flat(R0141 + read("0007_pending_invitations.sql"))).toMatch(/role in \('owner', ?'practitioner'\)/);
  });

  it("adds the four agreement columns and alters nothing else on any table", () => {
    const alters = [...TOP_LEVEL.matchAll(/alter table\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect([...new Set(alters)].sort()).toEqual(["pending_invitations", "studio_receptionists"]);
    for (const c of ["terms_accepted_at", "terms_version", "privacy_accepted_at", "privacy_version"]) {
      expect(flat(TOP_LEVEL)).toContain(`add column if not exists ${c}`);
    }
    expect(TOP_LEVEL).not.toMatch(/drop column|alter column/i);
  });

  it("enforces one ACTIVE front-desk row per studio and email with a partial unique index (Codex P2 4244037190)", () => {
    expect(flat(TOP_LEVEL)).toContain(
      "create unique index if not exists studio_receptionists_active_email_uniq on public.studio_receptionists (studio_id, lower(email)) where active and email is not null;",
    );
  });

  it("writes no row at top level", () => {
    expect(TOP_LEVEL).not.toMatch(/^\s*(insert\s+into|update\s+public\.|delete\s+from)/im);
  });

  it("restates the linker's privileges: revoked by name from public, anon and authenticated; granted to service_role", () => {
    const sig = "link_invited_membership(uuid, text, public.pending_invitations, text, timestamptz, text, timestamptz, text)";
    for (const role of ["public", "anon", "authenticated"]) {
      expect(flat(TOP_LEVEL), role).toContain(`revoke execute on function public.${sig} from ${role};`);
    }
    expect(flat(TOP_LEVEL)).toContain(`grant execute on function public.${sig} to service_role;`);
  });
});
