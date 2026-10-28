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

// V2 caller. These cases hold on the CURRENT claim RPC and keep holding after
// 0249, so they run in every lane. The cases that only hold once 0249 is
// applied (a v1 or wrong-uuid fresh key returning not_ready, a second v2 claim
// returning not_ready, pending-without-original refusing both versions, a ready
// row retaining an old key or intent, the fee-reason key, the empty-original
// refusal, the prepared-statement and EXECUTE posture probes) belong to the
// 0249 stage, not here. They are NOT skip-gated on 0249 being present.
describe("V2 caller: the exact v2 create key is accepted by the claim RPC", () => {
  const v2Key = (id: string) => `hone:session_payment:${id}:v2:create`;

  it("a fresh ready row is claimed with the v2 create key and the key is stored", async () => {
    const id = await seedChargeAttempt("ready");
    const result = await adminQuery(
      `select result, stripe_idempotency_key, stripe_payment_intent_id, status_before_claim
         from public.claim_session_payment_charge_attempt($1, $2, $3)`,
      [id, s.practitionerId, v2Key(id)],
    );
    expect(result.rows[0]).toMatchObject({
      result: "claimed", stripe_idempotency_key: v2Key(id),
      stripe_payment_intent_id: null, status_before_claim: "ready",
    });
    const row = await adminQuery(
      `select status, stripe_idempotency_key from public.payment_charge_attempts where id = $1`, [id],
    );
    expect(row.rows[0]).toEqual({ status: "pending_stripe", stripe_idempotency_key: v2Key(id) });
  });

  it("a row that already holds its original reports already_pending with that original", async () => {
    const id = await seedChargeAttempt("pending_stripe");
    const pi = `pi_${id.replaceAll("-", "")}`;
    await adminQuery(
      `update public.payment_charge_attempts
          set stripe_payment_intent_id = $2, stripe_idempotency_key = $3 where id = $1`,
      [id, pi, v2Key(id)],
    );
    const result = await adminQuery(
      `select result, stripe_payment_intent_id from public.claim_session_payment_charge_attempt($1, $2, $3)`,
      [id, s.practitionerId, v2Key(id)],
    );
    expect(result.rows[0]).toMatchObject({ result: "already_pending", stripe_payment_intent_id: pi });
  });
});
