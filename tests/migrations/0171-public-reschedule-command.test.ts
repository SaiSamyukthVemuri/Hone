import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// 0171, structural contract for the public reschedule command.
// ===========================================================================
//
// Behavioural proof lives in tests/db/public-reschedule-*.db.test.ts. This file
// asserts the SHAPE of the migration: what it declares, what it must never
// touch, and the deployment-skew guarantees the rollout depends on.

const SQL = readFileSync(
  join(__dirname, "..", "..", "supabase", "migrations", "0171_public_reschedule_command_v2.sql"),
  "utf8",
);

/**
 * The migration with `--` comment lines stripped. Prose that DESCRIBES a
 * forbidden pattern ("never a DO-block with format()") must not satisfy a guard
 * looking for that pattern.
 */
const SQL_CODE = SQL.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

const FUNCTIONS = [
  "public_reschedule_slot_candidates",
  "validate_public_reschedule_slot",
  "reschedule_appointment_v2",
] as const;

const SIGS: Record<string, string> = {
  public_reschedule_slot_candidates: "(uuid, date, integer, uuid, uuid)",
  validate_public_reschedule_slot: "(uuid, uuid, uuid, timestamptz, timestamptz, uuid)",
  reschedule_appointment_v2: "(uuid, text, timestamptz, text, boolean, text)",
};

// 0172 superseded 0171 as the repository maximum. Per CLAUDE.md §2, ONLY the
// current maximum migration's own test may assert isRepoMax, an older
// per-migration test that keeps the pin turns every subsequent migration into a
// mechanical sweep, which is exactly how 0163/0164/0165 each went red after
// push. The "nothing above me" tripwire is served centrally by the current
// maximum's test (tests/migrations/0172-appointment-dml-revocation.test.ts).

