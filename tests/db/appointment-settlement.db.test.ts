import { afterAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  adminTx,
  asRole,
  asUser,
  closePool,
  resolveLocalDbUrl,
  seedMember,
} from "./helpers/harness";
import {
  cleanupPaymentScenario,
  seedEligibleQuickCheckoutScenario,
  type PaymentScenario,
} from "./helpers/payment-seed";

// PAY-SETTLE / 0187 — the BEHAVIOURAL half.
//
// The source-contract half (tests/migrations/0187-appointment-settlement.test.ts)
// proves what the migration SAYS. This file proves what the migrated database
// DOES, against the real local Postgres: that authority is re-derived rather
// than trusted, that financial history is genuinely append-only, and — the part
// no static test can reach — that settlement and card charging exclude each
// other under real concurrency rather than by convention.

const LIVE = true;
const TEST_MODE = false;

const created: string[] = [];
async function scenario(opts = {}): Promise<PaymentScenario> {
  const s = await seedEligibleQuickCheckoutScenario(opts);
  created.push(s.studioId);
  return s;
}

afterAll(async () => {
  for (const studioId of created) {
    await cleanupPaymentScenario(studioId).catch(() => undefined);
  }
  await closePool();
});

/** Call a settlement command as a signed-in practitioner. */
async function record(
  userId: string,
  studioId: string,
  appointmentId: string,
  method: string,
  amountCents = 4500,
  livemode = LIVE,
) {
  return asUser(userId, async (q) => {
    const r = await q(
      `select * from public.record_appointment_settlement($1,$2,$3,$4,$5,$6)`,
      [studioId, appointmentId, method, amountCents, null, livemode],
    );
    return r.rows[0] as { result: string; settlement_id: string | null };
  });
}

async function waive(
  userId: string,
  studioId: string,
  appointmentId: string,
  amountCents = 4500,
  livemode = LIVE,
) {
  return asUser(userId, async (q) => {
    const r = await q(
      `select * from public.waive_appointment_fee($1,$2,$3,$4,$5)`,
      [studioId, appointmentId, amountCents, null, livemode],
    );
    return r.rows[0] as { result: string; settlement_id: string | null };
  });
}

async function liveRows(studioId: string) {
  const r = await adminQuery(
    `select id, method, amount_cents, superseded_at, supersedes_id, supersede_reason,
            recorded_by_practitioner_id
       from public.appointment_settlements
      where studio_id = $1 order by recorded_at`,
    [studioId],
  );
  return r.rows as Array<Record<string, unknown>>;
}

describe("0187 — the Checkout authority records a non-card disposition", () => {
  it("an active practitioner of the studio may record cash, and it is not a Stripe fact", async () => {
    const s = await scenario();
    const member = await seedMember(
      { studioId: s.studioId, userId: s.practitionerUserId, practitionerId: s.practitionerId, clientId: s.clientId },
      "settle-member",
    );

    const out = await record(member.userId, s.studioId, s.appointmentId, "paid_cash");
    expect(out.result).toBe("recorded");

    const rows = await liveRows(s.studioId);
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe("paid_cash");
    // Attribution is the ACTOR's practitioner row in THIS studio, never the
    // studio owner and never a caller-supplied id.
    expect(rows[0].recorded_by_practitioner_id).toBe(member.practitionerId);

    // NOT A PAYMENT. No charge attempt was created by recording cash.
    const attempts = await adminQuery(
      `select count(*)::int n from public.payment_charge_attempts where studio_id=$1`,
      [s.studioId],
    );
    expect(attempts.rows[0].n).toBe(0);
  });

  it("refuses a cross-studio appointment id as not_found, never as forbidden", async () => {
    const a = await scenario();
    const b = await scenario();
    const out = await record(
      a.practitionerUserId,
      a.studioId,
      b.appointmentId, // another tenant's visit
      "paid_cash",
    );
    expect(out.result).toBe("not_found");
    expect(await liveRows(b.studioId)).toHaveLength(0);
  });

  it("refuses a visit that is not completed", async () => {
    const s = await scenario({ appointmentStatus: "confirmed" });
    const out = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash");
    expect(out.result).toBe("not_completed");
  });

  it("a user with no practitioner row in the named studio is refused", async () => {
    const a = await scenario();
    const b = await scenario();
    // b's user naming a's studio.
    await expect(
      record(b.practitionerUserId, a.studioId, a.appointmentId, "paid_cash"),
    ).rejects.toThrow();
  });
});

describe("0187 — waiver and correction are owner-only, in the database", () => {
  it("a non-owner practitioner cannot waive, by either route", async () => {
    const s = await scenario();
    const member = await seedMember(
      { studioId: s.studioId, userId: s.practitionerUserId, practitionerId: s.practitionerId, clientId: s.clientId },
      "waive-member",
    );

    // Route 1: asking the practitioner command for a waiver.
    const viaRecord = await record(member.userId, s.studioId, s.appointmentId, "waived");
    expect(viaRecord.result).toBe("owner_only");

    // Route 2: calling the owner command directly. UI hiding is not authority,
    // so this is the call that actually matters.
    const viaWaive = await waive(member.userId, s.studioId, s.appointmentId);
    expect(viaWaive.result).toBe("not_owner");

    expect(await liveRows(s.studioId)).toHaveLength(0);
  });

  it("the owner may waive, and a waiver is not revenue", async () => {
    const s = await scenario();
    const out = await waive(s.practitionerUserId, s.studioId, s.appointmentId, 4500);
    expect(out.result).toBe("recorded");
    const rows = await liveRows(s.studioId);
    expect(rows[0].method).toBe("waived");
    // The amount is what was FORGIVEN. Nothing in the schema lets it be read as
    // collected: it is a different method on a different table from Stripe.
    expect(rows[0].amount_cents).toBe(4500);
  });

  it("a practitioner cannot supersede even her own record", async () => {
    const s = await scenario();
    const member = await seedMember(
      { studioId: s.studioId, userId: s.practitionerUserId, practitionerId: s.practitionerId, clientId: s.clientId },
      "supersede-member",
    );
    const first = await record(member.userId, s.studioId, s.appointmentId, "paid_cash");
    expect(first.result).toBe("recorded");

    const out = await asUser(member.userId, async (q) => {
      const r = await q(
        `select * from public.supersede_appointment_settlement($1,$2,$3,$4,$5,$6,$7)`,
        [s.studioId, first.settlement_id, "paid_e_transfer", 4500, "wrong method", null, LIVE],
      );
      return r.rows[0] as { result: string };
    });
    expect(out.result).toBe("not_owner");

    const rows = await liveRows(s.studioId);
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe("paid_cash");
  });
});

