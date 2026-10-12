import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0216 — STUDIO-READY-02a (#824): the receptionist membership.
// SOURCE CONTRACT.
//
// Behaviour is proved against a real database, with a real receptionist JWT,
// in tests/db/receptionist-foundation.db.test.ts. This file pins what that
// cannot see:
// - it is ADDITIVE: no existing policy, membership helper, role CHECK,
//   invitation CHECK or command is redefined or altered. Its one touch on an
//   existing table is a BEFORE trigger on practitioners that can only REFUSE
//   (an active receptionist becoming an active practitioner in the same
//   studio) and never writes;
// - every function it creates is revoked by name from exactly the roles its
//   kind requires, and the projections alone are granted to authenticated;
// - no row is written at top level;
// - the frozen applied migrations 0209 and 0210 are byte-identical.
// ===========================================================================

const VERSION = "0216";
const FILE = "0216_receptionist_membership_foundation.sql";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read(FILE);
// LINE comments first: a comment must never satisfy a code assertion.
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
// Everything OUTSIDE dollar-quoted bodies: the migration's own top-level statements.
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const flat = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

const PROJECTIONS = [
  "receptionist_calendar(uuid, timestamptz, timestamptz)",
  "receptionist_calendar_closures(uuid, timestamptz, timestamptz)",
  "receptionist_client_contacts(uuid, text, integer)",
] as const;
const LIFECYCLE = [
  "add_studio_receptionist(uuid, uuid, uuid, text, text)",
  "set_studio_receptionist_active(uuid, uuid, uuid, boolean)",
] as const;
const INTERNAL = [
  "receptionist_actor_id(uuid)",
  "studio_membership_kind_lock(uuid, uuid)",
  "studio_receptionists_membership_guard()",
  "practitioners_receptionist_membership_guard()",
] as const;

/** The body of one `create or replace function public.<fn>(` definition. */
const bodyOf = (fn: string) => {
  const start = CODE.indexOf(`create or replace function public.${fn}(`);
  expect(start, `${fn} is not defined in 0216`).toBeGreaterThan(-1);
  const open = CODE.indexOf("$$", start);
  return CODE.slice(open + 2, CODE.indexOf("$$", open + 2));
};

const revokes = (sig: string, role: string) =>
  flat(TOP_LEVEL).includes(`revoke execute on function public.${sig} from ${role};`);
const grants = (sig: string, role: string) =>
  flat(TOP_LEVEL).includes(`grant execute on function public.${sig} to ${role};`);

describe("0216 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. It reached this file from 0210's test.
    expect(isRepoMax(VERSION), "0216 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0216").toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    const begin = TOP_LEVEL.search(/\bbegin;/i);
    const timeout = TOP_LEVEL.search(/set local lock_timeout = '5s';/i);
    const commit = TOP_LEVEL.search(/\bcommit;/i);
    expect(begin).toBeGreaterThan(-1);
    expect(timeout).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(timeout);
  });
});

