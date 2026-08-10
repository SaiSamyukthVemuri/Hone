import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0176 — B7 public cancellation atomicity. STATIC contract.
//
// Behaviour lives in tests/db/public-cancellation-atomicity.db.test.ts. This
// file pins what a behavioural test cannot see: what the migration is allowed
// to contain, and what it must never emit.

const FILE = "supabase/migrations/0176_public_cancellation_atomicity.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

// EXECUTABLE SQL ONLY. The header deliberately NAMES what it does not touch
// (snapshot_appointment_buffer, B8's postcare grant, payments), so a scope
// assertion over the raw text would fail on the very prose documenting the
// discipline — and a test that cannot tell a comment from a statement would
// also miss a real violation hidden inside one.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

// Both function blocks are taken from the COMMENT-STRIPPED text: the migration
// documents what it deliberately does NOT do (e.g. "cancelled_by_practitioner_id
// is left NULL"), and a scope assertion run over raw source would trip on the
// prose describing the discipline it is enforcing.
const CMD7 =
  EXEC.match(
    /create or replace function public\.public_cancel_appointment_with_token\(\s*\n\s*p_token\s+text,[\s\S]*?p_presented_policy_hash text\s*\n\)[\s\S]*?\n\$\$;/,
  )?.[0] ?? "";
const SHIM5 =
  EXEC.match(
    /create or replace function public\.public_cancel_appointment_with_token\(\s*\n\s*p_token\s+text,\s*\n\s*p_reason\s+text,\s*\n\s*p_reason_label\s+text,\s*\n\s*p_note\s+text,\s*\n\s*p_follow_up_allowed boolean\s*\n\)[\s\S]*?\n\$\$;/,
  )?.[0] ?? "";

describe("0176 — migration state", () => {
  it("is no longer the repository maximum — B8 spent 0177 above it", () => {
    // Per CLAUDE.md only the CURRENT max may assert isRepoMax; that role passed
    // to 0177 when B8 landed.
    expect(isRepoMax("0176")).toBe(false);
    expect(countVersion("0176")).toBe(1);
  });

  it("consumes exactly one number and pins no successor's", () => {
    // 0177 is B8's to defend; asserting it here made this file a second, stale
    // owner that every future boundary would have to edit.
    expect(countVersion("0176")).toBe(1);
  });
});