describe("0171: declares exactly the three intended functions", () => {
  it("creates only the reschedule candidate helper, validator and command", () => {
    const declared = [...SQL.matchAll(/create or replace function public\.(\w+)\(/g)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual([...FUNCTIONS].sort());
  });

  it.each(FUNCTIONS)("%s carries a comment documenting its contract", (fn) => {
    expect(SQL).toContain(`comment on function public.${fn}(`);
  });
});

describe("0171: transaction and lock discipline", () => {
  it("opens its own transaction (db push does not wrap the file)", () => {
    expect(SQL).toMatch(/^begin;$/m);
    expect(SQL).toMatch(/^commit;$/m);
  });

  it("arms lock_timeout INSIDE the transaction, so it cannot emit 25P01", () => {
    const begin = SQL.indexOf("\nbegin;");
    const lock = SQL.indexOf("set local lock_timeout");
    const commit = SQL.indexOf("\ncommit;");
    expect(begin).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(begin);
    expect(lock).toBeLessThan(commit);
  });

  it("documents the lock order and takes studios before the advisory lock", () => {
    const studioLock = SQL.indexOf("where s.id = v_studio_id\n   for update");
    const advisory = SQL.indexOf("acquire_studio_capacity_lock(v_studio_id)");
    const apptLock = SQL.indexOf("order by a.id\n      for update");
    expect(studioLock).toBeGreaterThan(-1);
    expect(advisory).toBeGreaterThan(studioLock);
    expect(apptLock).toBeGreaterThan(advisory);
  });

  it("locks the original by id, not only by the replacement window", () => {
    expect(SQL).toContain("a.id = p_original_appointment_id");
  });
});

describe("0171: function security", () => {
  it.each(FUNCTIONS)("%s is SECURITY DEFINER with search_path = ''", (fn) => {
    const start = SQL.indexOf(`create or replace function public.${fn}(`);
    expect(start).toBeGreaterThan(-1);
    const body = SQL.slice(start, start + 4000);
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
  });

  it.each(FUNCTIONS)(
    "%s is revoked from PUBLIC, anon, authenticated AND service_role by name",
    (fn) => {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(SQL).toContain(
          `revoke execute on function public.${fn}${SIGS[fn]} from ${role};`,
        );
      }
    },
  );

  it.each(FUNCTIONS)("%s is granted back ONLY to service_role", (fn) => {
    expect(SQL).toContain(
      `grant execute on function public.${fn}${SIGS[fn]} to service_role;`,
    );
  });

  it("uses literal per-signature grant statements, never a DO block", () => {
    expect(SQL_CODE).not.toMatch(/do\s*\$\$/i);
    expect(SQL_CODE).not.toContain("format(");
  });

  it("grants EXECUTE to exactly three functions and to nobody but service_role", () => {
    const grants = [...SQL.matchAll(/grant execute on function[^;]*to ([a-z_]+);/g)].map(
      (m) => m[1],
    );
    expect(grants).toHaveLength(3);
    expect(new Set(grants)).toEqual(new Set(["service_role"]));
  });
});

describe("0171: additive only", () => {
  it("revokes no table DML", () => {
    expect(SQL).not.toMatch(/revoke\s+(insert|update|delete|truncate|all)\b/i);
    expect(SQL).not.toMatch(/revoke[^;]*\bon table\b/i);
  });

  it("creates or alters no table, policy, trigger, index or type", () => {
    expect(SQL).not.toMatch(/\b(create|alter|drop)\s+table\b/i);
    expect(SQL).not.toMatch(/\b(create|alter|drop)\s+policy\b/i);
    expect(SQL).not.toMatch(/\b(create|drop)\s+trigger\b/i);
    expect(SQL).not.toMatch(/\bcreate\s+(unique\s+)?index\b/i);
    expect(SQL).not.toMatch(/\b(create|alter|drop)\s+type\b/i);
  });

  it("performs no backfill and changes no studio flag", () => {
    // The ONLY UPDATE statements are inside the command, against
    // public.appointments, and they are the cancellation + reverse lineage.
    const updates = [...SQL.matchAll(/^\s*update\s+public\.(\w+)/gim)].map((m) => m[1]);
    expect(new Set(updates)).toEqual(new Set(["appointments"]));
    expect(SQL).not.toMatch(/update\s+public\.studios/i);
  });
});

describe("0171: deployment skew safety", () => {
  it("does NOT drop the legacy reschedule_appointment", () => {
    expect(SQL).not.toMatch(/drop\s+function[^;]*reschedule_appointment\b/i);
  });

  it("does NOT redefine or re-sign the legacy reschedule_appointment", () => {
    expect(SQL).not.toMatch(
      /create or replace function public\.reschedule_appointment\(/,
    );
  });

  it("does NOT revoke the legacy RPC's service_role EXECUTE", () => {
    expect(SQL).not.toMatch(
      /revoke execute on function public\.reschedule_appointment\(/,
    );
  });

  it("documents that legacy retirement is a LATER migration", () => {
    expect(SQL.toLowerCase()).toContain("later cleanup migration");
  });
});

describe("0171: must not disturb existing trigger functions", () => {
  // Production's snapshot_appointment_buffer carries an out-of-band GUC bypass
  // (`app.bypass_appointment_buffer_snapshot`) that is ABSENT from this
  // repository and from a locally-reset database. Any migration that
  // `create or replace`s it from repo source would silently delete that bypass
  // from production. 0171 touches no trigger function at all.
  it.each([
    "snapshot_appointment_buffer",
    "set_appointment_capacity_enabled",
    "bump_appointment_sync_version",
    "sync_appointment_to_calendar_reservation",
    "enqueue_calendar_outbound",
    "enqueue_calendar_outbound_on_delete",
    "enforce_appointment_buffer",
    "appointment_buffer_conflict",
  ])("does not redefine %s", (fn) => {
    expect(SQL).not.toContain(`function public.${fn}(`);
  });
});

describe("0171: reuses the reviewed 0170 primitives", () => {
  it("calls public_booking_local_to_utc rather than adding a third DST port", () => {
    expect(SQL).toContain("public.public_booking_local_to_utc(");
    expect(SQL).not.toContain(
      "create or replace function public.public_booking_local_to_utc",
    );
    expect(SQL).not.toContain(
      "create or replace function public.public_booking_tz_offset_minutes",
    );
  });

  it("does not edit or redefine 0170's booking candidate helper or validator", () => {
    expect(SQL).not.toContain(
      "create or replace function public.public_booking_slot_candidates",
    );
    expect(SQL).not.toContain(
      "create or replace function public.validate_public_booking_slot",
    );
    expect(SQL).not.toContain(
      "create or replace function public.create_public_appointment",
    );
  });
});

describe("0171: extension qualification", () => {
  it("schema-qualifies pgcrypto and uuid generation", () => {
    expect(SQL).toContain("extensions.digest(");
    expect(SQL).toContain("extensions.gen_random_uuid()");
  });

  it("never calls a bare digest()/gen_random_uuid(), which search_path='' cannot resolve", () => {
    expect(SQL).not.toMatch(/(?<!extensions\.)\bdigest\s*\(/);
    expect(SQL).not.toMatch(/(?<!extensions\.)\bgen_random_uuid\s*\(/);
  });
});

describe("0171: the command's authority contract", () => {
  it("accepts no end time, duration, status, studio, client, service or practitioner", () => {
    const start = SQL.indexOf("create or replace function public.reschedule_appointment_v2(");
    const sigEnd = SQL.indexOf(")", SQL.indexOf("p_presented_policy_snapshot_hash"));
    const signature = SQL.slice(start, sigEnd);
    for (const forbidden of [
      "p_new_ends_at",
      "p_duration",
      "p_new_duration",
      "p_status",
      "p_studio_id",
      "p_client_id",
      "p_service_id",
      "p_practitioner_id",
      "p_booked_outside_availability",
      "p_cancellation_kind",
      "p_new_appointment_id",
    ]) {
      expect(signature).not.toContain(forbidden);
    }
  });

  it("returns every field the application needs to avoid a post-commit re-read", () => {
    for (const col of [
      "result",
      "original_appointment_id",
      "new_appointment_id",
      "studio_id",
      "client_id",
      "service_id",
      "practitioner_id",
      "original_starts_at",
      "starts_at",
      "ends_at",
      "duration_minutes",
      "created_at",
      "policy_acknowledgement_id",
    ]) {
      expect(SQL).toMatch(new RegExp(`^\\s*${col}\\s+\\w`, "m"));
    }
  });

  it("derives the successor duration from the LOCKED ORIGINAL, never a service default", () => {
    expect(SQL).toContain("v_duration := v_orig.duration_minutes");
    // No read of services.default_duration_minutes anywhere in the command.
    expect(SQL).not.toContain("default_duration_minutes");
  });

  it("writes both lineage directions and the rescheduled cancellation kind", () => {
    expect(SQL).toContain("rescheduled_from_appointment_id");
    expect(SQL).toContain("rescheduled_to_appointment_id = v_new_id");
    expect(SQL).toContain("cancellation_kind   = 'rescheduled'");
  });

  it("writes the policy acknowledgement inside the transaction, linked to the ORIGINAL", () => {
    expect(SQL).toContain("insert into public.appointment_policy_acknowledgements");
    expect(SQL).toMatch(/'reschedule'/);
    expect(SQL).toContain("v_orig.id, v_orig.client_id, 'reschedule'");
  });

  it("emits only documented closed result codes", () => {
    const emitted = new Set(
      [...SQL.matchAll(/return query select '([a-z_]+)'::text/g)].map((m) => m[1]),
    );
    // `v_avail` passes validator codes through; those are asserted behaviourally.
    expect(emitted).toEqual(
      new Set([
        "appointment_not_found",
        "appointment_not_reschedulable",
        "invalid_time",
        "same_time",
        "outside_horizon",
        "policy_ack_required",
        "policy_changed",
        "payment_state_requires_studio",
        "practitioner_unavailable",
        "success",
      ]),
    );
  });

  it("never returns raw internal error text", () => {
    expect(SQL).not.toContain("sqlerrm");
    expect(SQL).not.toContain("error_detail");
  });

  it("rejects sub-millisecond input rather than truncating it", () => {
    expect(SQL).toContain(
      "p_new_starts_at is distinct from date_trunc('milliseconds', p_new_starts_at)",
    );
  });

  it("fails closed on payment state instead of moving money", () => {
    expect(SQL).toContain("payment_state_requires_studio");
    expect(SQL).toContain("public.appointment_payments");
    expect(SQL).toContain("public.payment_charge_attempts");
    expect(SQL).toContain("public.manual_fee_charge_attempts");
    // It must never write to any payment table.
    expect(SQL).not.toMatch(/insert into public\.(appointment_payments|payment_charge_attempts|manual_fee_charge_attempts)/);
    expect(SQL).not.toMatch(/update public\.(appointment_payments|payment_charge_attempts|manual_fee_charge_attempts)/);
  });
});
