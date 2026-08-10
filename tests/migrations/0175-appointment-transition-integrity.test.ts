import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0175 — B6 appointment transition integrity. STATIC contract.
//
// Behaviour is proved against a real migrated database in
// tests/db/appointment-transition-integrity.db.test.ts. This file pins the
// things a behavioural test cannot see: what the migration is ALLOWED to
// contain, and what it must never emit.

const FILE = "supabase/migrations/0175_appointment_transition_integrity.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

// EXECUTABLE SQL ONLY — line comments stripped.
//
// The migration's header deliberately NAMES what it does not touch
// (snapshot_appointment_buffer, no-show, the dormant charge-attempt RPC, B7's
// public cancellation, B8's postcare grant) so a reader knows those omissions
// are decisions rather than oversights. A scope assertion run against the raw
// text would therefore fail on the very prose that documents the discipline —
// and, worse, a test that cannot tell a comment from a statement would also
// miss a real violation sitting inside one.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0175 — migration state", () => {
  it("is no longer the repository maximum — B7 spent 0176 above it", () => {
    // Per CLAUDE.md only the CURRENT max may assert isRepoMax; that role passed
    // to 0176 when B7 landed. 0175 keeps the narrower claim that is still true.
    expect(isRepoMax("0175")).toBe(false);
    expect(countVersion("0175")).toBe(1);
  });

  it("consumes exactly ONE number — B7 took 0176, 0177 still reserved for B8", () => {
    expect(countVersion("0176")).toBe(1);
    expect(countVersion("0177")).toBe(0);
  });
});

describe("0175 — transaction envelope", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    // `supabase db push` does not wrap a migration file in a transaction, so a
    // bare SET LOCAL emits 25P01 and never arms.
    const lines = SQL.split("\n").map((l) => l.trim()).filter(Boolean);
    const b = lines.findIndex((l) => l === "begin;");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(lines[b + 1]).toBe("set local lock_timeout = '5s';");
    expect(lines[lines.length - 1]).toBe("commit;");
  });

  it("sets no statement_timeout", () => {
    expect(SQL).not.toMatch(/statement_timeout/);
  });
});

describe("0175 — STANDING PROHIBITION: snapshot_appointment_buffer is untouched", () => {
  it("never creates, replaces or drops it", () => {
    // Production carries out-of-band GUC behaviour in that function which is
    // not fully represented in this repository's migration source, so
    // re-emitting it from repo source could DELETE live production behaviour.
    expect(EXEC).not.toMatch(/function\s+public\.snapshot_appointment_buffer/i);
    expect(EXEC).not.toMatch(/create\s+or\s+replace\s+function[\s\S]{0,80}snapshot_appointment_buffer/i);
    expect(EXEC).not.toMatch(/drop\s+function[\s\S]{0,80}snapshot_appointment_buffer/i);
  });
});

describe("0175 — A: completion boundary moved to starts_at", () => {
  const fn =
    SQL.match(/create or replace function public\.mark_appointment_complete[\s\S]*?\n\$\$;/)?.[0] ?? "";

  it("redefines the exact existing signature", () => {
    expect(fn).not.toBe("");
    expect(fn).toMatch(/p_appointment_id\s+uuid/);
    expect(fn).toMatch(/p_studio_id\s+uuid/);
    expect(fn).toMatch(/p_practitioner_id\s+uuid/);
    expect(fn).toMatch(/returns void/);
  });

  it("refuses on starts_at, not ends_at — and the boundary is inclusive", () => {
    // `starts_at > now()` refuses, so exactly starts_at is allowed. A `>=`
    // here would silently make the boundary exclusive.
    expect(fn).toMatch(/v_starts_at\s*>\s*now\(\)/);
    expect(fn).not.toMatch(/v_ends_at/);
    expect(fn).not.toMatch(/ends_at\s*>\s*now\(\)/);
  });

  it("keeps the marked_complete audit action revert_appointment_outcome depends on", () => {
    expect(fn).toMatch(/'marked_complete'/);
  });

  it("writes NO interval, buffer or reservation column", () => {
    // Completing early must not shorten the booking. The UPDATE touches
    // status and updated_at only.
    const upd = fn.match(/update public\.appointments[\s\S]*?;/)?.[0] ?? "";
    expect(upd).toMatch(/set status = 'completed', updated_at = now\(\)/);
    for (const col of [
      "starts_at",
      "ends_at",
      "duration_minutes",
      "buffer_minutes_snapshot",
      "blocked_ends_at",
    ]) {
      expect(upd, `must not write ${col}`).not.toContain(col);
    }
  });

  it("keeps its EXECUTE posture: service_role only", () => {
    expect(SQL).toMatch(/revoke execute on function public\.mark_appointment_complete\(uuid, uuid, uuid\)\s*\n\s*from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function public\.mark_appointment_complete\(uuid, uuid, uuid\)\s*\n\s*to service_role;/);
  });

  it("does NOT touch no-show — that clock does not move", () => {
    expect(EXEC).not.toMatch(/mark_appointment_no_show/);
  });
});

