import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #220 suite F: the at-most-once claim RPCs, exercised for real.
// Both RPCs are called the way the app calls them (through the
// service-role/admin path); the properties proven here are the ones
// the payment and email senders rely on: a claim can be won exactly
// once, and a non-ready row can never be claimed.

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("claims");
});

afterAll(async () => {
  await closePool();
});

async function seedAppointment(): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, '2030-03-01T10:00:00Z', '2030-03-01T11:00:00Z', 60, 0,
             '2030-03-01T11:00:00Z')`,
    [id, s.studioId, s.clientId],
  );
  return id;
}

async function seedChargeAttempt(status: string): Promise<string> {
  // One ACTIVE session_payment attempt is allowed per session
  // (payment_charge_attempts_active_session_payment_uniq), so every
  // attempt gets its own freshly seeded session.
  const { sessionId: ownSessionId } = await seedSession(s);
  const id = randomUUID();
  await adminQuery(
    `insert into public.payment_charge_attempts
       (id, studio_id, client_id, session_id, charge_reason,
        created_by_practitioner_id, amount_cents, status)
     values ($1, $2, $3, $4, 'session_payment', $5, 2500, $6)`,
    [id, s.studioId, s.clientId, ownSessionId, s.practitionerId, status],
  );
  return id;
}

describe("F: claim_email_send wins exactly once", () => {
  it("first confirmation claim succeeds, immediate second claim fails", async () => {
    const appointmentId = await seedAppointment();
    const first = await adminQuery(
      `select public.claim_email_send($1, 'confirmation') as claimed`,
      [appointmentId],
    );
    expect(first.rows[0].claimed).toBe(true);
    const second = await adminQuery(
      `select public.claim_email_send($1, 'confirmation') as claimed`,
      [appointmentId],
    );
    expect(second.rows[0].claimed).toBe(false);
  });
});

describe("F: claim_session_payment_charge_attempt", () => {
  it("refuses a non-ready (blocked) row with result not_ready", async () => {
    const attemptId = await seedChargeAttempt("blocked");
    const result = await adminQuery(
      `select result from public.claim_session_payment_charge_attempt($1, $2, $3)`,
      [attemptId, s.practitionerId, `hone:session_payment:${attemptId}:v1`],
    );
    expect(result.rows[0].result).toBe("not_ready");
    const row = await adminQuery(
      `select status from public.payment_charge_attempts where id = $1`,
      [attemptId],
    );
    expect(row.rows[0].status).toBe("blocked");
  });

  it("claims a ready row exactly once; the second call sees already_pending", async () => {
    const attemptId = await seedChargeAttempt("ready");
    const key = `hone:session_payment:${attemptId}:v1`;
    const first = await adminQuery(
      `select result, stripe_idempotency_key
         from public.claim_session_payment_charge_attempt($1, $2, $3)`,
      [attemptId, s.practitionerId, key],
    );
    expect(first.rows[0].result).toBe("claimed");
    const row = await adminQuery(
      `select status, stripe_idempotency_key from public.payment_charge_attempts where id = $1`,
      [attemptId],
    );
    expect(row.rows[0].status).toBe("pending_stripe");
    expect(row.rows[0].stripe_idempotency_key).toBe(key);

    const second = await adminQuery(
      `select result from public.claim_session_payment_charge_attempt($1, $2, $3)`,
      [attemptId, s.practitionerId, key],
    );
    expect(second.rows[0].result).toBe("already_pending");
  });

  it("refuses a practitioner from another studio with result not_authorized", async () => {
    const stranger = await seedStudio("claims-stranger");
    const attemptId = await seedChargeAttempt("ready");
    const result = await adminQuery(
      `select result from public.claim_session_payment_charge_attempt($1, $2, $3)`,
      [attemptId, stranger.practitionerId, `hone:session_payment:${attemptId}:v1`],
    );
    expect(result.rows[0].result).toBe("not_authorized");
    const row = await adminQuery(
      `select status from public.payment_charge_attempts where id = $1`,
      [attemptId],
    );
    expect(row.rows[0].status).toBe("ready");
  });
});