describe("0187 — financial history is append-only", () => {
  it("a correction inserts a new record and keeps the original verbatim", async () => {
    const s = await scenario();
    const first = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500);

    const out = await asUser(s.practitionerUserId, async (q) => {
      const r = await q(
        `select * from public.supersede_appointment_settlement($1,$2,$3,$4,$5,$6,$7)`,
        [s.studioId, first.settlement_id, "paid_e_transfer", 4000, "client actually e-transferred", null, LIVE],
      );
      return r.rows[0] as { result: string; settlement_id: string; superseded_settlement_id: string };
    });
    expect(out.result).toBe("corrected");

    const rows = await liveRows(s.studioId);
    expect(rows).toHaveLength(2);

    const original = rows.find((r) => r.id === first.settlement_id)!;
    // THE ORIGINAL IS UNTOUCHED. It still says what it said.
    expect(original.method).toBe("paid_cash");
    expect(original.amount_cents).toBe(4500);
    expect(original.superseded_at).not.toBeNull();

    const replacement = rows.find((r) => r.id === out.settlement_id)!;
    expect(replacement.method).toBe("paid_e_transfer");
    expect(replacement.supersedes_id).toBe(first.settlement_id);
    expect(replacement.supersede_reason).toBe("client actually e-transferred");
    expect(replacement.superseded_at).toBeNull();

    // EXACTLY ONE live truth, throughout.
    const live = rows.filter((r) => r.superseded_at === null);
    expect(live).toHaveLength(1);
  });

  it("a correction without a reason is refused", async () => {
    const s = await scenario();
    const first = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash");
    const out = await asUser(s.practitionerUserId, async (q) => {
      const r = await q(
        `select * from public.supersede_appointment_settlement($1,$2,$3,$4,$5,$6,$7)`,
        [s.studioId, first.settlement_id, "waived", 4500, "   ", null, LIVE],
      );
      return r.rows[0] as { result: string };
    });
    expect(out.result).toBe("invalid_input");
  });

  it("superseding an already-superseded record reports stale_target", async () => {
    const s = await scenario();
    const first = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash");
    const correct = () =>
      asUser(s.practitionerUserId, async (q) => {
        const r = await q(
          `select * from public.supersede_appointment_settlement($1,$2,$3,$4,$5,$6,$7)`,
          [s.studioId, first.settlement_id, "waived", 4500, "reason", null, LIVE],
        );
        return r.rows[0] as { result: string };
      });
    expect((await correct()).result).toBe("corrected");
    expect((await correct()).result).toBe("stale_target");
  });

  it("the disposition cannot be UPDATEd into a different one, even by the table owner", async () => {
    const s = await scenario();
    const first = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash");
    await expect(
      adminQuery(`update public.appointment_settlements set method='waived' where id=$1`, [
        first.settlement_id,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it("a financial record cannot be DELETEd, even by the table owner", async () => {
    const s = await scenario();
    const first = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash");
    await expect(
      adminQuery(`delete from public.appointment_settlements where id=$1`, [first.settlement_id]),
    ).rejects.toThrow(/never deleted/);
  });

  it("recorded_at is server time and cannot be supplied by the caller", async () => {
    const s = await scenario();
    await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash");
    const rows = await liveRows(s.studioId);
    const r = await adminQuery(
      `select recorded_at > now() - interval '2 minutes' fresh from public.appointment_settlements where id=$1`,
      [rows[0].id],
    );
    expect(r.rows[0].fresh).toBe(true);
  });
});

describe("0187 — UNKNOWN is an absence, never a value", () => {
  it("a completed appointment with no disposition has no row at all", async () => {
    const s = await scenario();
    expect(await liveRows(s.studioId)).toHaveLength(0);
    // And nothing in the vocabulary could express it if somebody tried.
    await expect(
      adminQuery(
        `insert into public.appointment_settlements
           (studio_id, appointment_id, method, amount_cents, recorded_by_practitioner_id)
         values ($1,$2,'unknown',0,$3)`,
        [s.studioId, s.appointmentId, s.practitionerId],
      ),
    ).rejects.toThrow(/method_check/);
  });

  it("the vocabulary has no card or hone member", async () => {
    const s = await scenario();
    for (const forbidden of ["card", "hone", "stripe", "paid_card"]) {
      await expect(
        adminQuery(
          `insert into public.appointment_settlements
             (studio_id, appointment_id, method, amount_cents, recorded_by_practitioner_id)
           values ($1,$2,$3,100,$4)`,
          [s.studioId, s.appointmentId, forbidden, s.practitionerId],
        ),
      ).rejects.toThrow(/method_check/);
    }
  });
});

describe("0187 — settlement and card charging exclude each other", () => {
  it("refuses to record cash when Hone already holds a succeeded charge", async () => {
    const s = await scenario({ attempt: "succeeded" });
    const out = await record(
      s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE,
    );
    expect(out.result).toBe("card_payment_exists");
    expect(await liveRows(s.studioId)).toHaveLength(0);
  });

  it("PERMITS cash after a full refund, because the money went back", async () => {
    const s = await scenario({ attempt: "refunded" });
    // The seeder stamps refund_status without an amount, which is a row
    // production never writes: the refund helper always sets
    // refund_amount_cents = amount_cents (v1 is full-refund-only). The block is
    // released by CENTS, not by status, so the fixture is completed to match
    // what a real refund looks like. A status with no amount deliberately keeps
    // blocking — see the fail-closed case below.
    await adminQuery(
      `update public.payment_charge_attempts
          set refund_amount_cents = amount_cents where studio_id = $1`,
      [s.studioId],
    );
    const out = await record(
      s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE,
    );
    expect(out.result).toBe("recorded");
    // And the refund fact itself was not touched.
    const a = await adminQuery(
      `select refund_status from public.payment_charge_attempts where studio_id=$1`,
      [s.studioId],
    );
    expect(a.rows[0].refund_status).toBe("succeeded");
  });

  it("a lie about the deployment mode cannot unblock REAL money", async () => {
    const s = await scenario({ attempt: "succeeded" });
    // A live-mode attempt must also carry its Connect account (0032's
    // live_requires_account CHECK), so this fixture builds a coherent live row
    // rather than a half-one.
    await adminQuery(
      `update public.payment_charge_attempts
          set stripe_livemode = true,
              stripe_account_id = coalesce(stripe_account_id, 'acct_live_' || $2)
        where studio_id = $1`,
      [s.studioId, s.runId],
    );
    // The caller claims test mode, hoping the live attempt is ignored.
    const out = await record(
      s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE,
    );
    expect(out.result).toBe("card_payment_exists");
  });

  it("the claim command refuses a card charge on an externally-settled visit", async () => {
    const s = await scenario({ attempt: "ready" });
    const attempt = await adminQuery(
      `select id from public.payment_charge_attempts where studio_id=$1`,
      [s.studioId],
    );
    const attemptId = attempt.rows[0].id as string;

    await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, LIVE);

    const claim = await adminQuery(
      `select result from public.claim_session_payment_charge_attempt($1,$2,$3)`,
      [attemptId, s.practitionerId, `hone:session_payment:${attemptId}:v2:create`],
    );
    expect(claim.rows[0].result).toBe("settled_externally");

    // THE ATTEMPT WAS NEVER CHARGED. It was RETIRED by the settlement itself,
    // through the existing 0073 lifecycle, rather than left `ready` forever
    // with no cancellation path — choosing cash IS the decision not to use the
    // prepared charge.
    const after = await adminQuery(
      `select status, cancelled_at, cancelled_by_practitioner_id, cancelled_reason,
              charged_at, stripe_payment_intent_id
         from public.payment_charge_attempts where id=$1`,
      [attemptId],
    );
    expect(after.rows[0].status).toBe("cancelled");
    expect(after.rows[0].cancelled_at).not.toBeNull();
    expect(after.rows[0].cancelled_by_practitioner_id).toBe(s.practitionerId);
    expect(after.rows[0].cancelled_reason).toMatch(/settled outside Hone/i);
    // No money moved and no Stripe identity was invented.
    expect(after.rows[0].charged_at).toBeNull();
    expect(after.rows[0].stripe_payment_intent_id).toBeNull();
  });

  it("still_owes retires the prepared attempt but does NOT block a later card charge", async () => {
    const s = await scenario({ attempt: "ready" });
    const first = (
      await adminQuery(
        `select id from public.payment_charge_attempts where studio_id=$1`,
        [s.studioId],
      )
    ).rows[0].id as string;

    await record(s.practitionerUserId, s.studioId, s.appointmentId, "still_owes", 4500, LIVE);

    // The prepared attempt is retired like any other non-card choice: the
    // practitioner said the client has not paid, so that charge is not the one
    // being taken.
    expect(
      (await adminQuery(`select status from public.payment_charge_attempts where id=$1`, [first]))
        .rows[0].status,
    ).toBe("cancelled");

    // THE DEBT IS STILL COLLECTABLE BY CARD. A NEW attempt prepared afterwards
    // claims normally — still_owes is deliberately absent from the blocking
    // set, so the ordinary "she said she'd pay later, then paid by card"
    // progression needs no owner correction.
    const second = randomUUID();
    await adminQuery(
      `insert into public.payment_charge_attempts
         (id, studio_id, charge_reason, client_id, session_id, appointment_id,
          created_by_practitioner_id, amount_cents, currency, status, stripe_livemode,
          client_payment_method_id, card_authorization_signature_id)
       select $1, studio_id, charge_reason, client_id, session_id, appointment_id,
              created_by_practitioner_id, amount_cents, currency, 'ready', stripe_livemode,
              client_payment_method_id, card_authorization_signature_id
         from public.payment_charge_attempts where id = $2`,
      [second, first],
    );

    const claim = await adminQuery(
      `select result from public.claim_session_payment_charge_attempt($1,$2,$3)`,
      [second, s.practitionerId, `hone:session_payment:${second}:v2:create`],
    );
    expect(claim.rows[0].result).toBe("claimed");

    // AND THE ORIGINAL RECORD SURVIVES, untouched, with its author's name on it.
    const rows = await liveRows(s.studioId);
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe("still_owes");
    expect(rows[0].superseded_at).toBeNull();
  });
});

describe("0187 — P1-B: settlement never requires a treatment session", () => {
  it("a completed appointment with NO session can still be recorded as paid cash", async () => {
    // The card path legitimately needs a session (the amount comes off the
    // treatment record). A cash record does not, and forcing one is the exact
    // coupling that produced the fake-payment workaround.
    const s = await scenario({ withSession: false, attempt: "none" });
    const sessions = await adminQuery(
      `select count(*)::int n from public.sessions where studio_id=$1`,
      [s.studioId],
    );
    expect(sessions.rows[0].n).toBe(0);

    const out = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash");
    expect(out.result).toBe("recorded");

    // AND NO SESSION WAS MANUFACTURED to make it work.
    const after = await adminQuery(
      `select count(*)::int n from public.sessions where studio_id=$1`,
      [s.studioId],
    );
    expect(after.rows[0].n).toBe(0);
  });

  it("waived stays owner-only on a session-less appointment", async () => {
    const s = await scenario({ withSession: false, attempt: "none" });
    const member = await seedMember(
      { studioId: s.studioId, userId: s.practitionerUserId, practitionerId: s.practitionerId, clientId: s.clientId },
      "nosess-member",
    );
    expect((await waive(member.userId, s.studioId, s.appointmentId)).result).toBe("not_owner");
    expect((await waive(s.practitionerUserId, s.studioId, s.appointmentId)).result).toBe("recorded");
  });

  it("cross-studio authority is unchanged when there is no session", async () => {
    const a = await scenario({ withSession: false, attempt: "none" });
    const b = await scenario({ withSession: false, attempt: "none" });
    expect(
      (await record(a.practitionerUserId, a.studioId, b.appointmentId, "paid_cash")).result,
    ).toBe("not_found");
    expect(await liveRows(b.studioId)).toHaveLength(0);
  });
});

describe("0187 — P2: a FULL refund releases the block, a PARTIAL one does not", () => {
  async function setRefund(studioId: string, amountCents: number | null) {
    await adminQuery(
      `update public.payment_charge_attempts
          set refund_status = 'succeeded',
              refund_amount_cents = $2,
              refunded_at = now()
        where studio_id = $1`,
      [studioId, amountCents],
    );
  }

  it("succeeded + NO refund -> card money blocks settlement", async () => {
    const s = await scenario({ attempt: "succeeded" });
    const out = await record(
      s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE,
    );
    expect(out.result).toBe("card_payment_exists");
  });

  it("succeeded + PARTIAL refund -> STILL blocks, because the studio still holds money", async () => {
    const s = await scenario({ attempt: "succeeded" });
    const amount = (
      await adminQuery(
        `select amount_cents from public.payment_charge_attempts where studio_id=$1`,
        [s.studioId],
      )
    ).rows[0].amount_cents as number;
    // refund_status says a refund SUCCEEDED. Only part of the money went back.
    await setRefund(s.studioId, Math.floor(amount / 2));

    const out = await record(
      s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE,
    );
    expect(out.result).toBe("card_payment_exists");
    expect(await liveRows(s.studioId)).toHaveLength(0);
  });

  it("succeeded + FULL refund -> a replacement settlement is permitted", async () => {
    const s = await scenario({ attempt: "succeeded" });
    const amount = (
      await adminQuery(
        `select amount_cents from public.payment_charge_attempts where studio_id=$1`,
        [s.studioId],
      )
    ).rows[0].amount_cents as number;
    await setRefund(s.studioId, amount);

    const out = await record(
      s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", amount, TEST_MODE,
    );
    expect(out.result).toBe("recorded");
  });

  it("the replacement records new truth WITHOUT rewriting either card fact", async () => {
    const s = await scenario({ attempt: "succeeded" });
    const before = (
      await adminQuery(
        `select id, status, stripe_payment_intent_id, stripe_charge_id, charged_at, amount_cents
           from public.payment_charge_attempts where studio_id=$1`,
        [s.studioId],
      )
    ).rows[0];
    await setRefund(s.studioId, before.amount_cents as number);

    expect(
      (await record(
        s.practitionerUserId, s.studioId, s.appointmentId, "paid_e_transfer",
        before.amount_cents as number, TEST_MODE,
      )).result,
    ).toBe("recorded");

    const after = (
      await adminQuery(
        `select id, status, refund_status, refund_amount_cents,
                stripe_payment_intent_id, stripe_charge_id, charged_at
           from public.payment_charge_attempts where studio_id=$1`,
        [s.studioId],
      )
    ).rows[0];
    // THE CARD SUCCESS IS STILL HISTORY.
    expect(after.id).toBe(before.id);
    expect(after.status).toBe("succeeded");
    expect(after.stripe_payment_intent_id).toBe(before.stripe_payment_intent_id);
    expect(after.stripe_charge_id).toBe(before.stripe_charge_id);
    expect(after.charged_at).toEqual(before.charged_at);
    // AND SO IS THE REFUND.
    expect(after.refund_status).toBe("succeeded");
    expect(after.refund_amount_cents).toBe(before.amount_cents);
    // The replacement is a separate, attested fact on a separate table.
    const rows = await liveRows(s.studioId);
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe("paid_e_transfer");
  });

  it("a refund whose AMOUNT is unknown keeps blocking — fail closed", async () => {
    // refund_status = 'succeeded' with a NULL amount cannot prove the money
    // went back. Production never writes this row, but guessing "probably
    // full" is how a studio ends up recorded as paid twice, so the unknown
    // resolves against releasing the block.
    const s = await scenario({ attempt: "succeeded" });
    await setRefund(s.studioId, null);
    const out = await record(
      s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE,
    );
    expect(out.result).toBe("card_payment_exists");
  });

  it("no Stripe object is created or altered anywhere in that flow", async () => {
    // Structural: the settlement path holds no Stripe column to write and the
    // commands touch exactly one table. Proven by counting attempt rows, which
    // is where any fabricated Stripe fact would have to live.
    const s = await scenario({ attempt: "succeeded" });
    const amount = (
      await adminQuery(
        `select amount_cents from public.payment_charge_attempts where studio_id=$1`,
        [s.studioId],
      )
    ).rows[0].amount_cents as number;
    await setRefund(s.studioId, amount);
    await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", amount, TEST_MODE);

    const attempts = await adminQuery(
      `select count(*)::int n from public.payment_charge_attempts where studio_id=$1`,
      [s.studioId],
    );
    expect(attempts.rows[0].n).toBe(1);
  });
});

describe("0187 — concurrency, on the shared appointment lock", () => {
  // Two REAL connections, each holding an open transaction, so the interleaving
  // is genuine rather than simulated. Neither side may rely on a pre-read or on
  // the UI having disabled a button.
  const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 6 });
  afterAll(async () => {
    await pool.end();
  });

  async function openAsUser(userId: string) {
    const c = await pool.connect();
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    return c;
  }

  it("PROOF 1 — settlement holds the lock, a concurrent card claim cannot race through", async () => {
    const s = await scenario({ attempt: "ready" });
    const attemptId = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;

    const settler = await openAsUser(s.practitionerUserId);
    const settled = await settler.query(
      `select * from public.record_appointment_settlement($1,$2,'paid_cash',4500,null,$3)`,
      [s.studioId, s.appointmentId, LIVE],
    );
    expect(settled.rows[0].result).toBe("recorded");
    // Settlement is COMMITTED-PENDING: it holds the advisory key.

    const claimer = await pool.connect();
    await claimer.query("begin");
    let claimResolved = false;
    const claimPromise = claimer
      .query(`select result from public.claim_session_payment_charge_attempt($1,$2,$3)`, [
        attemptId,
        s.practitionerId,
        `hone:session_payment:${attemptId}:v2:create`,
      ])
      .then((r) => {
        claimResolved = true;
        return r;
      });

    // It must BLOCK on the advisory key rather than proceed on a stale read.
    await new Promise((r) => setTimeout(r, 400));
    expect(claimResolved).toBe(false);

    await settler.query("commit");
    settler.release();

    const claim = await claimPromise;
    expect(claim.rows[0].result).toBe("settled_externally");
    await claimer.query("rollback");
    claimer.release();

    // Retired by the settlement inside the same locked transaction, never
    // charged.
    const after = await adminQuery(
      `select status, cancelled_by_practitioner_id from public.payment_charge_attempts where id=$1`,
      [attemptId],
    );
    expect(after.rows[0].status).toBe("cancelled");
    expect(after.rows[0].cancelled_by_practitioner_id).toBe(s.practitionerId);
  });

  it("PROOF 2 — a card claim holds the lock, a concurrent settlement cannot race through", async () => {
    const s = await scenario({ attempt: "ready" });
    const attemptId = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;

    const claimer = await pool.connect();
    await claimer.query("begin");
    const claim = await claimer.query(
      `select result from public.claim_session_payment_charge_attempt($1,$2,$3)`,
      [attemptId, s.practitionerId, `hone:session_payment:${attemptId}:v2:create`],
    );
    expect(claim.rows[0].result).toBe("claimed");

    const settler = await openAsUser(s.practitionerUserId);
    let settleResolved = false;
    const settlePromise = settler
      .query(`select * from public.record_appointment_settlement($1,$2,'paid_cash',4500,null,$3)`, [
        s.studioId,
        s.appointmentId,
        TEST_MODE,
      ])
      .then((r) => {
        settleResolved = true;
        return r;
      });

    await new Promise((r) => setTimeout(r, 400));
    expect(settleResolved).toBe(false);

    await claimer.query("commit");
    claimer.release();

    const settle = await settlePromise;
    // The claim advanced the attempt to pending_stripe, which is money in
    // flight, so the attestation is refused.
    expect(settle.rows[0].result).toBe("card_payment_exists");
    await settler.query("rollback");
    settler.release();

    expect(await liveRows(s.studioId)).toHaveLength(0);
  });

  it("PROOF 3 — two simultaneous settlements produce exactly one authoritative result", async () => {
    const s = await scenario();
    const [a, b] = await Promise.all([
      record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500),
      record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_e_transfer", 4500),
    ]);
    const results = [a.result, b.result].sort();
    expect(results).toEqual(["already_settled", "recorded"]);
    // Both callers are pointed at the record that actually holds the truth.
    expect(a.settlement_id).toBe(b.settlement_id);

    const rows = await liveRows(s.studioId);
    expect(rows).toHaveLength(1);
  });

  it("PROOF 4 — a replay returns the same business result and creates no second record", async () => {
    const s = await scenario();
    const first = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500);
    expect(first.result).toBe("recorded");

    // The same submission again — a double-click, a retried server action, a
    // resent POST. No idempotency token is supplied because none exists: the
    // natural key IS the idempotency key.
    const replay = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500);
    expect(replay.result).toBe("already_settled");
    expect(replay.settlement_id).toBe(first.settlement_id);

    expect(await liveRows(s.studioId)).toHaveLength(1);
  });
});

