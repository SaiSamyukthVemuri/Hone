import { test, expect, type Page } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import { seedEligiblePaymentWithLogin, cleanupPaymentScenario, adminQuery, closePool, type PaymentSeed } from "./helpers/payment-fixture";
import { resetFakeStripeLedger, clearFakeStripeOutcome, cleanupFakeStripeLedger, seedFakeRefunds, readFakeStripeCalls } from "./helpers/fake-stripe-ledger-e2e";
import { postSignedStripeEvent } from "./helpers/signed-webhook";

// ===========================================================================
// HON-49: refunds made OUTSIDE Hone are recorded, and the owner's screens tell the truth about the money.
// ===========================================================================
// The live endpoint delivers charge.refunded WITHOUT an embedded refund list (API 2026-06-24.dahlia) and is not subscribed to refund.* events.
// So each case sends a really-signed charge.refunded built from the documented Charge shape (no `refunds` list), the app reads the complete
// list from the FAKE provider (seeded here as if the refund was made in the provider's dashboard), records it through the database command,
// and the owner's panel and balance are read from the rendered pages. Fake processor only: no real Stripe key, account or refund.
//
// Setup shortcut: the charge is seeded as a succeeded attempt and bound to its original provider identity directly in the database (the
// charge journey itself is proved by quick-checkout-payment.spec.ts); the refund journey below is the real route, command and screens.
// Needs HONE_DASHBOARD_UNPAID_ENABLED=true on the server (payment-env.ts sets it for this lane): the owner's "still owed" list is gated.

const LIVE_API_VERSION = "2026-06-24.dahlia";
const AMOUNT = 22500;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Bound = { seed: PaymentSeed; attemptId: string; chargeId: string; paymentIntentId: string; customerId: string; accountId: string };
const seeds: PaymentSeed[] = [];
let n = 0;

test.beforeAll(() => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
});
test.afterAll(async () => {
  try {
    for (const s of seeds) await cleanupPaymentScenario(s.studioId);
  } finally {
    cleanupFakeStripeLedger();
    await closePool();
  }
});

async function chargedVisit(label: string): Promise<Bound> {
  const seed = await seedEligiblePaymentWithLogin({ label, attempt: "succeeded", bookedService: { name: `Refund ${label}`, priceCents: AMOUNT } });
  seeds.push(seed);
  // Bind the seeded charge to the connected account and customer of the saved card (the identity the webhook must match).
  await adminQuery(
    `update public.payment_charge_attempts a set stripe_account_id=m.stripe_account_id, stripe_customer_id=m.stripe_customer_id
       from public.client_payment_methods m where a.studio_id=$1 and m.id=a.client_payment_method_id`,
    [seed.studioId],
  );
  const row = (
    await adminQuery(
      `select id, stripe_charge_id, stripe_payment_intent_id, stripe_customer_id, stripe_account_id, amount_cents, refunds_succeeded_cents
         from public.payment_charge_attempts where studio_id=$1`,
      [seed.studioId],
    )
  ).rows[0] as Record<string, string | number | null>;
  expect(Number(row.amount_cents)).toBe(AMOUNT);
  // An old row: the history was never recorded, so the summary is NULL (never established), not zero.
  expect(row.refunds_succeeded_cents).toBeNull();
  return {
    seed,
    attemptId: String(row.id),
    chargeId: String(row.stripe_charge_id),
    paymentIntentId: String(row.stripe_payment_intent_id),
    customerId: String(row.stripe_customer_id),
    accountId: String(row.stripe_account_id),
  };
}

// charge.refunded as the live endpoint sends it: identity fields and amount_refunded present, NO refunds list.
function chargeRefunded(b: Bound, id: string, refundedCents: number) {
  return {
    id,
    object: "event",
    api_version: LIVE_API_VERSION,
    created: Math.floor(Date.now() / 1000),
    type: "charge.refunded",
    account: b.accountId,
    livemode: false,
    data: {
      object: {
        object: "charge",
        id: b.chargeId,
        status: "succeeded",
        paid: true,
        captured: true,
        livemode: false,
        payment_intent: b.paymentIntentId,
        customer: b.customerId,
        amount: AMOUNT,
        amount_captured: AMOUNT,
        currency: "cad",
        refunded: refundedCents === AMOUNT,
        amount_refunded: refundedCents,
        metadata: { hone_payment_charge_attempt_id: b.attemptId },
      },
    },
  };
}
const refund = (b: Bound, id: string, amount: number) => ({ id, amount, currency: "cad", status: "succeeded", payment_intent: b.paymentIntentId });

async function deliver(b: Bound, eventId: string, refundedCents: number, refunds: Array<ReturnType<typeof refund>>) {
  seedFakeRefunds(b.chargeId, refunds);
  const res = await postSignedStripeEvent(chargeRefunded(b, eventId, refundedCents));
  expect(res.status).toBe(200);
}
const history = async (b: Bound) =>
  (await adminQuery(`select stripe_refund_id, amount_cents, status, evidence_kind from public.payment_charge_refunds where attempt_id=$1 order by stripe_refund_id`, [b.attemptId])).rows;
