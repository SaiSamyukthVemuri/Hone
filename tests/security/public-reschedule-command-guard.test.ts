import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// SOURCE GUARDS — the public reschedule route's authority boundary (0171).
// ===========================================================================
//
// These are textual guards over the route source. They exist because every rule
// below was, at some point, violated by code that typechecked and passed its
// unit tests: a caller-supplied duration, a detached policy INSERT, a
// post-commit re-read that reported failure for a committed reschedule, and a
// "current active owner" lookup standing in for the appointment's practitioner.
//
// A behavioural test proves the command is right. These prove the ROUTE did not
// quietly grow a second authority beside it.

const ROOT = join(__dirname, "..", "..");
const ACTIONS = readFileSync(
  join(ROOT, "app", "reschedule", "[token]", "actions.ts"),
  "utf8",
);
const FORM = readFileSync(
  join(ROOT, "app", "reschedule", "[token]", "RescheduleForm.tsx"),
  "utf8",
);
const MIGRATION = readFileSync(
  join(ROOT, "supabase", "migrations", "0171_public_reschedule_command_v2.sql"),
  "utf8",
);

/** Source with comments stripped, so prose about a pattern never satisfies a guard. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("--"))
    .join("\n");
}

const ACTIONS_CODE = code(ACTIONS);
const MIGRATION_CODE = code(MIGRATION);

describe("public reschedule route — calls v2 and only v2", () => {
  it("calls reschedule_appointment_v2", () => {
    expect(ACTIONS_CODE).toContain('"reschedule_appointment_v2"');
  });

  it("no longer calls the LEGACY reschedule_appointment RPC", () => {
    // `.rpc("reschedule_appointment", ...)` — the exact legacy call shape.
    expect(ACTIONS_CODE).not.toMatch(/rpc\(\s*["']reschedule_appointment["']/);
  });

  it("passes NO end time and NO duration to the command", () => {
    expect(ACTIONS_CODE).not.toContain("p_new_ends_at");
    expect(ACTIONS_CODE).not.toContain("p_new_duration_minutes");
  });

  it("passes the acknowledgement pair the command needs", () => {
    expect(ACTIONS_CODE).toContain("p_acknowledged_policy");
    expect(ACTIONS_CODE).toContain("p_presented_policy_snapshot_hash");
  });
});

describe("public reschedule route — the command owns persistence", () => {
  it("does not INSERT an appointment_policy_acknowledgements row itself", () => {
    expect(ACTIONS_CODE).not.toContain("appointment_policy_acknowledgements");
  });

  it("does not INSERT into appointments or appointment_audit", () => {
    expect(ACTIONS_CODE).not.toMatch(/from\(\s*["']appointments["']\s*\)\s*\.insert/);
    expect(ACTIONS_CODE).not.toContain("appointment_audit");
  });

  it("never re-reads the successor appointment after the command commits", () => {
    // The old code did `.from("appointments").select("*").eq("id", newAppointmentId)`
    // and returned {ok:false} when it failed.
    expect(ACTIONS_CODE).not.toContain("newAppointmentId)");
    expect(ACTIONS_CODE).not.toMatch(/select\(\s*["']\*["']\s*\)[\s\S]{0,80}newAppointmentId/);
  });

  it("builds the successor payload from the command return, not from a re-read", () => {
    expect(ACTIONS_CODE).toContain("starts_at: row.starts_at");
    expect(ACTIONS_CODE).toContain("ends_at: row.ends_at");
    expect(ACTIONS_CODE).toContain("duration_minutes: row.duration_minutes");
  });
});

describe("public reschedule route — practitioner attribution", () => {
  it("resolves the practitioner from the command return", () => {
    expect(ACTIONS_CODE).toContain("row.practitioner_id");
  });

  it('never selects a practitioner by role = "owner"', () => {
    // The old code picked "the current active owner", which is not the
    // appointment's practitioner.
    expect(ACTIONS_CODE).not.toMatch(/eq\(\s*["']role["']\s*,\s*["']owner["']\s*\)/);
  });

  it("scopes the practitioner metadata read by studio as well as id", () => {
    const idx = ACTIONS_CODE.indexOf("assignedPractitionerId");
    expect(idx).toBeGreaterThan(-1);
    const window = ACTIONS_CODE.slice(idx, idx + 900);
    expect(window).toMatch(/eq\(\s*["']studio_id["']/);
  });
});

describe("public reschedule route — no second authority beside the command", () => {
  it("the SUBMIT path does not re-derive an end time in TypeScript", () => {
    // `new Date(start.getTime() + existing.duration_minutes * 60_000)`
    expect(ACTIONS_CODE).not.toMatch(/duration_minutes\s*\*\s*60_?000/);
  });

  it("the SUBMIT path does not run its own horizon check", () => {
    expect(ACTIONS_CODE).not.toContain("isWithinPublicBookingHorizon");
  });

  it("the SUBMIT path does not run its own slot-membership re-check", () => {
    // getAvailableSlots survives ONLY in the two read surfaces. Prove the
    // submit action itself contains no `.some(` membership test.
    const submitIdx = ACTIONS_CODE.indexOf("rescheduleAppointmentViaTokenAction");
    expect(submitIdx).toBeGreaterThan(-1);
    const submitBody = ACTIONS_CODE.slice(submitIdx);
    expect(submitBody).not.toContain("getAvailableSlots");
  });
});

describe("public reschedule route — slot surfaces carry the booked contract", () => {
  it("never uses the service default as the slot duration", () => {
    expect(ACTIONS_CODE).not.toContain("default_duration_minutes ??");
    expect(ACTIONS_CODE).not.toContain("svc?.default_duration_minutes");
  });

  it("passes the original appointment's own reservation as a server-derived exclusion", () => {
    expect(ACTIONS_CODE).toContain("excludeReservation");
    expect(ACTIONS_CODE).toMatch(/sourceKind:\s*["']appointment["']/);
    // The exclusion id comes from the RESOLVED original, never from input.
    expect(ACTIONS_CODE).toContain("sourceId: original.appointment_id");
  });

  it("never reads the exclusion id from form data", () => {
    expect(ACTIONS_CODE).not.toMatch(/formData\.get\(\s*["'][^"']*exclu/i);
    expect(ACTIONS_CODE).not.toMatch(/formData\.get\(\s*["'][^"']*appointment_id/i);
  });

  it("passes the preserved practitioner and the capacity flag to the loader", () => {
    expect(ACTIONS_CODE).toContain("practitionerId");
    expect(ACTIONS_CODE).toContain("practitioner_capacity_enabled");
  });
});

describe("public reschedule — policy hash is server-generated", () => {
  it("the summary carries a server-built presentedPolicyHash", () => {
    expect(ACTIONS_CODE).toContain("presentedPolicyHash");
    expect(ACTIONS_CODE).toContain("buildPolicySnapshot");
  });

  it("the form posts the hash but never policy TEXT", () => {
    expect(code(FORM)).toContain('fd.set("presented_policy_hash"');
    expect(code(FORM)).not.toContain("cancellationPolicyText");
    expect(code(FORM)).not.toContain("noShowPolicyText");
  });

  it("the action never accepts policy text from the form", () => {
    expect(ACTIONS_CODE).not.toMatch(
      /formData\.get\(\s*["'][^"']*policy_text/i,
    );
  });
});

describe("public reschedule — raw token handling", () => {
  it("mints the raw successor token in the action and passes only its hash", () => {
    expect(ACTIONS_CODE).toContain("generateAppointmentToken()");
    expect(ACTIONS_CODE).toContain("hashAppointmentToken(newToken)");
  });

  it("never logs the raw token", () => {
    // Any log line that interpolates newToken directly.
    expect(ACTIONS_CODE).not.toMatch(/logInternal\([^)]*newToken/);
    expect(ACTIONS_CODE).not.toMatch(/console\.(log|error)\([^)]*newToken(?!\`)/);
  });
});

describe("migration 0171 — structural contract", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(MIGRATION_CODE).toMatch(/^begin;/m);
    expect(MIGRATION_CODE).toMatch(/^commit;/m);
    const begin = MIGRATION_CODE.indexOf("begin;");
    const lock = MIGRATION_CODE.indexOf("set local lock_timeout");
    expect(lock).toBeGreaterThan(begin);
  });

  it("creates exactly the three intended functions", () => {
    const created = [
      ...MIGRATION_CODE.matchAll(
        /create or replace function public\.([a-z_0-9]+)\(/g,
      ),
    ].map((m) => m[1]);
    expect(new Set(created)).toEqual(
      new Set([
        "public_reschedule_slot_candidates",
        "validate_public_reschedule_slot",
        "reschedule_appointment_v2",
      ]),
    );
  });

  it("pins search_path = '' and SECURITY DEFINER on every function", () => {
    const defs = MIGRATION_CODE.split("create or replace function").slice(1);
    expect(defs).toHaveLength(3);
    for (const d of defs) {
      expect(d).toContain("security definer");
      expect(d).toContain("set search_path = ''");
    }
  });

  it("revokes from PUBLIC, anon, authenticated AND service_role by name, then grants back only service_role", () => {
    for (const fn of [
      "public_reschedule_slot_candidates",
      "validate_public_reschedule_slot",
      "reschedule_appointment_v2",
    ]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(MIGRATION_CODE).toMatch(
          new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from ${role};`),
        );
      }
      expect(MIGRATION_CODE).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`),
      );
    }
  });

  it("grants EXECUTE to nobody except service_role", () => {
    const grants = [...MIGRATION_CODE.matchAll(/grant execute on function[^;]*to ([a-z_]+);/g)].map(
      (m) => m[1],
    );
    expect(grants.length).toBe(3);
    expect(new Set(grants)).toEqual(new Set(["service_role"]));
  });

  it("does NOT drop, re-sign or revoke the legacy reschedule_appointment", () => {
    expect(MIGRATION_CODE).not.toMatch(/drop function[^;]*reschedule_appointment\b/);
    expect(MIGRATION_CODE).not.toMatch(
      /revoke execute on function public\.reschedule_appointment\(/,
    );
    expect(MIGRATION_CODE).not.toMatch(
      /create or replace function public\.reschedule_appointment\(/,
    );
  });

  it("revokes NO table DML — this migration is additive only", () => {
    expect(MIGRATION_CODE).not.toMatch(/revoke\s+(insert|update|delete|all)/i);
    expect(MIGRATION_CODE).not.toMatch(/revoke[^;]*on table/i);
  });

  it("creates or alters no table, policy, trigger or index", () => {
    expect(MIGRATION_CODE).not.toMatch(/create table|alter table|drop table/i);
    expect(MIGRATION_CODE).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(MIGRATION_CODE).not.toMatch(/create trigger|drop trigger/i);
    expect(MIGRATION_CODE).not.toMatch(/create index|create unique index|drop index/i);
  });

  it("does not redefine any existing trigger function", () => {
    // Production's snapshot_appointment_buffer carries an out-of-band GUC
    // bypass that is absent from this repository. A `create or replace` of it
    // from a migration would silently delete that bypass. 0171 must not touch
    // ANY trigger function.
    for (const fn of [
      "snapshot_appointment_buffer",
      "set_appointment_capacity_enabled",
      "bump_appointment_sync_version",
      "sync_appointment_to_calendar_reservation",
      "enqueue_calendar_outbound",
      "enforce_appointment_buffer",
    ]) {
      expect(MIGRATION_CODE).not.toContain(`function public.${fn}(`);
    }
  });

  it("reuses 0170's timezone helpers rather than adding a third DST implementation", () => {
    expect(MIGRATION_CODE).toContain("public.public_booking_local_to_utc");
    expect(MIGRATION_CODE).not.toContain(
      "create or replace function public.public_booking_local_to_utc",
    );
    expect(MIGRATION_CODE).not.toContain(
      "create or replace function public.public_booking_tz_offset_minutes",
    );
  });

  it("schema-qualifies pgcrypto per the repository extension policy", () => {
    expect(MIGRATION_CODE).toContain("extensions.digest(");
    expect(MIGRATION_CODE).toContain("extensions.gen_random_uuid()");
    // A bare digest()/gen_random_uuid() would not resolve under search_path=''.
    expect(MIGRATION_CODE).not.toMatch(/[^.]\bdigest\(/);
    expect(MIGRATION_CODE).not.toMatch(/[^.]\bgen_random_uuid\(/);
  });

  it("reproduces the canonical policy separator exactly, as an E-string", () => {
    // A plain '\n---\n' literal is the four characters backslash-n and would
    // never match buildPolicySnapshot().
    expect(MIGRATION_CODE).toContain("E'\\n---\\n'");
  });

  it("uses a JS-trim-compatible whitespace predicate, never bare btrim()", () => {
    // btrim(x) with no second argument strips ONLY spaces, so it disagrees with
    // String.prototype.trim() on tabs/newlines — and hasAnyPolicy() decides on
    // the page whether the checkbox even renders.
    expect(MIGRATION_CODE).not.toMatch(/btrim\(\s*v_(cancel|noshow)_text\s*\)/);
    expect(MIGRATION_CODE).toContain("[^[:space:]");
    expect(MIGRATION_CODE).toContain("U&'\\FEFF'");
  });

  it("sets cancellation_kind in the SAME statement that cancels the original", () => {
    const upd = MIGRATION_CODE.match(
      /update public\.appointments a\s+set status\s*=\s*'cancelled'[\s\S]*?where a\.id = v_orig\.id;/,
    );
    expect(upd).not.toBeNull();
    expect(upd![0]).toContain("cancellation_kind   = 'rescheduled'");
  });

  it("sets rescheduled_from_appointment_id on the successor INSERT", () => {
    expect(MIGRATION_CODE).toContain("rescheduled_from_appointment_id");
    expect(MIGRATION_CODE).toContain("rescheduled_to_appointment_id = v_new_id");
  });

  it("takes the studio lock and the capacity advisory lock before the appointment locks", () => {
    const forUpdateStudio = MIGRATION_CODE.indexOf("from public.studios s\n   where s.id = v_studio_id\n   for update");
    const advisory = MIGRATION_CODE.indexOf("acquire_studio_capacity_lock(v_studio_id)");
    const apptLock = MIGRATION_CODE.indexOf("order by a.id\n      for update");
    expect(forUpdateStudio).toBeGreaterThan(-1);
    expect(advisory).toBeGreaterThan(forUpdateStudio);
    expect(apptLock).toBeGreaterThan(advisory);
  });

  it("locks the ORIGINAL even when its current start is outside the replacement window", () => {
    expect(MIGRATION_CODE).toContain("a.id = p_original_appointment_id");
  });
});