describe("0187 — a PREPARED card charge never dead-ends settlement", () => {
  const statusOf = async (id: string) =>
    (
      await adminQuery(`select status from public.payment_charge_attempts where id=$1`, [id])
    ).rows[0].status as string;

  const onlyAttempt = async (studioId: string) =>
    (
      await adminQuery(
        `select id from public.payment_charge_attempts where studio_id=$1`,
        [studioId],
      )
    ).rows[0].id as string;

  it("A · a ready attempt is retired, and the settlement records, in one call", async () => {
    const s = await scenario({ attempt: "ready" });
    const id = await onlyAttempt(s.studioId);

    const out = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE);
    expect(out.result).toBe("recorded");
    expect(await statusOf(id)).toBe("cancelled");
    expect(await liveRows(s.studioId)).toHaveLength(1);

    // A later card claim then meets the settlement, not the retired row.
    const claim = await adminQuery(
      `select result from public.claim_session_payment_charge_attempt($1,$2,$3)`,
      [id, s.practitionerId, `hone:session_payment:${id}:v2:create`],
    );
    expect(claim.rows[0].result).toBe("settled_externally");
  });

  it("A · every non-card outcome retires it — this is not a cash-only affordance", async () => {
    for (const method of ["paid_e_transfer", "paid_other_external", "still_owes"]) {
      const s = await scenario({ attempt: "ready" });
      const id = await onlyAttempt(s.studioId);
      expect(
        (await record(s.practitionerUserId, s.studioId, s.appointmentId, method, 4500, TEST_MODE)).result,
      ).toBe("recorded");
      expect(await statusOf(id)).toBe("cancelled");
    }
  });

  it("A · an owner waiver retires it too", async () => {
    const s = await scenario({ attempt: "ready" });
    const id = await onlyAttempt(s.studioId);
    expect((await waive(s.practitionerUserId, s.studioId, s.appointmentId)).result).toBe("recorded");
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("A · retirement writes ONLY the four cancellation columns", async () => {
    const s = await scenario({ attempt: "ready" });
    const id = await onlyAttempt(s.studioId);
    const before = (
      await adminQuery(
        `select amount_cents, currency, client_payment_method_id,
                card_authorization_signature_id, stripe_account_id,
                stripe_customer_id, stripe_payment_method_id, created_by_practitioner_id
           from public.payment_charge_attempts where id=$1`,
        [id],
      )
    ).rows[0];

    await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE);

    const after = (
      await adminQuery(
        `select amount_cents, currency, client_payment_method_id,
                card_authorization_signature_id, stripe_account_id,
                stripe_customer_id, stripe_payment_method_id, created_by_practitioner_id
           from public.payment_charge_attempts where id=$1`,
        [id],
      )
    ).rows[0];
    expect(after).toEqual(before);

    // And the row still EXISTS: a prepared-then-abandoned charge is history.
    const n = await adminQuery(
      `select count(*)::int n from public.payment_charge_attempts where studio_id=$1`,
      [s.studioId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("D · succeeded money is NEVER retired, and still refuses", async () => {
    const s = await scenario({ attempt: "succeeded" });
    const id = await onlyAttempt(s.studioId);
    expect(
      (await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE)).result,
    ).toBe("card_payment_exists");
    expect(await statusOf(id)).toBe("succeeded");
  });

  it("E · a fully refunded succeeded attempt is untouched, and still permits a replacement", async () => {
    const s = await scenario({ attempt: "succeeded" });
    const id = await onlyAttempt(s.studioId);
    await adminQuery(
      `update public.payment_charge_attempts
          set refund_status='succeeded', refund_amount_cents=amount_cents, refunded_at=now()
        where id=$1`,
      [id],
    );
    expect(
      (await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE)).result,
    ).toBe("recorded");
    // Still succeeded, still refunded: no history rewritten.
    const row = (
      await adminQuery(
        `select status, refund_status from public.payment_charge_attempts where id=$1`,
        [id],
      )
    ).rows[0];
    expect(row.status).toBe("succeeded");
    expect(row.refund_status).toBe("succeeded");
  });

  it("B · a claim that wins the lock is NOT retired; the settlement waits, then refuses", async () => {
    const s = await scenario({ attempt: "ready" });
    const id = await onlyAttempt(s.studioId);

    const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 4 });
    try {
      const claimer = await pool.connect();
      await claimer.query("begin");
      const claim = await claimer.query(
        `select result from public.claim_session_payment_charge_attempt($1,$2,$3)`,
        [id, s.practitionerId, `hone:session_payment:${id}:v2:create`],
      );
      expect(claim.rows[0].result).toBe("claimed");

      const settler = await pool.connect();
      await settler.query("begin");
      await settler.query("set local role authenticated");
      await settler.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: s.practitionerUserId, role: "authenticated" }),
      ]);
      let resolved = false;
      const settle = settler
        .query(`select * from public.record_appointment_settlement($1,$2,'paid_cash',4500,null,$3)`, [
          s.studioId,
          s.appointmentId,
          TEST_MODE,
        ])
        .then((r) => {
          resolved = true;
          return r;
        });

      await new Promise((r) => setTimeout(r, 400));
      expect(resolved).toBe(false); // blocked on the shared key

      await claimer.query("commit");
      claimer.release();

      const out = await settle;
      // The charge is IN FLIGHT at Stripe. It is not retired and not overridden.
      expect(out.rows[0].result).toBe("card_payment_exists");
      await settler.query("rollback");
      settler.release();

      expect(await statusOf(id)).toBe("pending_stripe");
      expect(await liveRows(s.studioId)).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });

  it("C · two simultaneous settlements retire the attempt ONCE and record ONCE", async () => {
    const s = await scenario({ attempt: "ready" });
    const id = await onlyAttempt(s.studioId);

    const [a, b] = await Promise.all([
      record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE),
      record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_e_transfer", 4500, TEST_MODE),
    ]);
    expect([a.result, b.result].sort()).toEqual(["already_settled", "recorded"]);
    expect(a.settlement_id).toBe(b.settlement_id);
    expect(await liveRows(s.studioId)).toHaveLength(1);

    // Cancelled once, by one actor, with one timestamp.
    const row = (
      await adminQuery(
        `select status, cancelled_at, cancelled_by_practitioner_id
           from public.payment_charge_attempts where id=$1`,
        [id],
      )
    ).rows[0];
    expect(row.status).toBe("cancelled");
    expect(row.cancelled_at).not.toBeNull();
    expect(row.cancelled_by_practitioner_id).toBe(s.practitionerId);

    // Replay returns the existing truth and retires nothing further.
    const replay = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE);
    expect(replay.result).toBe("already_settled");
    expect(replay.settlement_id).toBe(a.settlement_id);
    expect(await liveRows(s.studioId)).toHaveLength(1);
  });
});

