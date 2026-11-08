import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax } from "./helpers/migration-state";

// 0313 — waitlist booking command. STATIC contract. Behaviour is proved against a
// real database in tests/db/waitlist-booking-command.db.test.ts and the lock
// order in tests/db/waitlist-booking-command-locks.db.test.ts.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const M = read("supabase/migrations/0313_waitlist_booking_command.sql");
const DOWN = read("supabase/rollbacks/0313_waitlist_booking_command.down.sql");
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

describe("0313 — migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0313")).toBe(true);
    expect(countVersion("0313")).toBe(1);
  });
});

describe("0313 — shape", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const e = exec(M).trim();
    expect(e).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(e.endsWith("commit;")).toBe(true);
  });

  it("every function pins its search_path", () => {
    const fns = exec(M).match(/create or replace function[\s\S]*?\$\$;/g) ?? [];
    expect(fns).toHaveLength(4);
    for (const f of fns) expect(f).toMatch(/set search_path = pg_catalog, public, pg_temp/);
  });

  it("revokes from all default grantees by name and grants service_role only", () => {
    const e = exec(M);
    const names = [
      "redeem_and_book_waitlist_invitation",
      "waitlist_invitation_booking_state",
      "record_waitlist_invitation_followup",
      "resolve_waitlist_invitation_followup",
    ];
    for (const n of names) {
      expect(e).toMatch(new RegExp(`revoke all on function public\\.${n}\\([^)]*\\) from public, anon, authenticated, service_role;`));
      expect(e).toMatch(new RegExp(`grant execute on function public\\.${n}\\([^)]*\\) to service_role;`));
    }
    expect(e).not.toMatch(/grant execute[^;]*to (anon|authenticated|public)/);
  });

  it("the follow-ups table has RLS, no policy and no grant", () => {
    const e = exec(M);
    expect(e).toMatch(/alter table public\.waitlist_invitation_followups enable row level security;/);
    expect(e).not.toMatch(/create policy/);
    expect(e).toMatch(/revoke all on public\.waitlist_invitation_followups from public, anon, authenticated, service_role;/);
    expect(e).toMatch(/constraint waitlist_invitation_followups_invitation_key unique \(invitation_id\)/);
    expect(e).toMatch(/reason\s+text not null\s+constraint waitlist_invitation_followups_reason_check/);
  });

  it("decides a refusal by 'no appointment', rolls back through one private SQLSTATE", () => {
    const e = exec(M);
    expect(e).toMatch(/if v_row\.appointment_id is null then/);
    expect(e).toMatch(/errcode = 'WA313'/);
    expect(e).toMatch(/when sqlstate 'WA313' then/);
  });

  it("takes studios, then the round, then the entry, BEFORE it redeems", () => {
    const e = exec(M);
    const iStudio = e.indexOf("from public.studios where id = p_studio_id for no key update");
    const iRound = e.indexOf("from public.studio_waitlist_admission_rounds ar");
    const iEntry = e.indexOf("from public.new_client_waitlist_entries e\n   where e.id = v_entry");
    const iRedeem = e.indexOf("redeem_new_client_waitlist_invitation_verified(p_raw_token");
    expect(iStudio).toBeGreaterThan(0);
    expect(iRound).toBeGreaterThan(iStudio);
    expect(iEntry).toBeGreaterThan(iRound);
    expect(iRedeem).toBeGreaterThan(iEntry);
  });

  it("does not redefine the 0192, 0195 or 0228 commands", () => {
    const e = exec(M);
    expect(e).not.toMatch(/create or replace function public\.(redeem_new_client_waitlist_invitation_verified|create_waitlist_public_appointment|create_public_appointment_for_new_client)\(/);
  });
});

describe("0313 — held rollback", () => {
  it("refuses while follow-up rows exist, then drops the objects", () => {
    expect(DOWN).toMatch(/errcode = '55000'/);
    expect(DOWN).toMatch(/drop table if exists public\.waitlist_invitation_followups;/);
    expect(DOWN).toMatch(/not a migration|NOT a migration/);
  });
});
