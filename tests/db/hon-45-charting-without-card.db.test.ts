import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedMember } from "./helpers/harness";
import {
  cleanupPaymentScenario,
  seedEligibleQuickCheckoutScenario,
  type PaymentScenario,
} from "./helpers/payment-seed";

// HON-45 — complete clinical charting WITHOUT a card charge, against the real
// local Postgres.
//
// The studio here is a clinic that bills a third party (an insurer) and is
// paid later: NO connected payment account, NO card on file, and no Stripe
// fact anywhere. The question is whether today's schema already lets such a
// visit be charted, left honestly OUTSTANDING, and resolved later, without a
// card charge ever being required and without anything reading as money Hone
// received. This file proves the existing 0187 path does exactly that; it adds
// no schema. A distinct "billed to insurer" state is deliberately NOT here: it
// waits on product decisions (full amount vs copay split; who records the
// insurer's payment; what a denial does).

const LIVE = true;
const PRICE = 15000;

const created: string[] = [];
afterAll(async () => {
  for (const studioId of created) {
    await cleanupPaymentScenario(studioId).catch(() => undefined);
  }
  await closePool();
});

/** A completed, CHARTED visit at a studio with no payment account and no card. */
async function cardlessChartedVisit(): Promise<PaymentScenario & { entryId: string }> {
  const s = await seedEligibleQuickCheckoutScenario({
    label: "hon45",
    connect: "missing_account",
    withCard: false,
  });
  created.push(s.studioId);
  if (!s.sessionId) throw new Error("hon45: the seed did not create a session");
  const entry = await adminQuery(
    `insert into public.electrolysis_entries (session_id, area) values ($1, 'upper lip') returning id`,
    [s.sessionId],
  );
  return { ...s, entryId: entry.rows[0].id as string };
}

async function record(userId: string, studioId: string, appointmentId: string, method: string, cents: number) {
  return asUser(userId, async (q) => {
    const r = await q(
      `select * from public.record_appointment_settlement($1,$2,$3,$4,$5,$6)`,
      [studioId, appointmentId, method, cents, null, LIVE],
    );
    return r.rows[0] as { result: string; settlement_id: string | null };
  });
}

async function supersede(userId: string, studioId: string, targetId: string, method: string, cents: number, reason: string) {
  return asUser(userId, async (q) => {
    const r = await q(
      `select * from public.supersede_appointment_settlement($1,$2,$3,$4,$5,$6,$7)`,
      [studioId, targetId, method, cents, reason, null, LIVE],
    );
    return r.rows[0] as { result: string; settlement_id: string | null };
  });
}

async function settlements(studioId: string) {
  const r = await adminQuery(
    `select id, method, amount_cents, superseded_at, supersedes_id, supersede_reason
       from public.appointment_settlements where studio_id = $1 order by recorded_at`,
    [studioId],
  );
  return r.rows as Array<{
    id: string;
    method: string;
    amount_cents: number;
    superseded_at: string | null;
    supersedes_id: string | null;
    supersede_reason: string | null;
  }>;
}

async function cardFacts(studioId: string) {
  const r = await adminQuery(
    `select
       (select count(*)::int from public.payment_charge_attempts where studio_id = $1) as attempts,
       (select count(*)::int from public.studio_payment_settings where studio_id = $1) as accounts,
       (select count(*)::int from public.client_payment_methods where studio_id = $1) as cards`,
    [studioId],
  );
  return r.rows[0] as { attempts: number; accounts: number; cards: number };
}

async function chartIntact(s: PaymentScenario & { entryId: string }) {
  const r = await adminQuery(
    `select
       (select count(*)::int from public.sessions where id = $1) as sessions,
       (select count(*)::int from public.electrolysis_entries where id = $2 and session_id = $1) as entries,
       (select status from public.appointments where id = $3) as appointment_status`,
    [s.sessionId, s.entryId, s.appointmentId],
  );
  return r.rows[0] as { sessions: number; entries: number; appointment_status: string };
}