describe("0187 — A REFUSED SETTLEMENT MUTATES ZERO ATTEMPT ROWS", () => {
  // THE ORDERING LAW. A refusal below is a plain `return query` — a normal
  // return, which COMMITS — so retiring first and refusing afterwards silently
  // cancelled a practitioner's prepared charge and then told her the settlement
  // could not be recorded. Every case here proves the ready row survives.
  const statusOf = async (id: string) =>
    (await adminQuery(`select status from public.payment_charge_attempts where id=$1`, [id]))
      .rows[0].status as string;

  /** A second attempt on a SECOND session of the same appointment. The active
   *  uniqueness index is (session_id, stripe_livemode), so this is legal. */
  async function secondAttempt(s: PaymentScenario, status: string): Promise<string> {
    const sessionId = randomUUID();
    const id = randomUUID();
    await adminQuery(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, appointment_id)
       values ($1,$2,$3,$4,'electrolysis',$5)`,
      [sessionId, s.studioId, s.clientId, s.practitionerId, s.appointmentId],
    );
    await adminQuery(
      `insert into public.payment_charge_attempts
         (id, studio_id, charge_reason, client_id, session_id, appointment_id,
          created_by_practitioner_id, amount_cents, currency, status, stripe_livemode,
          client_payment_method_id, card_authorization_signature_id,
          stripe_payment_intent_id, charged_at)
       select $1::uuid, studio_id, charge_reason, client_id, $2::uuid, appointment_id,
              created_by_practitioner_id, amount_cents, currency, $3::text, stripe_livemode,
              client_payment_method_id, card_authorization_signature_id,
              case when $3::text in ('pending_stripe','succeeded')
                   then 'pi_x_' || left($1::text, 8) end,
              case when $3::text = 'succeeded' then now() end
         from public.payment_charge_attempts where studio_id = $4::uuid limit 1`,
      [id, sessionId, status, s.studioId],
    );
    return id;
  }

  it("A · ready + nothing blocking -> records, and the ready row IS retired", async () => {
    const s = await scenario({ attempt: "ready" });
    const ready = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;
    expect(
      (await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE)).result,
    ).toBe("recorded");
    expect(await statusOf(ready)).toBe("cancelled");
  });

  it("B · ready + an existing live settlement -> already_settled, READY UNTOUCHED", async () => {
    const s = await scenario({ attempt: "ready" });
    expect(
      (await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE)).result,
    ).toBe("recorded");
    // A charge prepared AFTERWARDS, e.g. in another tab.
    const ready = await secondAttempt(s, "ready");

    const out = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_e_transfer", 4500, TEST_MODE);
    expect(out.result).toBe("already_settled");
    expect(await statusOf(ready)).toBe("ready");
  });

  it("C · ready + pending_stripe -> card_payment_exists, BOTH rows untouched", async () => {
    const s = await scenario({ attempt: "ready" });
    const ready = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;
    const pending = await secondAttempt(s, "pending_stripe");

    const out = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE);
    expect(out.result).toBe("card_payment_exists");
    expect(await statusOf(ready)).toBe("ready");
    expect(await statusOf(pending)).toBe("pending_stripe");
    expect(await liveRows(s.studioId)).toHaveLength(0);
  });

  it("D · ready + succeeded retained money -> card_payment_exists, BOTH rows untouched", async () => {
    const s = await scenario({ attempt: "ready" });
    const ready = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;
    const succeeded = await secondAttempt(s, "succeeded");

    const out = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE);
    expect(out.result).toBe("card_payment_exists");
    expect(await statusOf(ready)).toBe("ready");
    const row = (
      await adminQuery(
        `select status, charged_at, stripe_payment_intent_id
           from public.payment_charge_attempts where id=$1`,
        [succeeded],
      )
    ).rows[0];
    expect(row.status).toBe("succeeded");
    expect(row.charged_at).not.toBeNull();
  });

  it("D · a waiver refused for the same reason also leaves the ready row alone", async () => {
    const s = await scenario({ attempt: "ready" });
    const ready = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;
    await secondAttempt(s, "succeeded");
    // TEST_MODE, because the seeded attempts are test-mode rows: in a LIVE
    // deployment test money is deliberately ignored (the asymmetric rule).
    expect(
      (await waive(s.practitionerUserId, s.studioId, s.appointmentId, 4500, TEST_MODE)).result,
    ).toBe("card_payment_exists");
    expect(await statusOf(ready)).toBe("ready");
  });

  it("E · ready + an out-of-range service price -> closed refusal, READY UNTOUCHED", async () => {
    const s = await scenario({ attempt: "ready" });
    const ready = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;
    // A service the studio priced above what a settlement snapshot can hold.
    // services.price_cents is bounded only by >= 0.
    const svc = randomUUID();
    await adminQuery(
      `insert into public.services (id, studio_id, name, price_cents) values ($1,$2,$3,250000)`,
      [svc, s.studioId, `Expensive ${svc.slice(0, 8)}`],
    );
    await adminQuery(`update public.appointments set service_id=$2 where id=$1`, [
      s.appointmentId,
      svc,
    ]);

    const out = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE);
    expect(out.result).toBe("invalid_input");
    expect(await statusOf(ready)).toBe("ready");
    expect(await liveRows(s.studioId)).toHaveLength(0);
  });

  it("F · a replay after success returns already_settled and cancels nothing further", async () => {
    const s = await scenario({ attempt: "ready" });
    const first = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;
    await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE);
    expect(await statusOf(first)).toBe("cancelled");
    const cancelledAt = (
      await adminQuery(`select cancelled_at from public.payment_charge_attempts where id=$1`, [first])
    ).rows[0].cancelled_at;

    // A charge prepared after the settlement, then a replayed submission.
    const later = await secondAttempt(s, "ready");
    const replay = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE);
    expect(replay.result).toBe("already_settled");
    // The later attempt is NOT collateral damage, and the first cancellation is
    // not re-stamped.
    expect(await statusOf(later)).toBe("ready");
    expect(
      (await adminQuery(`select cancelled_at from public.payment_charge_attempts where id=$1`, [first]))
        .rows[0].cancelled_at,
    ).toEqual(cancelledAt);
  });

  it("G · if the settlement write raises, the retirement rolls back with it", async () => {
    const s = await scenario({ attempt: "ready" });
    const ready = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;

    // Driven through a transaction the test aborts after the command returns,
    // which is exactly what a raise inside the insert would do.
    const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 2 });
    try {
      const c = await pool.connect();
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: s.practitionerUserId, role: "authenticated" }),
      ]);
      const r = await c.query(
        `select * from public.record_appointment_settlement($1,$2,'paid_cash',4500,null,$3)`,
        [s.studioId, s.appointmentId, TEST_MODE],
      );
      expect(r.rows[0].result).toBe("recorded");
      // Inside the transaction the row is retired...
      expect(
        (await c.query(`select status from public.payment_charge_attempts where id=$1`, [ready]))
          .rows[0].status,
      ).toBe("cancelled");
      await c.query("rollback");
      c.release();
    } finally {
      await pool.end();
    }

    // ...and outside it, nothing happened at all. Retirement and settlement are
    // one atom.
    expect(await statusOf(ready)).toBe("ready");
    expect(await liveRows(s.studioId)).toHaveLength(0);
  });

  it("a ready row carrying EXECUTION EVIDENCE is never retired — fail closed", async () => {
    const s = await scenario({ attempt: "ready" });
    const ready = (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [s.studioId])
    ).rows[0].id as string;
    // Something reached Stripe and the row has not caught up. Erasing this is
    // the one thing worse than blocking.
    await adminQuery(
      `update public.payment_charge_attempts set stripe_payment_intent_id='pi_evidence' where id=$1`,
      [ready],
    );

    const out = await record(s.practitionerUserId, s.studioId, s.appointmentId, "paid_cash", 4500, TEST_MODE);
    expect(out.result).toBe("card_payment_exists");
    expect(await statusOf(ready)).toBe("ready");
    expect(
      (await adminQuery(
        `select stripe_payment_intent_id from public.payment_charge_attempts where id=$1`,
        [ready],
      )).rows[0].stripe_payment_intent_id,
    ).toBe("pi_evidence");
  });
});

describe("0187 — THE WEBHOOK IS THE THIRD PARTY TO THE LOCK", () => {
  // The webhook used to move `ready` straight to `succeeded` with no lock, and
  // it is the ONLY writer that turns a retirable state into money. Both
  // orderings below were broken before it took the key: one double-collected,
  // the other lost a real Stripe success to an ops alert.
  const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 6 });
  afterAll(async () => {
    await pool.end();
  });

  const attemptOf = async (studioId: string) =>
    (
      await adminQuery(`select id from public.payment_charge_attempts where studio_id=$1`, [
        studioId,
      ])
    ).rows[0].id as string;

  const rowOf = async (id: string) =>
    (
      await adminQuery(
        `select status, charged_at, stripe_payment_intent_id
           from public.payment_charge_attempts where id=$1`,
        [id],
      )
    ).rows[0] as { status: string; charged_at: string | null; stripe_payment_intent_id: string | null };

  const reconcile = (id: string) =>
    adminQuery(
      `select * from public.reconcile_card_payment_succeeded($1,$2,$3)`,
      [id, `pi_wh_${randomUUID().slice(0, 12)}`, `ch_wh_${randomUUID().slice(0, 12)}`],
    );

  it("with no settlement, reconciliation still works exactly as before", async () => {
    const s = await scenario({ attempt: "ready" });
    const id = await attemptOf(s.studioId);
    const r = await reconcile(id);
    expect(r.rows[0].result).toBe("reconciled");
    const row = await rowOf(id);
    expect(row.status).toBe("succeeded");
    expect(row.charged_at).not.toBeNull();
    expect(row.stripe_payment_intent_id).toContain("pi_wh_");
  });

  it("ORDERING 1 — settlement holds the key; the webhook waits, then REFUSES", async () => {
    // The double-collection ordering. Before the mutex, the webhook read a
    // ready row, the settlement committed, and the webhook flipped it to
    // succeeded anyway — leaving card money AND a live cash record.
    const s = await scenario({ attempt: "ready" });
    const id = await attemptOf(s.studioId);

    const settler = await pool.connect();
    await settler.query("begin");
    await settler.query("set local role authenticated");
    await settler.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: s.practitionerUserId, role: "authenticated" }),
    ]);
    const settled = await settler.query(
      `select * from public.record_appointment_settlement($1,$2,'paid_cash',4500,null,$3)`,
      [s.studioId, s.appointmentId, TEST_MODE],
    );
    expect(settled.rows[0].result).toBe("recorded");

    const hook = await pool.connect();
    await hook.query("begin");
    let done = false;
    const hookPromise = hook
      .query(`select * from public.reconcile_card_payment_succeeded($1,$2,$3)`, [
        id,
        `pi_race1_${randomUUID().slice(0, 12)}`,
        `ch_race1_${randomUUID().slice(0, 12)}`,
      ])
      .then((r) => {
        done = true;
        return r;
      });

    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false); // genuinely blocked on the shared key

    await settler.query("commit");
    settler.release();

    const out = await hookPromise;
    // It sees the committed settlement and refuses to create money beside it.
    expect(out.rows[0].result).toBe("settled_externally_conflict");
    await hook.query("commit");
    hook.release();

    // NO DOUBLE COLLECTION: the attempt was retired by the settlement and was
    // never flipped to succeeded.
    const row = await rowOf(id);
    expect(row.status).toBe("cancelled");
    expect(row.charged_at).toBeNull();
    const live = await liveRows(s.studioId);
    expect(live).toHaveLength(1);
    expect(live[0].method).toBe("paid_cash");
  });

  it("ORDERING 2 — the webhook holds the key; the settlement waits, then refuses", async () => {
    // The lost-success ordering. Before the mutex, the settlement could retire
    // the row out from under a real Stripe success.
    const s = await scenario({ attempt: "ready" });
    const id = await attemptOf(s.studioId);

    const hook = await pool.connect();
    await hook.query("begin");
    const rec = await hook.query(
      `select * from public.reconcile_card_payment_succeeded($1,$2,$3)`,
      [id, `pi_race2_${randomUUID().slice(0, 12)}`, `ch_race2_${randomUUID().slice(0, 12)}`],
    );
    expect(rec.rows[0].result).toBe("reconciled");

    const settler = await pool.connect();
    await settler.query("begin");
    await settler.query("set local role authenticated");
    await settler.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: s.practitionerUserId, role: "authenticated" }),
    ]);
    let done = false;
    const settlePromise = settler
      .query(`select * from public.record_appointment_settlement($1,$2,'paid_cash',4500,null,$3)`, [
        s.studioId,
        s.appointmentId,
        TEST_MODE,
      ])
      .then((r) => {
        done = true;
        return r;
      });

    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);

    await hook.query("commit");
    hook.release();

    const out = await settlePromise;
    // Real money moved. The attestation is refused rather than recorded beside
    // it, and the succeeded row is NOT retired.
    expect(out.rows[0].result).toBe("card_payment_exists");
    await settler.query("commit");
    settler.release();

    const row = await rowOf(id);
    expect(row.status).toBe("succeeded");
    expect(row.charged_at).not.toBeNull();
    expect(await liveRows(s.studioId)).toHaveLength(0);
  });

  it("a waived visit also refuses the webhook rather than being silently charged", async () => {
    const s = await scenario({ attempt: "ready" });
    const id = await attemptOf(s.studioId);
    expect(
      (await waive(s.practitionerUserId, s.studioId, s.appointmentId, 4500, TEST_MODE)).result,
    ).toBe("recorded");
    const r = await reconcile(id);
    expect(r.rows[0].result).toBe("settled_externally_conflict");
    expect((await rowOf(id)).status).toBe("cancelled");
  });

  it("still_owes does NOT block reconciliation — the debt was simply paid by card", async () => {
    const s = await scenario({ attempt: "ready" });
    const id = await attemptOf(s.studioId);
    await record(s.practitionerUserId, s.studioId, s.appointmentId, "still_owes", 4500, TEST_MODE);
    // The settlement retired the prepared attempt, so this one is terminal.
    expect((await reconcile(id)).rows[0].result).toBe("terminal_mismatch");

    // A charge prepared AFTER the debt was recorded reconciles normally.
    const later = randomUUID();
    await adminQuery(
      `insert into public.payment_charge_attempts
         (id, studio_id, charge_reason, client_id, session_id, appointment_id,
          created_by_practitioner_id, amount_cents, currency, status, stripe_livemode,
          client_payment_method_id, card_authorization_signature_id)
       select $1::uuid, studio_id, charge_reason, client_id, session_id, appointment_id,
              created_by_practitioner_id, amount_cents, currency, 'ready', stripe_livemode,
              client_payment_method_id, card_authorization_signature_id
         from public.payment_charge_attempts where id = $2::uuid`,
      [later, id],
    );
    expect((await reconcile(later)).rows[0].result).toBe("reconciled");
  });

  it("a terminal row is never flipped, and an already-succeeded one is idempotent", async () => {
    const cancelled = await scenario({ attempt: "ready" });
    const cid = await attemptOf(cancelled.studioId);
    await adminQuery(
      `update public.payment_charge_attempts set status='cancelled', cancelled_at=now(),
              cancelled_by_practitioner_id=$2, cancelled_reason='x' where id=$1`,
      [cid, cancelled.practitionerId],
    );
    expect((await reconcile(cid)).rows[0].result).toBe("terminal_mismatch");
    expect((await rowOf(cid)).status).toBe("cancelled");

    const done = await scenario({ attempt: "succeeded" });
    const did = await attemptOf(done.studioId);
    expect((await reconcile(did)).rows[0].result).toBe("already_succeeded");
  });

  it("neither anon nor authenticated may reconcile — it is the writer that makes money", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const r = await asRole(role, (q) =>
        q(
          `select has_function_privilege('reconcile_card_payment_succeeded(uuid,text,text)','execute') x`,
        ),
      );
      expect(r.rows[0].x).toBe(false);
    }
    const svc = await asRole("service_role", (q) =>
      q(
        `select has_function_privilege('reconcile_card_payment_succeeded(uuid,text,text)','execute') x`,
      ),
    );
    // 0239 closes the historical unbound service API; postgres-only historical
    // mutex tests above intentionally still exercise its private implementation.
    expect(svc.rows[0].x).toBe(false);
    const bound = await asRole("service_role", (q) => q(
      "select has_function_privilege('reconcile_bound_payment_event(uuid,text,text,uuid,text,boolean,jsonb)','execute') x",
    ));
    expect(bound.rows[0].x).toBe(true);
  });

  it("CENSUS — every writer that can create card money holds the shared key", async () => {
    // The mutex is only as good as its completeness. Any function that moves an
    // attempt INTO 'succeeded' must take the appointment key; if a new one
    // appears without it, the window reopens silently.
    const r = await adminQuery(
      `select p.proname, pg_get_functiondef(p.oid) def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind = 'f'
          and p.prosrc ilike '%payment_charge_attempts%'
          and p.prosrc ilike '%succeeded%'`,
    );
    const makesMoney = (r.rows as Array<{ proname: string; def: string }>).filter((f) =>
      /set\s+status\s*=\s*'succeeded'|status\s*=\s*'succeeded'\s*,/.test(f.def),
    );
    expect(makesMoney.length).toBeGreaterThan(0);
    for (const f of makesMoney) {
      expect(f.def).toContain("appointment_settlement_lock_key");
    }
  });
});

describe("0187 — privileges", () => {
  it("anon and service_role hold no EXECUTE on any settlement command", async () => {
    for (const role of ["anon", "service_role"] as const) {
      const r = await asRole(role, (q) =>
        q(
          `select
             has_function_privilege('record_appointment_settlement(uuid,uuid,text,integer,text,boolean)','execute') a,
             has_function_privilege('waive_appointment_fee(uuid,uuid,integer,text,boolean)','execute') b,
             has_function_privilege('supersede_appointment_settlement(uuid,uuid,text,integer,text,text,boolean)','execute') c,
             has_function_privilege('appointment_quoted_amount_cents(uuid,uuid)','execute') d,
             has_function_privilege('retire_ready_card_attempts(uuid,uuid,uuid)','execute') e`,
        ),
      );
      expect([r.rows[0].a, r.rows[0].b, r.rows[0].c, r.rows[0].d, r.rows[0].e]).toEqual([
        false, false, false, false, false,
      ]);
    }
  });

  it("authenticated holds SELECT and nothing else on the table", async () => {
    const r = await adminQuery(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_name='appointment_settlements' and grantee in ('anon','authenticated','service_role')`,
    );
    expect(r.rows).toEqual([{ grantee: "authenticated", privilege_type: "SELECT" }]);
  });

  it("a practitioner cannot read another studio's settlements", async () => {
    const a = await scenario();
    const b = await scenario();
    await record(b.practitionerUserId, b.studioId, b.appointmentId, "paid_cash");

    const seen = await asUser(a.practitionerUserId, (q) =>
      q(`select count(*)::int n from public.appointment_settlements`),
    );
    expect(seen.rows[0].n).toBe(0);
  });
});

