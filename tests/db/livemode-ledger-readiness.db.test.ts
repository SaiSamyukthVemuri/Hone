import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #322 (migration 0101): live-payment DB readiness. The old
// payment_charge_attempts_livemode_false_check (stripe_livemode = false) is
// replaced by payment_charge_attempts_live_requires_account_check
// (stripe_livemode = false OR stripe_account_id is not null), and
// claim_session_payment_charge_attempt no longer refuses stripe_livemode=true
// rows. This proves the DB can now REPRESENT + CLAIM live rows, while runtime +
// env still block live charging (proven separately by the runtime safety-lock).
// Exercised against the REAL migrated local database (db-integration lane).

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("livemode-ledger");
});

afterAll(async () => {
  await closePool();
});

// Insert a session_payment charge attempt with explicit livemode + account.
// Returns the new attempt id. One active session_payment attempt is allowed per
// session, so each attempt gets its own freshly seeded session.
async function insertAttempt(opts: {
  status: string;
  livemode: boolean;
  accountId: string | null;
}): Promise<string> {
  const { sessionId } = await seedSession(s);
  const id = randomUUID();
  await adminQuery(
    `insert into public.payment_charge_attempts
       (id, studio_id, client_id, session_id, charge_reason,
        created_by_practitioner_id, amount_cents, status,
        stripe_livemode, stripe_account_id)
     values ($1,$2,$3,$4,'session_payment',$5,2500,$6,$7,$8)`,
    [id, s.studioId, s.clientId, sessionId, s.practitionerId, opts.status,
      opts.livemode, opts.accountId],
  );
  return id;
}

describe("0101: payment_charge_attempts can REPRESENT live rows", () => {
  it("accepts a live row (stripe_livemode=true) that carries a stripe_account_id", async () => {
    const id = await insertAttempt({
      status: "ready",
      livemode: true,
      accountId: "acct_live_readiness",
    });
    const row = await adminQuery(
      "select stripe_livemode, stripe_account_id from public.payment_charge_attempts where id = $1",
      [id],
    );
    expect(row.rows[0].stripe_livemode).toBe(true);
    expect(row.rows[0].stripe_account_id).toBe("acct_live_readiness");
  });

  it("REJECTS a malformed live row (stripe_livemode=true, null stripe_account_id) via the new CHECK", async () => {
    await expect(
      insertAttempt({ status: "ready", livemode: true, accountId: null }),
    ).rejects.toThrow(/live_requires_account_check|violates check constraint/i);
  });

  it("still accepts a test-mode row with a null stripe_account_id (backward compatible)", async () => {
    const id = await insertAttempt({
      status: "ready",
      livemode: false,
      accountId: null,
    });
    const row = await adminQuery(
      "select stripe_livemode from public.payment_charge_attempts where id = $1",
      [id],
    );
    expect(row.rows[0].stripe_livemode).toBe(false);
  });

  it("column default for stripe_livemode is still false", async () => {
    const { sessionId } = await seedSession(s);
    const id = randomUUID();
    await adminQuery(
      `insert into public.payment_charge_attempts
         (id, studio_id, client_id, session_id, charge_reason,
          created_by_practitioner_id, amount_cents, status)
       values ($1,$2,$3,$4,'session_payment',$5,2500,'ready')`,
      [id, s.studioId, s.clientId, sessionId, s.practitionerId],
    );
    const row = await adminQuery(
      "select stripe_livemode from public.payment_charge_attempts where id = $1",
      [id],
    );
    expect(row.rows[0].stripe_livemode).toBe(false);
  });
});

describe("0101: claim_session_payment_charge_attempt can CLAIM live rows", () => {
  it("claims a live (stripe_livemode=true) ready row → status pending_stripe", async () => {
    const id = await insertAttempt({
      status: "ready",
      livemode: true,
      accountId: "acct_live_claim",
    });
    const key = `hone:session_payment:${id}:v1`;
    const res = await adminQuery(
      "select result from public.claim_session_payment_charge_attempt($1,$2,$3)",
      [id, s.practitionerId, key],
    );
    expect(res.rows[0].result).toBe("claimed");
    const row = await adminQuery(
      "select status, stripe_idempotency_key from public.payment_charge_attempts where id = $1",
      [id],
    );
    expect(row.rows[0].status).toBe("pending_stripe");
    expect(row.rows[0].stripe_idempotency_key).toBe(key);
  });

  it("test-mode claim behavior is UNCHANGED (test-mode ready row still claims to pending_stripe)", async () => {
    const id = await insertAttempt({
      status: "ready",
      livemode: false,
      accountId: "acct_test_claim",
    });
    const key = `hone:session_payment:${id}:v1`;
    const res = await adminQuery(
      "select result from public.claim_session_payment_charge_attempt($1,$2,$3)",
      [id, s.practitionerId, key],
    );
    expect(res.rows[0].result).toBe("claimed");
    const row = await adminQuery(
      "select status from public.payment_charge_attempts where id = $1",
      [id],
    );
    expect(row.rows[0].status).toBe("pending_stripe");
  });

  it("still refuses a non-ready row (status guard unchanged) for a live row", async () => {
    const id = await insertAttempt({
      status: "blocked",
      livemode: true,
      accountId: "acct_live_blocked",
    });
    const res = await adminQuery(
      "select result from public.claim_session_payment_charge_attempt($1,$2,$3)",
      [id, s.practitionerId, `hone:session_payment:${id}:v1`],
    );
    expect(res.rows[0].result).toBe("not_ready");
  });
});
