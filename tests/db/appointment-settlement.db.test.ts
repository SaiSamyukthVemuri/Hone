import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
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
      [attemptId, s.practitionerId, `idem_${attemptId}`],
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
      [second, s.practitionerId, `idem_${second}`],
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
        `idem_${attemptId}`,
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
      [attemptId, s.practitionerId, `idem_${attemptId}`],
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
      [id, s.practitionerId, `idem_${id}`],
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
        [id, s.practitionerId, `idem_${id}`],
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
    expect(svc.rows[0].x).toBe(true);
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