describe("0216 is additive: nothing existing is redefined or altered", () => {
  it("does not redefine either membership helper, so every existing policy keeps its meaning", () => {
    expect(CODE).not.toMatch(/function\s+public\.is_studio_member\s*\(/i);
    expect(CODE).not.toMatch(/function\s+public\.is_studio_owner\s*\(/i);
  });

  it("does not alter practitioners, pending_invitations or any role CHECK", () => {
    expect(TOP_LEVEL).not.toMatch(/alter\s+table\s+(if\s+exists\s+)?public\.practitioners\b/i);
    expect(TOP_LEVEL).not.toMatch(/alter\s+table\s+(if\s+exists\s+)?public\.pending_invitations\b/i);
    expect(CODE).not.toMatch(/role_check/i);
  });

  it("creates triggers only on its own table and on practitioners", () => {
    const triggers = [...TOP_LEVEL.matchAll(/create\s+trigger\s+(\w+)[\s\S]*?\bon\s+public\.(\w+)/gi)].map(
      (m) => `${m[2]}:${m[1]}`,
    );
    expect(triggers.sort()).toEqual([
      "practitioners:practitioners_receptionist_membership_guard_trg",
      "studio_receptionists:studio_receptionists_membership_guard_trg",
    ]);
  });

  it("the practitioners trigger is a BEFORE guard that can only refuse, never write", () => {
    expect(flat(TOP_LEVEL)).toContain(
      "create trigger practitioners_receptionist_membership_guard_trg before insert or update of active, user_id, studio_id on public.practitioners for each row execute function public.practitioners_receptionist_membership_guard();",
    );
    const body = bodyOf("practitioners_receptionist_membership_guard");
    expect(body).toMatch(/raise exception 'practitioner_is_active_receptionist'\s+using errcode = '23514'/);
    expect(body).toMatch(/return new;/);
    // It reads studio_receptionists and nothing else, and writes nothing.
    expect(body).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i);
    expect(body).not.toMatch(/new\.\w+\s*:=/);
  });

  it("creates policies on its own table only", () => {
    const policies = [...TOP_LEVEL.matchAll(/create\s+policy\s+"[^"]+"\s+on\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(policies).toEqual(["studio_receptionists"]);
  });

  it("re-defines no existing scheduling, booking or clinical command", () => {
    for (const fn of [
      "create_internal_appointment_v2",
      "move_or_reassign_appointment",
      "practitioner_cancel_appointment",
      "create_public_appointment",
      "admin_accept_pending_invitation",
      "link_invited_membership",
    ]) {
      expect(CODE, fn).not.toMatch(new RegExp(`function\\s+public\\.${fn}\\s*\\(`, "i"));
    }
  });

  it("writes no row at top level", () => {
    expect(TOP_LEVEL).not.toMatch(/^\s*(insert\s+into|update\s+public\.|delete\s+from)/im);
  });

  it("grants nothing to anon, and table writes to no browser role", () => {
    expect(flat(TOP_LEVEL)).not.toMatch(/grant [^;]* to anon/);
    expect(flat(TOP_LEVEL)).toContain(
      "revoke insert, update, delete, truncate on table public.studio_receptionists from authenticated;",
    );
    expect(flat(TOP_LEVEL)).toContain("grant select on table public.studio_receptionists to authenticated;");
  });
});

describe("0216 revokes every function by name, by kind", () => {
  it("projections: revoked from public, anon AND service_role, granted to authenticated only", () => {
    for (const sig of PROJECTIONS) {
      for (const role of ["public", "anon", "service_role"]) expect(revokes(sig, role), `${sig} / ${role}`).toBe(true);
      expect(grants(sig, "authenticated"), sig).toBe(true);
      expect(grants(sig, "service_role"), sig).toBe(false);
    }
  });

  it("lifecycle commands: revoked from public, anon AND authenticated, so only service_role may call them", () => {
    for (const sig of LIFECYCLE) {
      for (const role of ["public", "anon", "authenticated"]) expect(revokes(sig, role), `${sig} / ${role}`).toBe(true);
      expect(grants(sig, "authenticated"), sig).toBe(false);
      // Restated, not assumed from Supabase's default privileges (0209/0210 precedent).
      expect(grants(sig, "service_role"), sig).toBe(true);
    }
  });

  it("internal helpers and trigger guards: revoked from every role", () => {
    for (const sig of INTERNAL) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(revokes(sig, role), `${sig} / ${role}`).toBe(true);
      }
    }
  });

  it("every projection derives its actor from auth.uid() and refuses a missing one", () => {
    for (const sig of PROJECTIONS) {
      const fn = sig.slice(0, sig.indexOf("("));
      const body = bodyOf(fn);
      expect(body, fn).toMatch(/if auth\.uid\(\) is null then/);
      expect(body, fn).toMatch(/public\.receptionist_actor_id\(p_studio_id\) is null/);
      // The actor is never an argument.
      expect(body, fn).not.toMatch(/p_actor|p_receptionist_id/);
    }
  });
});

describe("the frozen applied migrations stay byte-identical", () => {
  const FROZEN: ReadonlyArray<readonly [string, string]> = [
    ["0209_public_slot_candidate_buffer_window.sql", "9fa04999b974d70d838ba27800a22338b1f08fd7977f553dec38fba034e3f877"],
    ["0210_sms_waitlist_join_acknowledgement.sql", "b1d33743235644447da41a17778e890c05c14deda6c299303cc5febdceea7157"],
  ];
  for (const [file, sha] of FROZEN) {
    it(`${file} is unchanged`, () => {
      expect(createHash("sha256").update(read(file)).digest("hex")).toBe(sha);
    });
  }
});