describe("0175 — B: transition guard is structural only", () => {
  const trg =
    SQL.match(/create or replace function public\.enforce_appointment_transition[\s\S]*?\n\$\$;/)?.[0] ?? "";
  const pred =
    SQL.match(/create or replace function public\.appointment_transition_allowed[\s\S]*?\n\$\$;/)?.[0] ?? "";

  it("fires BEFORE UPDATE OF status, so inserts are unaffected", () => {
    expect(SQL).toMatch(/before update of status on public\.appointments/);
  });

  it("allows exactly the six legal edges and nothing else", () => {
    expect(pred).not.toBe("");
    for (const edge of [
      "('confirmed', 'completed')",
      "('confirmed', 'cancelled')",
      "('confirmed', 'no_show')",
      "('completed', 'confirmed')",
      "('cancelled', 'confirmed')",
      "('no_show',   'confirmed')",
    ]) {
      expect(pred).toContain(edge);
    }
    // Six pairs, no more.
    expect((pred.match(/\('/g) ?? []).length).toBe(6);
  });

  it("writes NO appointment_audit row and derives no actor", () => {
    // Commands remain the sole semantic authority and audit writer. A trigger
    // that invented events would attribute an action to whoever held the
    // connection.
    expect(trg).not.toMatch(/appointment_audit/);
    expect(trg).not.toMatch(/actor/);
  });

  it("has no bypass GUC and no service_role special case", () => {
    expect(trg).not.toMatch(/current_setting/);
    expect(trg).not.toMatch(/service_role/);
    expect(trg).not.toMatch(/session_user|current_user/);
  });
});

describe("0175 — C: updated_at uses the established helper", () => {
  it("attaches public.set_updated_at() rather than inventing a framework", () => {
    expect(SQL).toMatch(/create trigger appointments_set_updated_at_trg\s*\n\s*before update on public\.appointments/);
    expect(SQL).toMatch(/execute function public\.set_updated_at\(\);/);
  });

  it("drops any prior trigger of that name first, so there is exactly one", () => {
    expect(SQL).toMatch(/drop trigger if exists appointments_set_updated_at_trg on public\.appointments;/);
  });
});

describe("0175 — D: capacity_enabled stops following lifecycle", () => {
  it("re-creates the trigger WITHOUT status in its UPDATE OF list", () => {
    const t = SQL.match(/create trigger appointments_set_capacity_enabled_trg[\s\S]*?;/)?.[0] ?? "";
    expect(t).toMatch(/before insert or update of studio_id, practitioner_id\s*\n\s*on public\.appointments/);
    expect(t).not.toMatch(/status/);
  });

  it("does NOT redefine set_appointment_capacity_enabled() — the function was correct", () => {
    // It was being called at the wrong times, not computing the wrong thing.
    expect(EXEC).not.toMatch(/create or replace function public\.set_appointment_capacity_enabled/);
  });
});

describe("0175 — E: three legacy RPCs dropped by EXACT signature", () => {
  it("drops each with its full argument list, never by bare name", () => {
    expect(SQL).toMatch(
      /drop function if exists public\.reschedule_appointment\(\s*uuid, text, timestamptz, timestamptz, integer, text\s*\);/,
    );
    expect(SQL).toMatch(
      /drop function if exists public\.practitioner_move_appointment\(\s*uuid, uuid, uuid, timestamptz, timestamptz, timestamptz\s*\);/,
    );
    expect(SQL).toMatch(
      /drop function if exists public\.create_internal_appointment\(\s*uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text\s*\);/,
    );
  });

  it("never uses an ambiguous name-only drop", () => {
    // A bare `drop function foo` is ambiguous under overloading and would take
    // whatever happens to be installed.
    const drops = EXEC.match(/drop function[^;]*;/g) ?? [];
    expect(drops.length).toBe(3);
    for (const d of drops) expect(d).toMatch(/\(/);
  });

  it("does NOT drop the successors it retires in favour of", () => {
    for (const keep of [
      "reschedule_appointment_v2",
      "move_or_reassign_appointment",
      "create_internal_appointment_v2",
    ]) {
      expect(EXEC).not.toMatch(new RegExp(`drop function[^;]*${keep}`));
    }
  });
});

describe("0175 — scope discipline: nothing from B7, B8 or payments", () => {
  it("executes nothing against any charge-attempt function", () => {
    // create_or_claim_charge_attempt is not dormant — 0032 created it and 0103
    // dropped it, so no such function exists to touch. The live paths are the
    // per-flow claim functions, which B6 also leaves alone.
    expect(EXEC).not.toMatch(/create_or_claim_charge_attempt/);
    expect(EXEC).not.toMatch(/claim_session_payment_charge_attempt/);
    expect(EXEC).not.toMatch(/claim_manual_fee_charge_attempt/);
  });

  it("does not touch public cancellation — B7 / 0176 owns that", () => {
    expect(EXEC).not.toMatch(/public_cancel_appointment_with_token/);
  });

  it("does not alter the six-column postcare grant — B8 / 0177 owns that", () => {
    expect(EXEC).not.toMatch(/postcare_email_/);
  });

  it("does not modify 0174's objects", () => {
    for (const obj of [
      "created_by_practitioner_id",
      "cancelled_by_practitioner_id",
      "appointment_audit_actor_id_type_ck",
      "write_appointment_audit",
    ]) {
      expect(EXEC, `0175 must not execute anything touching ${obj}`).not.toContain(obj);
    }
  });
});