const summary = async (b: Bound) =>
  (await adminQuery(`select refunds_succeeded_cents s, refunds_inflight_count f from public.payment_charge_attempts where id=$1`, [b.attemptId])).rows[0] as {
    s: number | null;
    f: number | null;
  };

// What the owner reads: the payment panel on the visit, and the "still owed" balance on the dashboard.
async function panel(page: Page, b: Bound) {
  await page.goto(`/calendar/${b.seed.appointmentId}`);
  return page.getByTestId("payment-summary");
}
async function owedOnDashboard(page: Page) {
  await page.goto("/dashboard");
  return page.getByText(/Hone can see \$[\d,.]+ still owed/);
}

test("an old charge whose history was never recorded reads as paid in full: never established, not zero refunded", async ({ page }) => {
  const b = await chargedVisit(`old${++n}`);
  await loginAsOwner(page, b.seed);
  const p = await panel(page, b);
  await expect(p.getByTestId("payment-summary-paid")).toContainText(`Paid · ${money(AMOUNT)}`);
  await expect(p).not.toContainText(/refund/i);
  await expect(await owedOnDashboard(page)).toHaveCount(0);
  expect((await summary(b)).s).toBeNull();
});

test("a Dashboard FULL refund with no Hone refund and no list in the event: recorded, the visit reads Refunded and the whole amount is owed again", async ({ page }) => {
  const b = await chargedVisit(`full${++n}`);
  await deliver(b, `evt_full_${b.seed.runId}`, AMOUNT, [refund(b, `re_full_${b.seed.runId}`, AMOUNT)]);
  // The read used the event's connected account and the event's charge, once.
  const reads = readFakeStripeCalls().filter((c) => c.method === "refund_list" && c.stripeAccount === b.accountId);
  expect(reads.map((c) => c.resultId)).toEqual([b.chargeId]);
  expect(await summary(b)).toEqual({ s: AMOUNT, f: 0 });
  expect(await history(b)).toEqual([expect.objectContaining({ amount_cents: AMOUNT, status: "succeeded", evidence_kind: "signed_event_with_authenticated_list" })]);
  await loginAsOwner(page, b.seed);
  const p = await panel(page, b);
  await expect(p.getByTestId("payment-summary-refunded")).toContainText(`Refunded · ${money(AMOUNT)}`);
  await expect(await owedOnDashboard(page)).toContainText(money(AMOUNT));
});

test("a PARTIAL refund: the visit reads Partly refunded, the amount still on the card is stated, and only the refunded part is owed", async ({ page }) => {
  const b = await chargedVisit(`part${++n}`);
  await deliver(b, `evt_part_${b.seed.runId}`, 5000, [refund(b, `re_p1_${b.seed.runId}`, 5000)]);
  expect(await summary(b)).toEqual({ s: 5000, f: 0 });
  expect(await history(b)).toHaveLength(1);
  await loginAsOwner(page, b.seed);
  const p = await panel(page, b);
  await expect(p.getByTestId("payment-summary-refunded")).toContainText(`Partly refunded · ${money(5000)}`);
  await expect(page.getByText(`Still on the card: ${money(AMOUNT - 5000)}`)).toBeVisible();
  await expect(await owedOnDashboard(page)).toContainText(money(5000));
});

test("a partial THEN the remainder: after each event the screens match the money, and the last reads Refunded with the whole amount owed", async ({ page }) => {
  const b = await chargedVisit(`rem${++n}`);
  const r1 = refund(b, `re_r1_${b.seed.runId}`, 5000);
  const r2 = refund(b, `re_r2_${b.seed.runId}`, AMOUNT - 5000);
  await deliver(b, `evt_rem1_${b.seed.runId}`, 5000, [r1]);
  await loginAsOwner(page, b.seed);
  await expect((await panel(page, b)).getByTestId("payment-summary-refunded")).toContainText(`Partly refunded · ${money(5000)}`);
  await expect(await owedOnDashboard(page)).toContainText(money(5000));
  await deliver(b, `evt_rem2_${b.seed.runId}`, AMOUNT, [r1, r2]);
  expect(await summary(b)).toEqual({ s: AMOUNT, f: 0 });
  expect(await history(b)).toHaveLength(2);
  await expect((await panel(page, b)).getByTestId("payment-summary-refunded")).toContainText(`Refunded · ${money(AMOUNT)}`);
  await expect(await owedOnDashboard(page)).toContainText(money(AMOUNT));
});

// KNOWN GAP, declared out of scope in the change: the calendar and dashboard ROSTER badge (appointment-payment-state) still reads only the older
// columns, so it keeps saying Paid for a partial or external refund. It is tracked as its own follow-up; this marks it so it cannot be forgotten.
test.fixme("the roster badge reads the recorded refund (follow-up: appointment-payment-state and the SQL live-card-money check)", async () => {});
