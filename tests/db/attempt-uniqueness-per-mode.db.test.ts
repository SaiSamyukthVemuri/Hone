import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  seedSession,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Migration 0105: the active-attempt partial uniques on payment_charge_attempts
// are now mode-scoped — (session_id, stripe_livemode) for session_payment and
// (appointment_id, charge_reason, stripe_livemode) for fees. A test attempt no
// longer blocks a live attempt for the same session/appointment/reason (and
// vice versa); same-mode duplicate protection is preserved.

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("attempt-mode");
});

afterAll(async () => {
  await closePool();
});

// Each appointment gets its own non-overlapping slot — the studio-wide
// no_overlapping_active_appointments_per_studio exclusion constraint refuses
// two appointments at the same time.
let apptSlot = 0;
async function seedAppointment(): Promise<string> {
  const id = randomUUID();
  const day = String(1 + apptSlot++).padStart(2, "0");
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, $4, $5, 60, 0, $5)`,
    [
      id, s.studioId, s.clientId,
      `2030-04-${day}T10:00:00Z`, `2030-04-${day}T11:00:00Z`,
    ],
  );
  return id;
}

// Live rows must carry a stripe_account_id (0101:
// payment_charge_attempts_live_requires_account_check).
async function insertSessionAttempt(
  sessionId: string,
  livemode: boolean,
  status = "ready",
) {
  return adminQuery(
    `insert into public.payment_charge_attempts
       (id, studio_id, client_id, session_id, charge_reason,
        created_by_practitioner_id, amount_cents, status,
        stripe_livemode, stripe_account_id)
     values ($1, $2, $3, $4, 'session_payment', $5, 2500, $6, $7, $8)`,
    [
      randomUUID(), s.studioId, s.clientId, sessionId, s.practitionerId,
      status, livemode, livemode ? "acct_attempt_mode_live" : null,
    ],
  );
}

async function insertFeeAttempt(
  appointmentId: string,
  reason: "no_show_fee" | "late_cancellation_fee",
  livemode: boolean,
  status = "ready",
) {
  return adminQuery(
    `insert into public.payment_charge_attempts
       (id, studio_id, client_id, appointment_id, charge_reason,
        created_by_practitioner_id, amount_cents, status,
        stripe_livemode, stripe_account_id)
     values ($1, $2, $3, $4, $5, $6, 3000, $7, $8, $9)`,
    [
      randomUUID(), s.studioId, s.clientId, appointmentId, reason,
      s.practitionerId, status, livemode,
      livemode ? "acct_attempt_mode_live" : null,
    ],
  );
}

describe("session_payment: per-mode active uniqueness", () => {
  it("a TEST attempt does not block a LIVE attempt for the same session (and vice versa)", async () => {
    const { sessionId } = await seedSession(s);
    await expect(insertSessionAttempt(sessionId, false)).resolves.toBeDefined();
    await expect(insertSessionAttempt(sessionId, true)).resolves.toBeDefined();
    const { rows } = await adminQuery(
      `select stripe_livemode from public.payment_charge_attempts
        where session_id = $1 order by stripe_livemode`,
      [sessionId],
    );
    expect(rows.map((r: { stripe_livemode: boolean }) => r.stripe_livemode)).toEqual([false, true]);
  });

  it("a SAME-mode duplicate active session attempt is still blocked", async () => {
    const { sessionId } = await seedSession(s);
    await insertSessionAttempt(sessionId, false);
    await expect(insertSessionAttempt(sessionId, false)).rejects.toThrow(
      /payment_charge_attempts_active_session_payment_uniq/,
    );
    // Same for live.
    await insertSessionAttempt(sessionId, true);
    await expect(insertSessionAttempt(sessionId, true)).rejects.toThrow(
      /payment_charge_attempts_active_session_payment_uniq/,
    );
  });

  it("a terminal (cancelled) attempt frees the slot within its mode only", async () => {
    const { sessionId } = await seedSession(s);
    await insertSessionAttempt(sessionId, false, "cancelled");
    // Active test attempt allowed after a terminal one.
    await expect(insertSessionAttempt(sessionId, false)).resolves.toBeDefined();
  });
});

describe("fees: per-mode active uniqueness on (appointment, reason)", () => {
  it("a TEST no-show fee does not block a LIVE no-show fee on the same appointment", async () => {
    const appt = await seedAppointment();
    await expect(insertFeeAttempt(appt, "no_show_fee", false)).resolves.toBeDefined();
    await expect(insertFeeAttempt(appt, "no_show_fee", true)).resolves.toBeDefined();
  });

  it("a SAME-mode duplicate active fee is still blocked; a different reason is allowed", async () => {
    const appt = await seedAppointment();
    await insertFeeAttempt(appt, "late_cancellation_fee", true);
    await expect(insertFeeAttempt(appt, "late_cancellation_fee", true)).rejects.toThrow(
      /payment_charge_attempts_active_fee_per_appointment_uniq/,
    );
    // Different reason on the same appointment + mode is a different slot.
    await expect(insertFeeAttempt(appt, "no_show_fee", true)).resolves.toBeDefined();
  });
});
