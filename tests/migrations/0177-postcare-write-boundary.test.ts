import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0177 — B8 postcare write boundary. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/postcare-write-boundary.db.test.ts. This file pins what a
// behavioural test cannot see: what the migration is allowed to contain, and
// what it must never emit.

const FILE = "supabase/migrations/0177_postcare_write_boundary.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

// EXECUTABLE SQL ONLY — line comments stripped. The header deliberately NAMES
// what it does not touch (snapshot_appointment_buffer, B6/B7 objects, payments)
// so a reader knows those omissions are decisions; a scope assertion over raw
// text would fail on the very prose documenting the discipline.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const CLAIM =
  EXEC.match(
    /create or replace function public\.claim_postcare_send[\s\S]*?\n\$\$;/,
  )?.[0] ?? "";
const SETTLE =
  EXEC.match(
    /create or replace function public\.settle_postcare_send[\s\S]*?\n\$\$;/,
  )?.[0] ?? "";

describe("0177 — migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0177")).toBe(true);
    expect(versionsAbove("0177")).toEqual([]);
    expect(countVersion("0177")).toBe(1);
  });

  it("leaves 0178 free", () => {
    expect(countVersion("0178")).toBe(0);
  });
});

describe("0177 — transaction envelope", () => {
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

describe("0177 — STANDING PROHIBITION: snapshot_appointment_buffer untouched", () => {
  it("never references it in executable SQL", () => {
    // Production carries out-of-band GUC behaviour there which this
    // repository's migration source does not represent, so re-emitting it from
    // repo source could DELETE live production behaviour.
    expect(EXEC).not.toMatch(/snapshot_appointment_buffer/i);
  });
});

describe("0177 — claim_postcare_send", () => {
  it("has the exact signature and posture", () => {
    expect(CLAIM).not.toBe("");
    expect(CLAIM).toMatch(/p_appointment_id\s+uuid/);
    expect(CLAIM).toMatch(/p_studio_id\s+uuid/);
    expect(CLAIM).toMatch(/p_actor_practitioner_id uuid/);
    expect(CLAIM).toMatch(/p_is_resend\s+boolean/);
    expect(CLAIM).toMatch(/security definer/);
    expect(CLAIM).toMatch(/set search_path = pg_catalog, pg_temp/);
    // It returns the token the settlement requires.
    expect(CLAIM).toMatch(/claimed_at\s+timestamptz/);
  });

  it("authenticates an ACTIVE, SAME-STUDIO practitioner in the database", () => {
    // service_role is a transport identity, not a business actor.
    expect(CLAIM).toMatch(/from public\.practitioners p/);
    expect(CLAIM).toMatch(/p\.studio_id = p_studio_id/);
    expect(CLAIM).toMatch(/p\.active = true/);
    expect(CLAIM).toMatch(/'not_authorized'/);
  });

  it("locks the appointment and scopes it to the studio", () => {
    expect(CLAIM).toMatch(/from public\.appointments a[\s\S]*?for update/);
    expect(CLAIM).toMatch(/a\.studio_id = p_studio_id/);
  });

  it("is COMPLETED-only", () => {
    expect(CLAIM).toMatch(/status <> 'completed'/);
    expect(CLAIM).toMatch(/'not_completed'/);
  });

  it("distinguishes first send from resend by the existing sent_at", () => {
    expect(CLAIM).toMatch(/postcare_email_sent_at is null/);
    expect(CLAIM).toMatch(/postcare_email_sent_at is not null/);
    expect(CLAIM).toMatch(/'already_sent'/);
    expect(CLAIM).toMatch(/'never_sent'/);
  });

  it("owns the five-minute stale window itself — never a caller parameter", () => {
    expect(CLAIM).toMatch(/interval '5 minutes'/);
    expect(CLAIM).toMatch(/'already_claimed'/);
    // No caller-supplied window, and no caller-supplied timestamp at all.
    expect(CLAIM).not.toMatch(/p_stale|p_now|p_claimed_at|p_timestamp/);
  });

  it("MILLISECOND-truncates the claim token — load-bearing, not cosmetic", () => {
    // The token leaves as JSON and returns through a JavaScript Date, which
    // carries milliseconds. A microsecond value would be rounded in transit and
    // no settlement would ever match its own claim, so nothing would be
    // recorded as sent. Proved end-to-end in the DB round-trip test.
    expect(CLAIM).toMatch(/date_trunc\('milliseconds', now\(\)\)/);
    expect(CLAIM).not.toMatch(/v_now\s*:=\s*now\(\);/);
  });

  it("stamps claim and last_attempt with ONE instant and increments attempts", () => {
    expect(CLAIM).toMatch(/postcare_email_claimed_at\s+= v_now/);
    expect(CLAIM).toMatch(/postcare_email_last_attempt_at = v_now/);
    expect(CLAIM).toMatch(/postcare_email_send_attempts\s+= coalesce\(a\.postcare_email_send_attempts, 0\) \+ 1/);
  });
});

describe("0177 — settle_postcare_send", () => {
  it("has the exact signature and posture", () => {
    expect(SETTLE).not.toBe("");
    expect(SETTLE).toMatch(/p_claimed_at\s+timestamptz/);
    expect(SETTLE).toMatch(/p_success\s+boolean/);
    expect(SETTLE).toMatch(/p_retryable\s+boolean/);
    expect(SETTLE).toMatch(/security definer/);
    expect(SETTLE).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("requires the token, locks the row, and compares it EXACTLY", () => {
    expect(SETTLE).toMatch(/p_claimed_at is null/);
    expect(SETTLE).toMatch(/for update/);
    expect(SETTLE).toMatch(
      /postcare_email_claimed_at is distinct from p_claimed_at/,
    );
    expect(SETTLE).toMatch(/'stale_claim'/);
  });

  it("uses the DATABASE clock for both settlement stamps", () => {
    expect(SETTLE).toMatch(/v_now\s*:=\s*now\(\)/);
    expect(SETTLE).toMatch(/postcare_email_sent_at\s+= v_now/);
    expect(SETTLE).toMatch(/postcare_email_failed_at\s+= v_now/);
  });

  it("success clears the failure state and the claim", () => {
    const branch = SETTLE.match(/if coalesce\(p_success, false\) then[\s\S]*?return;/)?.[0] ?? "";
    expect(branch).toMatch(/postcare_email_failed_at = null/);
    expect(branch).toMatch(/postcare_email_last_error = null/);
    expect(branch).toMatch(/postcare_email_claimed_at = null/);
  });

  it("derives last_error from p_retryable ALONE, and accepts no provider payload", () => {
    // A raw provider error can carry recipient addresses and vendor internals,
    // and this column is rendered to practitioners.
    expect(SETTLE).toMatch(/coalesce\(p_retryable, false\)/);
    expect(SETTLE).toMatch(/Temporary email provider error/);
    expect(SETTLE).toMatch(/The email provider rejected the send/);
    expect(SETTLE).not.toMatch(/p_error|p_message|p_detail|p_payload|p_reason/);
  });

  it("FAILURE never touches sent_at — a failed resend keeps the real one", () => {
    // Erasing it would turn a delivery record into a lie in exactly the dispute
    // where it matters.
    const failure = SETTLE.slice(SETTLE.indexOf("v_err := case"));
    expect(failure).toMatch(/postcare_email_failed_at\s+= v_now/);
    expect(failure).toMatch(/postcare_email_claimed_at = null/);
    expect(failure).not.toMatch(/postcare_email_sent_at\s+=/);
  });
});

describe("0177 — privilege closure", () => {
  it("revokes UPDATE on exactly the six postcare columns from service_role", () => {
    const revoke = SQL.match(/revoke update \([\s\S]*?\) on table public\.appointments from service_role;/)?.[0] ?? "";
    expect(revoke).not.toBe("");
    for (const col of [
      "postcare_email_claimed_at",
      "postcare_email_failed_at",
      "postcare_email_last_attempt_at",
      "postcare_email_last_error",
      "postcare_email_send_attempts",
      "postcare_email_sent_at",
    ]) {
      expect(revoke, `must revoke ${col}`).toContain(col);
    }
  });

  it("grants EXECUTE only to service_role on both commands", () => {
    for (const fn of ["claim_postcare_send", "settle_postcare_send"]) {
      expect(SQL).toMatch(
        new RegExp(`revoke execute on function public\\.${fn}\\([\\s\\S]*?\\)\\s*\\n?\\s*from public, anon, authenticated;`),
      );
      expect(SQL).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]*?\\)\\s*\\n?\\s*to service_role;`),
      );
    }
  });

  it("grants no new UPDATE back to anyone", () => {
    expect(EXEC).not.toMatch(/grant update/i);
  });
});

describe("0177 — scope discipline", () => {
  it("adds no appointment_audit event", () => {
    // The seven writers it replaces produce none, and B8 is boundary hardening
    // rather than a new event taxonomy.
    expect(EXEC).not.toMatch(/appointment_audit/);
  });

  it("does not rewrite B6 or B7 objects", () => {
    for (const obj of [
      "mark_appointment_complete",
      "appointment_transition_allowed",
      "enforce_appointment_transition",
      "appointments_enforce_transition_trg",
      "appointments_set_updated_at_trg",
      "appointments_set_capacity_enabled_trg",
      "public_cancel_appointment_with_token",
      "appointment_policy_acknowledgements",
    ]) {
      expect(EXEC, `0177 must not touch ${obj}`).not.toContain(obj);
    }
  });

  it("does not touch reservations, the Google outbox, or payments", () => {
    for (const obj of [
      "studio_calendar_reservations",
      "calendar_sync_outbox",
      "calendar_event_links",
      "payment_charge_attempts",
      "stripe",
    ]) {
      expect(EXEC.toLowerCase()).not.toContain(obj);
    }
  });

  it("creates no trigger or index, and alters no table", () => {
    expect(EXEC).not.toMatch(/create trigger|drop trigger|create index|alter table/i);
  });

  it("performs NO data mutation at apply time", () => {
    // The DML inside function BODIES runs per call, never at migration apply.
    const outside = EXEC.split(CLAIM).join("").split(SETTLE).join("");
    for (const verb of ["insert into", "delete from"]) {
      expect(outside.toLowerCase()).not.toContain(verb);
    }
    // The only `update` outside the bodies is the REVOKE UPDATE statement.
    const updates = (outside.toLowerCase().match(/update/g) ?? []).length;
    expect(updates).toBe(1);
    expect(outside).toMatch(/revoke update \(/);
  });
});