// PAY-001 / 0239: new service entry point binds event facts under the same mutex.
// The historical postgres-only 0187 races above continue to prove that mutex.
describe("0239 — bound signed payment event command", () => {
  async function prepared() {
    const s = await scenario({ attempt: "ready" });
    const pi = `pi_bound_${randomUUID()}`;
    await adminQuery(`update public.payment_charge_attempts a
      set stripe_account_id=m.stripe_account_id,stripe_customer_id=m.stripe_customer_id,
          stripe_payment_intent_id=$2
      from public.client_payment_methods m
      where a.studio_id=$1 and m.id=a.client_payment_method_id`, [s.studioId, pi]);
    const row = (await adminQuery(`select * from public.payment_charge_attempts where studio_id=$1`, [s.studioId])).rows[0];
    expect(row.stripe_account_id).toBeTruthy();
    expect(row.stripe_customer_id).toBeTruthy();
    const object = {
      customer_id: row.stripe_customer_id, payment_intent_id: pi,
      charge_id: `ch_bound_${randomUUID()}`, amount_cents: row.amount_cents, currency: row.currency,
      evidence_kind: "signed_event", event_created: 100,
    };
    return { s, row, object };
  }
  async function bound(p: Awaited<ReturnType<typeof prepared>>, overrides: Record<string, unknown> = {}, type = "payment_intent.succeeded", scope: { studio?: string; account?: string; mode?: boolean; eventId?: string } = {}) {
    return adminQuery(`select * from public.reconcile_bound_payment_event($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
      p.row.id, scope.eventId ?? `evt_bound_${randomUUID()}`, type, scope.studio ?? p.row.studio_id,
      scope.account ?? p.row.stripe_account_id, scope.mode ?? p.row.stripe_livemode,
      JSON.stringify({ ...p.object, ...overrides }),
    ]);
  }
  it.each(["studio", "account", "mode", "customer", "intent", "amount", "currency"])("refuses mismatching %s without creating card money", async (key) => {
    const p = await prepared();
    const scope = key === "studio" ? { studio: randomUUID() } : key === "account" ? { account: "acct_other" } : key === "mode" ? { mode: true } : {};
    const payload = key === "customer" ? { customer_id: "cus_other" } : key === "intent" ? { payment_intent_id: "pi_other" } : key === "amount" ? { amount_cents: p.row.amount_cents + 1 } : key === "currency" ? { currency: "usd" } : {};
    expect((await bound(p, payload, "payment_intent.succeeded", scope)).rows[0].result).toBe("identity_mismatch");
    const after = (await adminQuery("select status,charged_at,stripe_charge_id from public.payment_charge_attempts where id=$1", [p.row.id])).rows[0];
    expect(after).toEqual({ status: "ready", charged_at: null, stripe_charge_id: null });
  });
  it("does not invent missing original provider identity from metadata", async () => {
    const p = await prepared();
    await adminQuery("update public.payment_charge_attempts set stripe_payment_intent_id=null where id=$1", [p.row.id]);
    expect((await bound(p)).rows[0].result).toBe("identity_mismatch");
  });
  it("matches, deduplicates, and refuses a substituted charge", async () => {
    const p = await prepared();
    expect((await bound(p)).rows[0].result).toBe("reconciled");
    expect((await bound(p)).rows[0].result).toBe("already_succeeded");
    expect((await bound(p, { charge_id: "ch_other" })).rows[0].result).toBe("identity_mismatch");
    expect((await bound(p, {}, "payment_intent.payment_failed")).rows[0].result).toBe("local_succeeded_mismatch");
    expect((await adminQuery("select status,stripe_charge_id from public.payment_charge_attempts where id=$1", [p.row.id])).rows[0])
      .toEqual({ status: "succeeded", stripe_charge_id: p.object.charge_id });
  });
  it("does not resurrect a terminal failed attempt with an older success", async () => {
    const p = await prepared();
    expect((await bound(p, { failure_code: "card_declined" }, "payment_intent.payment_failed")).rows[0].result).toBe("reconciled");
    expect((await bound(p)).rows[0].result).toBe("terminal_mismatch");
  });
  it("requires the actual refund's identity, amount, currency and succeeded status", async () => {
    const p = await prepared();
    await bound(p);
    const refund = { refund_id: `re_bound_${randomUUID()}`, refund_amount_cents: p.row.amount_cents,
      refund_currency: p.row.currency, refund_charge_id: p.object.charge_id, refund_status: "succeeded" };
    for (const patch of [{ refund_charge_id: "ch_other" }, { refund_amount_cents: 1 }, { refund_currency: "usd" }]) {
      expect((await bound(p, { ...refund, ...patch }, "charge.refunded")).rows[0].result).toBe("refund_evidence_refused");
    }
    expect((await bound(p, refund, "charge.refunded")).rows[0].result).toBe("reconciled");
    expect((await bound(p, refund, "charge.refunded")).rows[0].result).toBe("already_refunded");
    expect((await bound(p, { ...refund, refund_status: "pending" }, "charge.refunded")).rows[0].result).toBe("stale_observation");
    expect((await adminQuery("select refund_status,stripe_refund_id from public.payment_charge_attempts where id=$1", [p.row.id])).rows[0])
      .toEqual({ refund_status: "succeeded", stripe_refund_id: refund.refund_id });
  });
  it("0240 preserves pending action evidence then accepts a newer signed completion without regression", async () => {
    const p = await prepared();
    await bound(p);
    const refund = { refund_id: `re_status_${randomUUID()}`, refund_amount_cents: p.row.amount_cents,
      refund_currency: p.row.currency, refund_charge_id: p.object.charge_id, refund_status: "pending" };
    expect((await bound(p, { ...refund, evidence_kind: "action_response", event_created: null }, "refund.observed")).rows[0].result).toBe("refund_pending");
    const read = async () => (await adminQuery(`select refund_status,stripe_refund_status,stripe_refund_id,refunded_at,
      stripe_refund_event_created,stripe_refund_event_id from public.payment_charge_attempts where id=$1`, [p.row.id])).rows[0];
    expect(await read()).toMatchObject({ refund_status: "pending_stripe", stripe_refund_status: "pending",
      stripe_refund_id: refund.refund_id, refunded_at: null, stripe_refund_event_created: null, stripe_refund_event_id: null });
    expect((await bound(p, { ...refund, refund_status: "requires_action", event_created: 200 }, "refund.updated")).rows[0].result).toBe("refund_pending");
    expect((await read()).stripe_refund_status).toBe("requires_action");
    const eventId = `evt_final_${randomUUID()}`;
    expect((await bound(p, { ...refund, refund_status: "succeeded", event_created: 201 }, "refund.updated", { eventId })).rows[0].result).toBe("reconciled");
    const completed = await read();
    expect(completed.refund_status).toBe("succeeded");
    expect(completed.stripe_refund_status).toBe("succeeded");
    expect(completed.refunded_at).not.toBeNull();
    expect((await bound(p, { ...refund, event_created: 199 }, "refund.updated")).rows[0].result).toBe("stale_observation");
    expect((await bound(p, { ...refund, evidence_kind: "action_response", event_created: null }, "refund.observed")).rows[0].result).toBe("stale_observation");
    expect((await bound(p, { ...refund, refund_status: "succeeded", event_created: 201 }, "refund.updated", { eventId })).rows[0].result).toBe("already_refunded");
    expect(await read()).toEqual(completed);
  });
  it.each(["failed", "canceled"])("0240 records terminal %s distinctly and refuses an older pending or conflicting success", async (status) => {
    const p = await prepared();
    await bound(p);
    const refund = { refund_id: `re_failed_${randomUUID()}`, refund_amount_cents: p.row.amount_cents,
      refund_currency: p.row.currency, refund_charge_id: p.object.charge_id, refund_status: status, event_created: 300 };
    expect((await bound(p, refund, "refund.updated")).rows[0].result).toBe("refund_failed");
    expect((await adminQuery("select refund_status,stripe_refund_status,refunded_at from public.payment_charge_attempts where id=$1", [p.row.id])).rows[0])
      .toEqual({ refund_status: "failed", stripe_refund_status: status, refunded_at: null });
    expect((await bound(p, { ...refund, refund_status: "pending", event_created: 299 }, "refund.updated")).rows[0].result).toBe("stale_observation");
    expect((await bound(p, { ...refund, refund_status: "succeeded", event_created: 301 }, "refund.updated")).rows[0].result).toBe("terminal_refund_mismatch");
  });
  it("0240 rejects unrecognized signed statuses without erasing nullable legacy evidence", async () => {
    const p = await prepared();
    await bound(p);
    expect((await adminQuery("select stripe_refund_status from public.payment_charge_attempts where id=$1", [p.row.id])).rows[0].stripe_refund_status).toBeNull();
    const refund = { refund_id: `re_unknown_${randomUUID()}`, refund_amount_cents: p.row.amount_cents,
      refund_currency: p.row.currency, refund_charge_id: p.object.charge_id, refund_status: "made_up", event_created: 300 };
    expect((await bound(p, refund, "refund.updated")).rows[0].result).toBe("refund_evidence_refused");
    expect((await adminQuery("select refund_status,stripe_refund_status,refunded_at from public.payment_charge_attempts where id=$1", [p.row.id])).rows[0])
      .toEqual({ refund_status: null, stripe_refund_status: null, refunded_at: null });
  });

  it.each(["failed", "canceled"])("recorded provider %s evidence cannot be erased by the action retry claim", async (status) => {
    const p = await prepared();
    await bound(p);
    const refund = { refund_id: `re_claim_${randomUUID()}`, refund_amount_cents: p.row.amount_cents,
      refund_currency: p.row.currency, refund_charge_id: p.object.charge_id, refund_status: status, event_created: 400 };
    expect((await bound(p, refund, "refund.updated")).rows[0].result).toBe("refund_failed");
    const read = async () => (await adminQuery(`select refund_status,stripe_refund_id,stripe_refund_status,
      stripe_refund_event_created,stripe_refund_event_id from public.payment_charge_attempts where id=$1`, [p.row.id])).rows[0];
    const before = await read();
    const claim = await adminQuery(`update public.payment_charge_attempts set refund_status='pending_stripe',stripe_refund_id=null
      where id=$1 and studio_id=$2 and status='succeeded' and stripe_livemode=false
        and (refund_status is null or refund_status='failed')
        and (receipt_status is null or receipt_status in ('sent','failed'))
        and stripe_refund_id is null and stripe_refund_status is null
        and stripe_refund_event_created is null and stripe_refund_event_id is null returning id`, [p.row.id, p.s.studioId]);
    expect(claim.rows).toEqual([]);
    expect(await read()).toEqual(before);
  });


  // 0240 cumulative SOURCE ONLY: no local DB authority or execution implied.
  function cumulative(p: Awaited<ReturnType<typeof prepared>>) {
    const first = Math.floor(p.row.amount_cents / 2);
    const component = (amount: number) => ({ object_type: "refund", refund_id: `re_part_${randomUUID()}`,
      amount_cents: amount, currency: p.row.currency, refund_status: "succeeded",
      charge_id: p.object.charge_id, payment_intent_id: p.object.payment_intent_id,
      customer_present: false, customer_id: null });
    return { evidence_kind: "signed_event", event_created: 600, refund_id: null,
      charge_object_type: "charge", charge_status: "succeeded", charge_paid: true, charge_captured: true,
      charge_amount_captured: p.row.amount_cents, charge_livemode: p.row.stripe_livemode,
      charge_refunded: true, charge_amount_refunded: p.row.amount_cents, charge_refund_list_complete: true,
      charge_refund_components: [component(first), component(p.row.amount_cents - first)] };
  }
  async function readCumulative(p: Awaited<ReturnType<typeof prepared>>) {
    return (await adminQuery(`select refund_status,refund_amount_cents,refunded_at,stripe_refund_id,
      stripe_refund_status,stripe_refund_event_id,stripe_refund_event_created,
      stripe_charge_refund_event_id,stripe_charge_refund_event_created
      from public.payment_charge_attempts where id=$1`, [p.row.id])).rows[0];
  }
  it("0240 two succeeded partial objects establish full charge truth without one fabricated full Refund", async () => {
    const p = await prepared(); await bound(p);
    const evidence = cumulative(p);
    expect((await bound(p, evidence, "charge.refunded")).rows[0].result).toBe("reconciled");
    expect(await readCumulative(p)).toMatchObject({ refund_status: "succeeded", refund_amount_cents: p.row.amount_cents,
      stripe_refund_id: null, stripe_refund_status: null, stripe_refund_event_id: null,
      stripe_charge_refund_event_created: "600" });
    expect((await readCumulative(p)).refunded_at).not.toBeNull();
  });
  it.each(["failed", "succeeded"])("0240 prior actual single %s identity does not block or get rewritten by cumulative full truth", async (status) => {
    const p = await prepared(); await bound(p);
    const actual = { refund_id: `re_actual_${randomUUID()}`, refund_amount_cents: p.row.amount_cents,
      refund_currency: p.row.currency, refund_charge_id: p.object.charge_id, refund_status: status, event_created: 500 };
    await bound(p, actual, "refund.updated");
    const before = await readCumulative(p);
    await bound(p, cumulative(p), "charge.refunded");
    const after = await readCumulative(p);
    expect(after.refund_status).toBe("succeeded");
    for (const key of ["stripe_refund_id", "stripe_refund_status", "stripe_refund_event_id", "stripe_refund_event_created"]) {
      expect(after[key]).toEqual(before[key]);
    }
  });
  it("0240 duplicate/older/sameclock aggregate and later pending/failed/action events cannot regress cumulative full", async () => {
    const p = await prepared(); await bound(p);
    const evidence = cumulative(p); const eventId = `evt_cumulative_${randomUUID()}`;
    await bound(p, evidence, "charge.refunded", { eventId });
    const before = await readCumulative(p);
    expect((await bound(p, evidence, "charge.refunded", { eventId })).rows[0].result).toBe("already_refunded");
    expect((await bound(p, { ...evidence, event_created: 599 }, "charge.refunded")).rows[0].result).toBe("stale_observation");
    await bound(p, evidence, "charge.refunded");
    for (const status of ["pending", "failed", "canceled", "succeeded"]) {
      const single = { refund_id: `re_late_${randomUUID()}`, refund_amount_cents: p.row.amount_cents,
        refund_currency: p.row.currency, refund_charge_id: p.object.charge_id, refund_status: status, event_created: 700 };
      expect((await bound(p, single, "refund.updated")).rows[0].result).toBe("already_refunded");
      expect((await bound(p, { ...single, evidence_kind: "action_response", event_created: null }, "refund.observed")).rows[0].result).toBe("already_refunded");
    }
    expect(await readCumulative(p)).toEqual(before);
  });
  it("0240 rejects duplicate, wrong-bound, unsafe and nonterminal components without local completion", async () => {
    const p = await prepared(); await bound(p); const evidence = cumulative(p);
    const before = await readCumulative(p);
    const parts = evidence.charge_refund_components;
    const mutations = [
      { refund_id: parts[1].refund_id }, { charge_id: "ch_other" }, { payment_intent_id: "pi_other" },
      { currency: "usd" }, { customer_present: true, customer_id: "cus_other" },
      { amount_cents: 9007199254740992 }, { amount_cents: 0 }, { amount_cents: parts[0].amount_cents + 1 },
      { refund_status: "pending" }, { refund_status: "requires_action" }, { refund_status: "unknown" },
    ];
    // Use a genuinely different currency even if fixture setup changes later.
    mutations[3] = { currency: p.row.currency === "usd" ? "cad" : "usd" };
    for (const patch of mutations) {
      expect((await bound(p, { ...evidence, charge_refund_components: [{ ...parts[0], ...patch }, parts[1]] }, "charge.refunded")).rows[0].result).toBe("refund_evidence_refused");
      expect(await readCumulative(p)).toEqual(before);
    }
  });
  it("0240 refuses absent/truncated list and unproven captured/signed charge context", async () => {
    const p = await prepared(); await bound(p); const evidence = cumulative(p);
    for (const patch of [{ charge_refund_list_complete: false }, { charge_refund_components: null },
      { charge_refund_components: [] }, { evidence_kind: "action_response" }, { event_created: null },
      { charge_paid: false }, { charge_captured: false }, { charge_amount_captured: p.row.amount_cents - 1 },
      { charge_livemode: !p.row.stripe_livemode }]) {
      expect((await bound(p, { ...evidence, ...patch }, "charge.refunded")).rows[0].result).toBe("refund_evidence_refused");
    }
    expect((await readCumulative(p)).refund_status).toBeNull();
  });
  it("0240 cumulative evidence cannot bypass original account/studio/mode identity", async () => {
    const p = await prepared(); await bound(p);
    for (const scope of [{ studio: randomUUID() }, { account: "acct_other" }, { mode: !p.row.stripe_livemode }]) {
      expect((await bound(p, cumulative(p), "charge.refunded", scope)).rows[0].result).toBe("identity_mismatch");
    }
    expect((await readCumulative(p)).refund_status).toBeNull();
  });
  it("0240 concurrent single failure and cumulative completion serialize without losing aggregate truth", async () => {
    const p = await prepared(); await bound(p);
    await Promise.all([
      bound(p, { refund_id: `re_failed_${randomUUID()}`, refund_amount_cents: p.row.amount_cents,
        refund_currency: p.row.currency, refund_charge_id: p.object.charge_id, refund_status: "failed", event_created: 700 }, "refund.updated"),
      bound(p, cumulative(p), "charge.refunded"),
    ]);
    expect(await readCumulative(p)).toMatchObject({ refund_status: "succeeded", refund_amount_cents: p.row.amount_cents });
  });
  it("0240 transaction rollback retains prior actual-object and local refund truth", async () => {
    const p = await prepared(); await bound(p); const before = await readCumulative(p);
    await expect(adminTx(async (query) => {
      await query(`select * from public.reconcile_bound_payment_event($1,$2,'charge.refunded',$3,$4,$5,$6::jsonb)`,
        [p.row.id, `evt_rollback_${randomUUID()}`, p.row.studio_id, p.row.stripe_account_id,
          p.row.stripe_livemode, JSON.stringify({ ...p.object, ...cumulative(p) })]);
      throw new Error("synthetic cumulative transaction rollback");
    })).rejects.toThrow("synthetic cumulative transaction rollback");
    expect(await readCumulative(p)).toEqual(before);
  });

});


// 0249 SOURCE ONLY until the normal isolated/serial DB lane or an explicit
// target+slot grant executes it. This temporarily replaces ONE global function:
// never run it on a shared preservation target with an active app/other writer.
// No SDK/provider call or migration-history write occurs in either topology.
describe("0249 finite old-body barrier, after fence COMMIT", () => {
  let targetClean = true;
  const signature = "public.claim_session_payment_charge_attempt(uuid,uuid,text)";
  const stateSql = `select pg_get_functiondef(oid) as definition, prosrc as body,
    pg_get_userbyid(proowner) as owner, proacl::text as acl, proconfig, prosecdef,
    provolatile from pg_proc where oid=$1::regprocedure`;
  type ClaimResult = { ok: true; value: QueryResult } | { ok: false; error: unknown };
  type FunctionState = { definition: string; body: string; owner: string; acl: string;
    proconfig: string[]; prosecdef: boolean; provolatile: string };
  const extractFunction = (sql: string) => {
    const start = sql.indexOf("create or replace function public.claim_session_payment_charge_attempt(");
    const end = sql.indexOf("$$;", sql.indexOf("as $$", start)) + 3;
    if (start < 0 || end < start) throw new Error("Missing exact claim function source");
    return sql.slice(start, end);
  };
  const oldDefinition = extractFunction(readFileSync("supabase/migrations/0187_appointment_settlement.sql", "utf8"));
  const finalSource = extractFunction(readFileSync("supabase/migrations/0249_session_payment_claim_admission_fence.sql", "utf8"));
  const finalBody = finalSource.slice(finalSource.indexOf("as $$") + 5, finalSource.lastIndexOf("$$;"));

  for (const drainBeforeV2 of [false, true]) {
    it(drainBeforeV2
      ? "ends and accounts for the old transaction BEFORE disjoint fresh v2 admission"
      : "COMMIT T alone leaves an old invocation able to read a later v2 row", async () => {
      if (!targetClean) throw new Error("Prior cutover cleanup unverified: target remains held");
      const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 2 });
      let freshPool: Pool | undefined;
      let holder: PoolClient | undefined;
      let worker: PoolClient | undefined;
      let fresh: PoolClient | undefined;
      let initial: FunctionState | undefined;
      let ownsSessionHold = false;
      let holderPrepared = false;
      let workerPrepared = false;
      let holderDestroyed = false;
      let workerDestroyed = false;
      let freshDestroyed = false;
      let workerDone = false;
      let work: Promise<ClaimResult> | undefined;
      let cleanupFailed = false;
      const failures: unknown[] = [];
      const observeFunction = async () => (await adminQuery(stateSql, [signature])).rows[0] as FunctionState;
      const capture = async (operation: () => Promise<unknown>) => {
        try { await operation(); } catch (error) { cleanupFailed = true; failures.push(error); }
      };
      let key: string | undefined;
      let workerIdentity: { pid: number; backend_start: string } | undefined;
      try {
        initial = await observeFunction();
        expect(initial.body).toBe(finalBody);
        expect(initial).toMatchObject({ owner: "postgres", prosecdef: true,
          proconfig: ["search_path=pg_catalog, pg_temp"], provolatile: "v" });
        const main = await scenario({ attempt: "ready" });
        const warm = await scenario({ attempt: "ready" });
        const disjoint = await scenario({ attempt: "ready" });
        const idFor = async (studioId: string) => {
          const owned = await adminQuery("select id from public.payment_charge_attempts where studio_id=$1", [studioId]);
          expect(owned.rows).toHaveLength(1);
          return owned.rows[0].id as string;
        };
        const mainId = await idFor(main.studioId);
        const warmId = await idFor(warm.studioId);
        const disjointId = await idFor(disjoint.studioId);
        await adminQuery("update public.payment_charge_attempts set status='blocked' where id=$1", [warmId]);
        const fullMain = async () => (await adminQuery(
          "select to_jsonb(a) as row from public.payment_charge_attempts a where id=$1", [mainId],
        )).rows[0].row;
        const readyBefore = await fullMain();
        key = (await adminQuery("select public.appointment_settlement_lock_key($1)::text as key", [main.appointmentId])).rows[0].key as string;

        // Install ONLY frozen0187's function definition, NOT its migration or
        // ACLs/history. All current ACL/owner/path metadata must be restored.
        await adminQuery(oldDefinition);
        holder = await pool.connect();
        worker = await pool.connect();
        for (const c of [holder, worker]) {
          await c.query("set statement_timeout='15s'");
          await c.query("set lock_timeout='5s'");
        }
        const identitySql = "select pid,backend_start::text as backend_start from pg_stat_activity where pid=pg_backend_pid()";
        const holderIdentity = (await holder.query(identitySql)).rows[0] as { pid: number; backend_start: string };
        workerIdentity = (await worker.query(identitySql)).rows[0] as { pid: number; backend_start: string };
        expect(workerIdentity.pid).not.toBe(holderIdentity.pid);
        await holder.query("prepare claim_cutover_probe(uuid,uuid,text) as select *, updated_at::text as raw_claimed_at from public.claim_session_payment_charge_attempt($1,$2,$3)");
        holderPrepared = true;
        const execute = (id: string, actor: string, protocol: "v1" | "v2:create") =>
          // All values are seeded UUIDs and closed literals, not user input.
          `execute claim_cutover_probe('${id}','${actor}','hone:session_payment:${id}:${protocol}')`;
        expect((await holder.query(execute(warmId, warm.practitionerId, "v1"))).rows[0].result).toBe("not_ready");
        expect((await holder.query("select count(*)::int as n from pg_locks where pid=pg_backend_pid() and locktype='advisory'")).rows[0].n).toBe(0);
        expect((await holder.query("select pg_try_advisory_lock($1::bigint) as locked", [key])).rows[0].locked).toBe(true);
        ownsSessionHold = true;
        await worker.query("begin isolation level read committed");
        await worker.query("set local role service_role");
        // Lock wait is intentionally longer than the bounded observer poll.
        await worker.query("set local lock_timeout='12s'");
        await worker.query("prepare claim_cutover_probe(uuid,uuid,text) as select *, updated_at::text as raw_claimed_at from public.claim_session_payment_charge_attempt($1,$2,$3)");
        workerPrepared = true;
        work = worker.query(execute(mainId, main.practitionerId, "v1")).then(
          value => { workerDone = true; return { ok: true, value } as const; },
          error => { workerDone = true; return { ok: false, error } as const; },
        );
        const waitingSql = `select exists (
          select 1 from pg_locks held join pg_locks waiting
            on waiting.locktype=held.locktype and waiting.database=held.database
           and waiting.classid=held.classid and waiting.objid=held.objid
           and waiting.objsubid=held.objsubid and waiting.mode=held.mode
          where held.pid=$1 and held.locktype='advisory' and held.granted
            and waiting.pid=$2 and not waiting.granted
            and $1=any(pg_blocking_pids($2))
        ) as waiting`;
        const waitDeadline = Date.now() + 5_000;
        let observedWait = false;
        while (Date.now() < waitDeadline && !workerDone) {
          observedWait = (await adminQuery(waitingSql, [holderIdentity.pid, workerIdentity.pid])).rows[0].waiting;
          if (observedWait) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(observedWait, "exact worker advisory wait on THIS holder/session key").toBe(true);
        expect(workerDone).toBe(false);

        // SESSION lock survives this COMMIT. Do NOT claim v2 before its ACK T.
        await holder.query("begin isolation level read committed");
        await holder.query(initial.definition);
        await holder.query("commit");
        const t = (await holder.query("select clock_timestamp()::text as t")).rows[0].t as string;
        expect(await observeFunction()).toEqual(initial);
        expect((await adminQuery(waitingSql, [holderIdentity.pid, workerIdentity.pid])).rows[0].waiting).toBe(true);
        await holder.query("begin isolation level read committed");
        await holder.query("set local role service_role");
        // An old body ALSO accepts freshv2, so v2 success ALONE would not prove
        // invalidation. SAME warm prepared connection MUST refuse legacy first.
        expect((await holder.query(execute(mainId, main.practitionerId, "v1"))).rows[0].result).toBe("not_ready");
        await holder.query("commit");
        expect(await fullMain()).toEqual(readyBefore);

        let v2BeforeOld: Record<string, unknown> | undefined;
        if (!drainBeforeV2) {
          await holder.query("begin isolation level read committed");
          await holder.query("set local role service_role");
          const won = (await holder.query(execute(mainId, main.practitionerId, "v2:create"))).rows[0];
          expect(won.result).toBe("claimed");
          await holder.query("commit"); // U is AFTER acknowledged T.
          v2BeforeOld = await fullMain();
          expect(v2BeforeOld).toMatchObject({ status: "pending_stripe",
            stripe_idempotency_key: `hone:session_payment:${mainId}:v2:create`, stripe_payment_intent_id: null });
          expect((await adminQuery(waitingSql, [holderIdentity.pid, workerIdentity.pid])).rows[0].waiting).toBe(true);
        }
        expect(workerDone).toBe(false);
        expect((await holder.query("select pg_advisory_unlock($1::bigint) as unlocked", [key])).rows[0].unlocked).toBe(true);
        ownsSessionHold = false;
        const old = await work;
        if (!old.ok) throw old.error;
        if (!drainBeforeV2) {
          expect(old.value.rows[0]).toMatchObject({ result: "already_pending",
            stripe_idempotency_key: `hone:session_payment:${mainId}:v2:create`, stripe_payment_intent_id: null });
          expect(await fullMain()).toEqual(v2BeforeOld);
        } else {
          expect(old.value.rows[0]).toMatchObject({ result: "claimed",
            stripe_idempotency_key: `hone:session_payment:${mainId}:v1` });
        }
        // Explicitly account/abort this raw SQL test caller BEFORE any later
        // new grant. No HTTP reply/JS/SDK cohort is modeled or declared drained.
        await worker.query("rollback");
        if (drainBeforeV2) expect(await fullMain()).toEqual(readyBefore);
        await worker.query("begin isolation level read committed");
        await worker.query("set local role service_role");
        const workerNow = (await worker.query(execute(mainId, main.practitionerId, "v1"))).rows[0];
        expect(workerNow.result).toBe("not_ready");
        await worker.query("rollback");

        // A genuinely new backend is created AFTER T; do not relabel an old
        // pooled backend as fresh. All fresh grants use a disjoint fixture.
        freshPool = new Pool({ connectionString: resolveLocalDbUrl(), max: 1 });
        fresh = await freshPool.connect();
        await fresh.query("set statement_timeout='15s'");
        const freshIdentity = (await fresh.query(`select pid,backend_start > $1::timestamptz as after_t
          from pg_stat_activity where pid=pg_backend_pid()`, [t])).rows[0];
        expect(freshIdentity.after_t).toBe(true);
        expect([holderIdentity.pid, workerIdentity.pid]).not.toContain(freshIdentity.pid);
        await fresh.query("begin isolation level read committed");
        await fresh.query("set local role service_role");
        const freshCall = "select * from public.claim_session_payment_charge_attempt($1,$2,$3)";
        expect((await fresh.query(freshCall, [disjointId, disjoint.practitionerId, `hone:session_payment:${disjointId}:v1`])).rows[0].result).toBe("not_ready");
        expect((await fresh.query(freshCall, [disjointId, disjoint.practitionerId, `hone:session_payment:${disjointId}:v2:create`])).rows[0].result).toBe("claimed");
        await fresh.query("rollback");
      } catch (error) { failures.push(error); }
      finally {
        // Never wait for the worker while retaining this run's session lock.
        if (holder) {
          await capture(() => holder!.query("rollback"));
          if (ownsSessionHold && key) {
            try {
              const released = await holder.query("select pg_advisory_unlock($1::bigint) as unlocked", [key]);
              if (released.rows[0].unlocked !== true) throw new Error("Owned session advisory hold release unverified");
              ownsSessionHold = false;
            } catch (error) {
              cleanupFailed = true; failures.push(error);
              holder.release(true); holderDestroyed = true;
            }
          }
        }
        if (work) await capture(async () => {
          const outcome = await work!;
          if (!outcome.ok) throw outcome.error;
        });
        if (worker && !workerDestroyed) {
          try { await worker.query("rollback"); }
          catch (error) { cleanupFailed = true; failures.push(error); worker.release(true); workerDestroyed = true; }
        }
        if (fresh) {
          try { await fresh.query("rollback"); }
          catch (error) { cleanupFailed = true; failures.push(error); fresh.release(true); freshDestroyed = true; }
        }
        if (workerIdentity) await capture(async () => {
          const ended = await adminQuery(`select not exists (select 1 from pg_stat_activity
            where pid=$1 and backend_start=$2::timestamptz and xact_start is not null) as ended`,
          [workerIdentity!.pid, workerIdentity!.backend_start]);
          expect(ended.rows[0].ended, "old transaction must end before restoration").toBe(true);
        });
        if (holder && !holderDestroyed) {
          await capture(async () => {
            expect((await holder!.query("select count(*)::int as n from pg_locks where pid=pg_backend_pid() and locktype='advisory'")).rows[0].n).toBe(0);
          });
          if (holderPrepared) await capture(() => holder!.query("deallocate claim_cutover_probe"));
          // Any cleanup uncertainty destroys ONLY this borrowed connection.
          holder.release(cleanupFailed); holderDestroyed = true;
        }
        if (worker && !workerDestroyed) {
          if (workerPrepared) await capture(() => worker!.query("deallocate claim_cutover_probe"));
          worker.release(cleanupFailed); workerDestroyed = true;
        }
        if (fresh && !freshDestroyed) { fresh.release(cleanupFailed); freshDestroyed = true; }
        // Restore captured CURRENT249 body/owner/path/ACL, never historical0187
        // or an invented SQL/history row. Every error remains an actual failure.
        if (initial) await capture(async () => {
          await adminQuery(initial!.definition);
          expect(await observeFunction()).toEqual(initial);
        });
        await capture(() => pool.end());
        if (freshPool) await capture(() => freshPool!.end());
        targetClean = !cleanupFailed;
      }
      if (failures.length) throw new AggregateError(failures, "0249 cutover proof/cleanup failed; preserve all causes");
    }, 60_000);
  }
});
