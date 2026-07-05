import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// 0105 behavioral proof: active payment_charge_attempts duplicate protection is
// scoped by stripe_livemode. Same-mode duplicates remain blocked; different-mode
// attempts for the same session/appointment/reason are allowed.

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("payment-attempts-per-mode");
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
     values ($1, $2, $3, '2030-04-01T10:00:00Z', '2030-04-01T11:00:00Z', 60, 0,
             '2030-04-01T11:00:00Z')`,
    [id, s.studioId, s.clientId],
  );
  return id;
}

async function insertSessionAttempt(opts: {
  sessionId: string;
  livemode: boolean;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.payment_charge_attempts
       (id, studio_id, client_id, session_id, charge_reason,
        created_by_practitioner_id, amount_cents, status,
        stripe_livemode, stripe_account_id)
     values ($1,$2,$3,$4,'session_payment',$5,2500,$6,$7,$8)`,
    [
      id,
      s.studioId,
      s.clientId,
      opts.sessionId,
      s.practitionerId,
      opts.status ?? "ready",
      opts.livemode,
      opts.livemode ? `acct_live_${id}` : `acct_test_${id}`,
    ],
  );
  return id;
}

async function insertFeeAttempt(opts: {
  appointmentId: string;
  chargeReason: "late_cancellation_fee" | "no_show_fee";
  livemode: boolean;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.payment_charge_attempts
       (id, studio_id, client_id, appointment_id, charge_reason,
        created_by_practitioner_id, amount_cents, status,
        stripe_livemode, stripe_account_id)
     values ($1,$2,$3,$4,$5,$6,2500,$7,$8,$9)`,
    [
      id,
      s.studioId,
      s.clientId,
      opts.appointmentId,
      opts.chargeReason,
      s.practitionerId,
      opts.status ?? "ready",
      opts.livemode,
      opts.livemode ? `acct_live_${id}` : `acct_test_${id}`,
    ],
  );
  return id;
}

describe("0105: session payment active duplicates are per mode", () => {
  it("a test session attempt exists, and a live attempt is still allowed", async () => {
    const { sessionId } = await seedSession(s);
    await insertSessionAttempt({ sessionId, livemode: false });
    await insertSessionAttempt({ sessionId, livemode: true });

    const rows = await adminQuery(
      `select stripe_livemode, count(*)::int as count
         from public.payment_charge_attempts
        where session_id = $1 and charge_reason = 'session_payment'
        group by stripe_livemode
        order by stripe_livemode`,
      [sessionId],
    );
    expect(rows.rows).toEqual([
      { stripe_livemode: false, count: 1 },
      { stripe_livemode: true, count: 1 },
    ]);
  });

  it("a live session attempt exists, and a test attempt is still allowed", async () => {
    const { sessionId } = await seedSession(s);
    await insertSessionAttempt({ sessionId, livemode: true });
    await insertSessionAttempt({ sessionId, livemode: false });
  });

  it("same-mode duplicate session attempts are still blocked", async () => {
    const { sessionId } = await seedSession(s);
    await insertSessionAttempt({ sessionId, livemode: false });
    await expect(
      insertSessionAttempt({ sessionId, livemode: false }),
    ).rejects.toThrow(/payment_charge_attempts_active_session_payment_uniq|duplicate key/i);
  });
});

describe("0105: manual fee active duplicates are per mode", () => {
  it("a test manual-fee attempt does not block a live manual-fee attempt", async () => {
    const appointmentId = await seedAppointment();
    await insertFeeAttempt({
      appointmentId,
      chargeReason: "late_cancellation_fee",
      livemode: false,
    });
    await insertFeeAttempt({
      appointmentId,
      chargeReason: "late_cancellation_fee",
      livemode: true,
    });

    const rows = await adminQuery(
      `select stripe_livemode, count(*)::int as count
         from public.payment_charge_attempts
        where appointment_id = $1 and charge_reason = 'late_cancellation_fee'
        group by stripe_livemode
        order by stripe_livemode`,
      [appointmentId],
    );
    expect(rows.rows).toEqual([
      { stripe_livemode: false, count: 1 },
      { stripe_livemode: true, count: 1 },
    ]);
  });

  it("same-mode duplicate manual-fee attempts are still blocked", async () => {
    const appointmentId = await seedAppointment();
    await insertFeeAttempt({
      appointmentId,
      chargeReason: "no_show_fee",
      livemode: true,
    });
    await expect(
      insertFeeAttempt({
        appointmentId,
        chargeReason: "no_show_fee",
        livemode: true,
      }),
    ).rejects.toThrow(/payment_charge_attempts_active_fee_per_appointment_uniq|duplicate key/i);
  });
});
