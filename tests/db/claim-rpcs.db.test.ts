import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  adminTx,
  asRole,
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

let appointmentSequence = 0;
async function seedAppointment(): Promise<string> {
  const id = randomUUID();
  // Each fixture keeps real capacity-OFF exclusion rules and gets its own slot.
  const startsAt = new Date(Date.UTC(2030, 2, 1, 10) + appointmentSequence++ * 2 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, $4, $5, 60, 0, $5)`,
    [id, s.studioId, s.clientId, startsAt.toISOString(), endsAt.toISOString()],
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
      [attemptId, s.practitionerId, `hone:session_payment:${attemptId}:v2:create`],
    );
    expect(result.rows[0].result).toBe("not_ready");
    const row = await adminQuery(
      `select status from public.payment_charge_attempts where id = $1`,
      [attemptId],
    );
    expect(row.rows[0].status).toBe("blocked");
  });

  it("claims a fresh v2 row exactly once; a missing-original retry is not_ready", async () => {
    const attemptId = await seedChargeAttempt("ready");
    const key = `hone:session_payment:${attemptId}:v2:create`;
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
    expect(second.rows[0].result).toBe("not_ready");
  });

  it("refuses a practitioner from another studio with result not_authorized", async () => {
    const stranger = await seedStudio("claims-stranger");
    const attemptId = await seedChargeAttempt("ready");
    const result = await adminQuery(
      `select result from public.claim_session_payment_charge_attempt($1, $2, $3)`,
      [attemptId, stranger.practitionerId, `hone:session_payment:${attemptId}:v2:create`],
    );
    expect(result.rows[0].result).toBe("not_authorized");
    const row = await adminQuery(
      `select status from public.payment_charge_attempts where id = $1`,
      [attemptId],
    );
    expect(row.rows[0].status).toBe("ready");
  });
});


// 0249 extends this existing harness: DB behavior only, zero SDK/network.
const v2Key = (id: string, reason = "session_payment") => `hone:${reason}:${id}:v2:create`;
const fullAttempt = async (id: string) => (await adminQuery(
  "select to_jsonb(a) as row from public.payment_charge_attempts a where id=$1", [id],
)).rows[0].row;
const claim = (id: string, key: string, practitioner = s.practitionerId) => adminQuery(
  "select *, updated_at::text as raw_claimed_at from public.claim_session_payment_charge_attempt($1,$2,$3)",
  [id, practitioner, key],
);

describe("0249 charge admission fence", () => {
  for (const keyKind of ["legacy", "wrong_reason", "wrong_uuid", "suffix_only"] as const) {
    it(`${keyKind} fresh key refuses without changing any ledger field`, async () => {
      const id = await seedChargeAttempt("ready");
      const key = keyKind === "legacy" ? `hone:session_payment:${id}:v1`
        : keyKind === "wrong_reason" ? v2Key(id, "no_show_fee")
        : keyKind === "wrong_uuid" ? v2Key(randomUUID()) : "v2:create";
      const before = await fullAttempt(id);
      expect((await claim(id, key)).rows[0].result).toBe("not_ready");
      expect(await fullAttempt(id)).toEqual(before);
    });
  }
  it("stamps exactly the locked-row key and returns the exact raw claim timestamp once", async () => {
    const id = await seedChargeAttempt("ready");
    const key = v2Key(id);
    const result = (await claim(id, key)).rows[0];
    expect(result).toMatchObject({ result: "claimed", attempt_id: id, studio_id: s.studioId,
      client_id: s.clientId, charge_reason: "session_payment", amount_cents: 2500,
      currency: "cad", stripe_idempotency_key: key, stripe_payment_intent_id: null,
      status_before_claim: "ready" });
    expect(Object.keys(result)).not.toContain("stripe_livemode");
    const raw = await adminQuery("select updated_at::text as raw from public.payment_charge_attempts where id=$1", [id]);
    expect(result.raw_claimed_at).toBe(raw.rows[0].raw);
    const before = await fullAttempt(id);
    expect((await claim(id, key)).rows[0].result).toBe("not_ready");
    expect(await fullAttempt(id)).toEqual(before);
  });
  it("concurrent exact v2 callers have one fresh winner and no renewal on losers", async () => {
    const id = await seedChargeAttempt("ready");
    const results = await Promise.all([claim(id, v2Key(id)), claim(id, v2Key(id)), claim(id, v2Key(id))]);
    expect(results.map(r => r.rows[0].result).sort()).toEqual(["claimed", "not_ready", "not_ready"]);
    const winner = results.find(r => r.rows[0].result === "claimed")!.rows[0];
    const after = await adminQuery("select updated_at::text as raw, stripe_idempotency_key from public.payment_charge_attempts where id=$1", [id]);
    expect(after.rows[0]).toEqual({ raw: winner.raw_claimed_at, stripe_idempotency_key: v2Key(id) });
  });
  for (const storedVersion of ["v1", "v2:create"] as const) {
    for (const callerVersion of ["v1", "v2:create"] as const) {
      it(`pending ${storedVersion} without original refuses ${callerVersion} and preserves the full row`, async () => {
        const id = await seedChargeAttempt("pending_stripe");
        await adminQuery("update public.payment_charge_attempts set stripe_idempotency_key=$2 where id=$1", [id, `hone:session_payment:${id}:${storedVersion}`]);
        const before = await fullAttempt(id);
        expect((await claim(id, `hone:session_payment:${id}:${callerVersion}`)).rows[0].result).toBe("not_ready");
        expect(await fullAttempt(id)).toEqual(before);
      });
    }
    it(`known original with ${storedVersion} keeps read/reconciliation and every persisted fact`, async () => {
      const id = await seedChargeAttempt("pending_stripe");
      const pi = `pi_${id.replaceAll("-", "")}`;
      await adminQuery("update public.payment_charge_attempts set stripe_payment_intent_id=$2, stripe_idempotency_key=$3 where id=$1", [id, pi, `hone:session_payment:${id}:${storedVersion}`]);
      const before = await fullAttempt(id);
      expect((await claim(id, v2Key(id))).rows[0]).toMatchObject({ result: "already_pending", stripe_payment_intent_id: pi });
      expect(await fullAttempt(id)).toEqual(before);
    });
  }
  for (const field of ["stripe_idempotency_key", "stripe_payment_intent_id", "stripe_charge_id", "charged_at"] as const) {
    it(`a ready row retaining ${field} cannot be rearmed`, async () => {
      const id = await seedChargeAttempt("ready");
      // The column is a fixed test literal; no untrusted SQL identifier.
      const value = field === "charged_at" ? "2026-10-01T00:00:00Z" : `old_${id}`;
      await adminQuery(`update public.payment_charge_attempts set ${field}=$2 where id=$1`, [id, value]);
      const before = await fullAttempt(id);
      expect((await claim(id, v2Key(id))).rows[0].result).toBe("not_ready");
      expect(await fullAttempt(id)).toEqual(before);
    });
  }
  it("warm prepared calls keep the same safe refusal vocabulary on repeat", async () => {
    const id = await seedChargeAttempt("ready");
    const before = await fullAttempt(id);
    await adminTx(async q => {
      await q("prepare claim_fence_probe(uuid,uuid,text) as select result from public.claim_session_payment_charge_attempt($1,$2,$3)");
      try {
        // UUIDs are generated internally and the key is a fixed safe literal.
        const sql = `execute claim_fence_probe('${id}','${s.practitionerId}','legacy-key')`;
        expect((await q(sql)).rows[0].result).toBe("not_ready");
        expect((await q(sql)).rows[0].result).toBe("not_ready");
      } finally { await q("deallocate claim_fence_probe"); }
    });
    expect(await fullAttempt(id)).toEqual(before);
    // This is warm-call behavior AFTER fence. It is NOT a replacement/cutover
    // test and does not establish that a pre-replacement OLD body has drained.
  });
  it("preserves owner, exact tuple/search_path and effective named-role EXECUTE", async () => {
    const oid = "public.claim_session_payment_charge_attempt(uuid,uuid,text)";
    const posture = (await adminQuery(`select pg_get_userbyid(proowner) as owner, prosecdef, proconfig,
      pg_get_function_identity_arguments(oid) as arguments,
      has_function_privilege('anon',oid,'EXECUTE') as anon,
      has_function_privilege('authenticated',oid,'EXECUTE') as authenticated,
      has_function_privilege('service_role',oid,'EXECUTE') as service
      from pg_proc where oid=$1::regprocedure`, [oid])).rows[0];
    expect(posture).toEqual({ owner: "postgres", prosecdef: true,
      proconfig: ["search_path=pg_catalog, pg_temp"],
      arguments: "p_attempt_id uuid, p_practitioner_id uuid, p_idempotency_key text",
      anon: false, authenticated: false, service: true });
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(role, q => q("select * from public.claim_session_payment_charge_attempt($1,$2,$3)", [randomUUID(), s.practitionerId, "legacy-key"]))).rejects.toThrow(/permission denied/i);
    }
    expect((await asRole("service_role", q => q("select result from public.claim_session_payment_charge_attempt($1,$2,$3)", [randomUUID(), s.practitionerId, "legacy-key"]))).rows[0].result).toBe("not_found");
  });
});


describe("0249 locked canonical fee reason", () => {
  for (const reason of ["late_cancellation_fee", "no_show_fee"] as const) {
    it(`${reason}: session-shaped key refuses; exact row-reason key alone claims`, async () => {
      const appointment = await seedAppointment();
      const id = randomUUID();
      await adminQuery(`insert into public.payment_charge_attempts
        (id,studio_id,client_id,appointment_id,charge_reason,created_by_practitioner_id,amount_cents,status)
        values ($1,$2,$3,$4,$5,$6,2500,'ready')`,
      [id,s.studioId,s.clientId,appointment,reason,s.practitionerId]);
      const before = await fullAttempt(id);
      expect((await claim(id, v2Key(id))).rows[0].result).toBe("not_ready");
      expect(await fullAttempt(id)).toEqual(before);
      expect((await claim(id, v2Key(id, reason))).rows[0]).toMatchObject({ result: "claimed", charge_reason: reason });
    });
  }
});


describe("0249 empty original is missing evidence", () => {
  it("an empty stored original refuses legacy and v2 requests without changing any field", async () => {
    const id = await seedChargeAttempt("pending_stripe");
    await adminQuery("update public.payment_charge_attempts set stripe_payment_intent_id='', stripe_idempotency_key=$2 where id=$1", [id, `hone:session_payment:${id}:v1`]);
    const before = await fullAttempt(id);
    for (const key of [`hone:session_payment:${id}:v1`, v2Key(id)]) {
      expect((await claim(id, key)).rows[0].result).toBe("not_ready");
      expect(await fullAttempt(id)).toEqual(before);
    }
    // Valid nonempty known originals retain the existing v1/v2 recovery cases.
  });
});