describe("0176 — transaction envelope", () => {
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

describe("0176 — STANDING PROHIBITION: snapshot_appointment_buffer untouched", () => {
  it("never creates, replaces, drops or alters it", () => {
    // Production carries out-of-band GUC behaviour in that function which this
    // repository's migration source does not represent, so re-emitting it from
    // repo source could DELETE live production behaviour.
    expect(EXEC).not.toMatch(/snapshot_appointment_buffer/i);
    for (const verb of ["create", "create or replace", "drop", "alter"]) {
      expect(
        EXEC.toLowerCase().includes(`${verb} function public.snapshot_appointment_buffer`),
      ).toBe(false);
    }
  });
});

describe("0176 — the atomic command", () => {
  it("appends the two presentation-proof inputs to the existing command name", () => {
    expect(CMD7).not.toBe("");
    expect(CMD7).toMatch(/p_acknowledged_policy\s+boolean/);
    expect(CMD7).toMatch(/p_presented_policy_hash text/);
    expect(CMD7).toMatch(/policy_acknowledgement_id uuid/);
  });

  it("locks studios BEFORE appointments — the established order", () => {
    // 0170, 0171 and 0174 all take studios -> [advisory] -> appointments.
    // Reversing it here would create a fresh deadlock cycle against all three.
    const studioLock = CMD7.indexOf("from public.studios s");
    const apptLock = CMD7.indexOf("from public.appointments a\n   where a.cancellation_token_hash = p_token\n     and a.studio_id");
    expect(studioLock).toBeGreaterThan(-1);
    expect(apptLock).toBeGreaterThan(-1);
    expect(studioLock).toBeLessThan(apptLock);
    expect(CMD7).toMatch(/from public\.studios s\n\s*where s\.id = v_studio_id\n\s*for update/);
  });

  it("re-derives the policy hash itself and never accepts policy TEXT", () => {
    expect(CMD7).toMatch(/extensions\.digest\(/);
    expect(CMD7).toMatch(/'hex'/);
    // Asserted against RAW SQL, not EXEC, and the reason is a trap worth
    // naming: the canonical separator is E'\n---\n', which CONTAINS `---`, so
    // a line-based comment stripper truncates the one expression this test
    // exists to pin. Everything else here reads EXEC; this single positive
    // assertion cannot, and comments are irrelevant to it anyway.
    expect(SQL).toMatch(
      /coalesce\(v_cancel_text, ''\) \|\| E'\\n---\\n' \|\| coalesce\(v_noshow_text, ''\)/,
    );
    // No policy text parameter exists at all.
    expect(CMD7).not.toMatch(/p_cancellation_policy_text|p_no_show_policy_text|p_policy_text/);
  });

  it("compares the presented hash UNCONDITIONALLY, not only when an ack is required", () => {
    // The divergence from 0171 that makes "policy removed after render" fail
    // closed. If this comparison were nested inside the needs-ack branch, a
    // studio deleting its policy mid-flight would let the cancellation commit
    // as though nothing had changed.
    const cmp = CMD7.indexOf("p_presented_policy_hash is null");
    const needsAck = CMD7.indexOf("v_needs_ack :=");
    expect(cmp).toBeGreaterThan(-1);
    expect(needsAck).toBeGreaterThan(-1);
    expect(cmp, "hash comparison must precede the needs-ack computation").toBeLessThan(needsAck);
    expect(CMD7).toMatch(/return query select 'policy_changed'/);
  });

  it("treats a MISSING presented hash as a mismatch, never as consent", () => {
    expect(CMD7).toMatch(/p_presented_policy_hash is null\s*\n\s*or lower\(p_presented_policy_hash\) is distinct from v_current_hash/);
  });

  it("writes the acknowledgement INSIDE the command", () => {
    expect(CMD7).toMatch(/insert into public\.appointment_policy_acknowledgements/);
    expect(CMD7).toMatch(/'cancel'/);
    // Snapshot columns come from the LOCKED policy, not from a parameter.
    expect(CMD7).toMatch(/coalesce\(v_cancel_text, ''\), coalesce\(v_noshow_text, ''\),\s*\n\s*v_current_hash/);
  });

  it("keeps CLIENT actor semantics and invents no practitioner", () => {
    expect(CMD7).toMatch(/'client', null, 'cancelled'/);
    expect(CMD7).toMatch(/cancelled_by\s*= 'client'/);
    expect(CMD7).not.toMatch(/cancelled_by_practitioner_id/);
    expect(CMD7).not.toMatch(/actor_practitioner_id/);
  });

  it("writes exactly ONE audit insert and one status update", () => {
    expect((CMD7.match(/insert into public\.appointment_audit/g) ?? []).length).toBe(1);
    expect((CMD7.match(/update public\.appointments/g) ?? []).length).toBe(1);
  });

  it("does NOT assign updated_at by hand — B6's trigger owns it", () => {
    const upd = CMD7.match(/update public\.appointments[\s\S]*?where id = v_appt\.id;/)?.[0] ?? "";
    expect(upd).not.toMatch(/updated_at/);
  });

  it("touches neither reservations nor the Google outbox directly", () => {
    // Existing appointment triggers own both, inside the same transaction.
    expect(EXEC).not.toMatch(/studio_calendar_reservations/);
    expect(EXEC).not.toMatch(/calendar_sync_outbox/);
    expect(EXEC).not.toMatch(/calendar_event_links/);
  });

  it("ships NO fault-injection hook", () => {
    // The rollback proof uses a test-only trigger installed and dropped by the
    // test. A runtime parameter that can abort a cancellation is itself a
    // defect.
    expect(EXEC).not.toMatch(/p_fail|p_force_error|p_simulate|fault|inject/i);
  });
});

describe("0176 — the legacy 5-arg entry point cannot be a bypass", () => {
  it("is redefined rather than dropped, so an app rollback stays safe", () => {
    expect(SHIM5).not.toBe("");
    expect(EXEC).not.toMatch(/drop function[^;]*public_cancel_appointment_with_token/);
  });

  it("FAILS CLOSED for a policy-bearing studio and mutates nothing", () => {
    expect(SHIM5).toMatch(/v_needs_ack :=/);
    expect(SHIM5).toMatch(/if v_needs_ack then\s*\n\s*return query select 'ack_required'/);
    // It performs no write of its own at all.
    expect(SHIM5).not.toMatch(/update public\.appointments/);
    expect(SHIM5).not.toMatch(/insert into public\.appointment_audit/);
    expect(SHIM5).not.toMatch(/insert into public\.appointment_policy_acknowledgements/);
  });

  it("delegates to the 7-arg command only for a genuinely no-policy studio", () => {
    expect(SHIM5).toMatch(/from public\.public_cancel_appointment_with_token\(/);
    expect(SHIM5).toMatch(/false, v_current_hash/);
  });
});

describe("0176 — privilege posture", () => {
  it("revokes from public/anon/authenticated and grants ONLY service_role", () => {
    for (const sig of [
      "text, text, text, text, boolean, boolean, text",
      "text, text, text, text, boolean",
    ]) {
      const esc = sig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(SQL).toMatch(
        new RegExp(`revoke execute on function public\\.public_cancel_appointment_with_token\\(\\s*\\n?\\s*${esc}\\s*\\n?\\) from public, anon, authenticated;`),
      );
      expect(SQL).toMatch(
        new RegExp(`grant execute on function public\\.public_cancel_appointment_with_token\\(\\s*\\n?\\s*${esc}\\s*\\n?\\) to service_role;`),
      );
    }
  });
});

describe("0176 — scope discipline", () => {
  it("does not touch B6's objects", () => {
    for (const obj of [
      "enforce_appointment_transition",
      "appointment_transition_allowed",
      "appointments_enforce_transition_trg",
      "appointments_set_updated_at_trg",
      "appointments_set_capacity_enabled_trg",
      "set_appointment_capacity_enabled",
    ]) {
      expect(EXEC, `0176 must not touch ${obj}`).not.toContain(obj);
    }
  });

  it("introduces no transition bypass", () => {
    expect(EXEC).not.toMatch(/current_setting/);
    expect(EXEC).not.toMatch(/session_replication_role/);
    expect(EXEC).not.toMatch(/alter table public\.appointments\s+disable/i);
  });

  it("does not touch B8's postcare surface", () => {
    expect(EXEC).not.toMatch(/postcare/i);
  });

  it("does not touch payments", () => {
    for (const p of [
      "payment_charge_attempts",
      "manual_fee_charge_attempts",
      "appointment_payments",
      "stripe",
    ]) {
      expect(EXEC.toLowerCase()).not.toContain(p);
    }
  });

  it("performs no data backfill and rewrites no rows at apply time", () => {
    // The only DML inside the file is inside function BODIES, which run per
    // call and not at migration apply.
    const bodies = [CMD7, SHIM5].join("\n");
    const outside = EXEC.split(CMD7).join("").split(SHIM5).join("");
    for (const verb of ["update ", "insert into ", "delete from "]) {
      expect(outside.toLowerCase()).not.toContain(verb);
    }
    expect(bodies).toContain("update public.appointments");
  });
});