describe("HON-45 — a cardless clinic completes a charted visit with the amount left outstanding", () => {
  it("the visit is completed and charted with no payment account, no card and no charge attempt", async () => {
    const s = await cardlessChartedVisit();
    expect(await cardFacts(s.studioId)).toEqual({ attempts: 0, accounts: 0, cards: 0 });
    expect(await chartIntact(s)).toEqual({ sessions: 1, entries: 1, appointment_status: "completed" });
  });

  it("a non-owner practitioner records the visit as STILL OWED; nothing reads as money received", async () => {
    const s = await cardlessChartedVisit();
    const member = await seedMember(
      { studioId: s.studioId, userId: s.practitionerUserId, practitionerId: s.practitionerId, clientId: s.clientId },
      "hon45-member",
    );

    const out = await record(member.userId, s.studioId, s.appointmentId, "still_owes", PRICE);
    expect(out.result).toBe("recorded");

    const rows = await settlements(s.studioId);
    expect(rows).toHaveLength(1);
    // 0187: for still_owes the one amount column is the amount OUTSTANDING.
    expect(rows[0]).toMatchObject({ method: "still_owes", amount_cents: PRICE, superseded_at: null });

    // No card money exists or was created, and the outstanding record does not
    // block a later payment (0187: still_owes is deliberately non-blocking).
    expect(await cardFacts(s.studioId)).toEqual({ attempts: 0, accounts: 0, cards: 0 });
    const flags = await adminQuery(
      `select public.appointment_has_live_card_money($1,$2,$3) as card_money,
              public.appointment_has_blocking_settlement($1,$2) as blocking`,
      [s.studioId, s.appointmentId, LIVE],
    );
    expect(flags.rows[0]).toEqual({ card_money: false, blocking: false });

    // Recording the outstanding amount changed nothing in the chart.
    expect(await chartIntact(s)).toEqual({ sessions: 1, entries: 1, appointment_status: "completed" });
  });

  it("when the third party pays later, only the OWNER can record it, and the outstanding history is kept", async () => {
    const s = await cardlessChartedVisit();
    const member = await seedMember(
      { studioId: s.studioId, userId: s.practitionerUserId, practitionerId: s.practitionerId, clientId: s.clientId },
      "hon45-payer",
    );
    const owed = await record(member.userId, s.studioId, s.appointmentId, "still_owes", PRICE);
    expect(owed.result).toBe("recorded");

    // A practitioner cannot turn "owed" into "paid": that is a correction, and
    // corrections are owner-only (0187). The visit stays outstanding.
    const byMember = await supersede(member.userId, s.studioId, owed.settlement_id!, "paid_other_external", PRICE, "insurer paid");
    expect(byMember.result).toBe("not_owner");
    expect((await settlements(s.studioId)).filter((r) => r.superseded_at === null)).toEqual([
      expect.objectContaining({ method: "still_owes", amount_cents: PRICE }),
    ]);

    // The owner records the payment as received some other way.
    const byOwner = await supersede(s.practitionerUserId, s.studioId, owed.settlement_id!, "paid_other_external", PRICE, "insurer paid");
    expect(byOwner.result).toBe("corrected");

    const rows = await settlements(s.studioId);
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === owed.settlement_id)!;
    expect(original).toMatchObject({ method: "still_owes", amount_cents: PRICE });
    expect(original.superseded_at).not.toBeNull();
    const live = rows.filter((r) => r.superseded_at === null);
    expect(live).toEqual([
      expect.objectContaining({
        method: "paid_other_external",
        amount_cents: PRICE,
        supersedes_id: owed.settlement_id,
        supersede_reason: "insurer paid",
      }),
    ]);

    // Still no card fact anywhere, and the chart is untouched.
    expect(await cardFacts(s.studioId)).toEqual({ attempts: 0, accounts: 0, cards: 0 });
    expect(await chartIntact(s)).toEqual({ sessions: 1, entries: 1, appointment_status: "completed" });
  });
});
