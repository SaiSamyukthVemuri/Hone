import { test, expect, type Page, type Request } from "@playwright/test";
import { loginByMagicLink } from "../e2e/helpers/flows";
import {
  attachOwnerLogin,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  getSessionPaymentAttemptRows,
  idempotencySelectorForAttempt,
} from "./helpers/payment-fixture";
import {
  resetFakeStripeLedger,
  clearFakeStripeOutcome,
  configureFakeStripeOutcome,
  callsForAccount,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";
import {
  chargeRefundedEvent,
  deliverStripeEvent,
  paymentIntentSucceededEvent,
  processorRefund,
} from "./helpers/fake-stripe-webhook";
import { seedStudio } from "../tests/db/helpers/harness";
import {
  bindFakeStripeAccount,
  seedCardOnFile,
  seedChargeableVisit,
  seedUsdPaymentLayer,
} from "../tests/db/helpers/usd-payment-fixture";

// ===========================================================================
// PAY-CCY-09 (#824): charge -> receipt -> refund -> webhook REPLAY, on the FAKE
// processor, driven through the owner UI.
// ===========================================================================
//
// EVERYTHING HERE IS FAKE: a synthetic processor (lib/stripe/e2e-fake-stripe.ts)
// on a disposable local stack; webhook events are built from the fake ledger and
// signed with the stack's test secret (e2e-payment/helpers/fake-stripe-webhook.ts).
// No real key, no network call to Stripe (asserted), no real money.
//
// What is real: the application. The charge, receipt, refund and webhook
// reconciliation code, their amount/currency checks (#834), idempotency, the
// webhook signature verification, and the database.
//
//   A  USD: charge, receipt, refund in the UI; then every replay is idempotent
//      (same event id twice, a fresh event id with the same facts), and events
//      stating different money or a partial refund are refused.
//   B  USD, refund outcome UNKNOWN (processor refunded, response lost): the row
//      waits in pending_stripe; the charge.refunded webhook settles it, once.
//   C  USD, refund REFUSED by the processor: recorded failed; there is no refund
//      to report, so no refund event can be built.
//   D  CANADIAN REGRESSION: the same charge/refund/replay in CAD.

const PRICE_CENTS = 18_500; // $185.00

type Built = { studioId: string; clientId: string; sessionId: string; accountId: string; ownerEmail: string; clientEmail: string };
const built: Built[] = [];
const stripeNetwork: string[] = [];

async function build(label: string, country: "US" | "CA"): Promise<Built> {
  const s = await seedStudio(`fake-replay-${label}`);
  // US: the composed USD layer (jurisdiction US/usd + US account + card + visit).
  // CA: the same parts WITHOUT makeStudioUsd, so the studio stays at its
  // default CA/cad jurisdiction with a CA-reported account.
  const { account, card, visit } =
    country === "US"
      ? await seedUsdPaymentLayer(s, { priceCents: PRICE_CENTS, accountCountry: "US" })
      : await (async () => {
          const account = await bindFakeStripeAccount(s, { reportedCountry: "CA" });
          const card = await seedCardOnFile(s, account);
          const visit = await seedChargeableVisit(s, { priceCents: PRICE_CENTS });
          return { account, card, visit };
        })();
  const ownerEmail = await attachOwnerLogin(s, `fake-replay-${label}`);
  const b = {
    studioId: s.studioId,
    clientId: s.clientId,
    sessionId: visit.sessionId,
    accountId: account.accountId,
    ownerEmail,
    clientEmail: card.clientEmail,
  };
  built.push(b);
  return b;
}

async function attemptState(attemptId: string) {
  const r = await adminQuery(
    `select status, currency, amount_cents, receipt_status, refund_status,
            refund_amount_cents, stripe_refund_id, refund_failure_code, updated_at
       from public.payment_charge_attempts where id = $1`,
    [attemptId],
  );
  return r.rows[0] as Record<string, unknown>;
}

async function alertsSince(studioId: string, since: string, event: string) {
  const r = await adminQuery(
    `select severity from public.ops_alerts where studio_id = $1 and event = $2 and created_at >= $3`,
    [studioId, event, since],
  );
  return r.rows as Array<{ severity: string }>;
}

/** Prepare and run the charge through the owner UI; returns the attempt id. */
async function chargeInUi(page: Page, b: Built, label: RegExp): Promise<string> {
  page.on("request", (req: Request) => {
    if (/api\.stripe\.com/.test(req.url())) stripeNetwork.push(req.url());
  });
  await loginByMagicLink(page, b.ownerEmail);
  await page.goto(`/clients/${b.clientId}/sessions/${b.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });
  await region.getByRole("button", { name: /prepare session payment/i }).click({ timeout: 20_000 });
  const runCharge = region.getByRole("button", { name: /^run charge$/i });
  await expect(runCharge).toBeVisible({ timeout: 20_000 });
  const [attempt] = await getSessionPaymentAttemptRows(b.sessionId);
  configureFakeStripeOutcome(idempotencySelectorForAttempt(attempt.id), "success");
  await runCharge.click();
  await region.getByRole("button", { name: /confirm: run charge/i }).click();
  await expect(region.getByTestId("payment-summary-paid")).toContainText(label, { timeout: 30_000 });
  return attempt.id;
}

/** Ask for the refund through the owner UI (whatever the processor answers). */
async function requestRefundInUi(page: Page) {
  await page.reload();
  const region = page.getByRole("region", { name: "Session payment" });
  await region.getByRole("button", { name: /^refund charge$/i }).click({ timeout: 20_000 });
  await region.getByRole("button", { name: /confirm: refund charge/i }).click();
  return region;
}

const refundKey = (attemptId: string) => `hone:payment_refund:${attemptId}:v1`;

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
});

test.afterAll(async () => {
  try {
    for (const b of built) {
      await adminQuery(`delete from public.services where studio_id = $1`, [b.studioId]).catch(() => undefined);
      await cleanupPaymentScenario(b.studioId).catch(() => undefined);
    }
  } finally {
    cleanupFakeStripeLedger();
    await closePool();
  }
});

test("A · USD charge, receipt and refund in the UI; every webhook replay is idempotent; wrong money and partial refunds are refused", async ({ page }) => {
  const b = await build("a", "US");
  const attemptId = await chargeInUi(page, b, /Paid · \$185\.00 USD/);

  // RECEIPT (fake email transport), to the client's card-on-file address.
  await expect
    .poll(async () => (await attemptState(attemptId)).receipt_status, { timeout: 30_000 })
    .toBe("sent");

  // payment_intent.succeeded for the charge the UI already recorded: twice
  // with the SAME event id, then once with a fresh id. Nothing changes.
  const before = await attemptState(attemptId);
  const succeeded = await paymentIntentSucceededEvent(attemptId);
  for (const ev of [succeeded, succeeded, await paymentIntentSucceededEvent(attemptId)]) {
    expect((await deliverStripeEvent(ev)).status).toBe(200);
  }
  expect(await attemptState(attemptId)).toEqual(before);

  // REFUND in the UI.
  const region = await requestRefundInUi(page);
  await expect(region.getByText("Refund succeeded.")).toBeVisible({ timeout: 30_000 });
  const refunded = await attemptState(attemptId);
  expect(refunded).toMatchObject({
    status: "succeeded",
    currency: "usd",
    amount_cents: PRICE_CENTS,
    refund_status: "succeeded",
    refund_amount_cents: PRICE_CENTS,
    stripe_refund_id: processorRefund(attemptId)?.id,
  });

  // charge.refunded replayed: same id twice, then a fresh id. Nothing changes,
  // and the processor still made exactly ONE refund.
  const refundEvent = await chargeRefundedEvent(attemptId);
  for (const ev of [refundEvent, refundEvent, await chargeRefundedEvent(attemptId)]) {
    expect((await deliverStripeEvent(ev)).status).toBe(200);
  }
  expect(await attemptState(attemptId)).toEqual(refunded);
  expect(
    callsForAccount(b.accountId).filter((c) => c.method === "refund_create" && !c.replay),
  ).toHaveLength(1);

  // Events stating DIFFERENT money, and a PARTIAL refund: refused, row untouched,
  // a critical alert names the money mismatch.
  const since = new Date(Date.now() - 1000).toISOString();
  for (const ev of [
    await paymentIntentSucceededEvent(attemptId, { currency: "cad" }),
    await chargeRefundedEvent(attemptId, { amount: PRICE_CENTS + 100 }),
    await chargeRefundedEvent(attemptId, { amountRefunded: PRICE_CENTS - 500 }),
  ]) {
    expect((await deliverStripeEvent(ev)).status).toBe(200);
  }
  expect(await attemptState(attemptId)).toEqual(refunded);
  expect(
    (await alertsSince(b.studioId, since, "stripe_webhook_money_mismatch")).map((a) => a.severity),
  ).toContain("critical");

  // An UNSIGNED / wrongly signed delivery never reaches a handler.
  const forged = await fetch(new URL("/api/stripe/webhook", page.url()).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
    body: JSON.stringify(refundEvent),
  });
  expect(forged.status).toBe(400);

  expect(stripeNetwork).toEqual([]);
});

test("B · USD refund outcome UNKNOWN: pending until the charge.refunded webhook settles it, exactly once", async ({ page }) => {
  const b = await build("b", "US");
  const attemptId = await chargeInUi(page, b, /Paid · \$185\.00 USD/);

  // The processor makes the refund but the response is lost.
  configureFakeStripeOutcome(refundKey(attemptId), "processing");
  const region = await requestRefundInUi(page);
  await expect(region.getByText("Refund succeeded.")).toHaveCount(0);
  await expect
    .poll(async () => (await attemptState(attemptId)).refund_status, { timeout: 30_000 })
    .toBe("pending_stripe");
  const refund = processorRefund(attemptId);
  expect(refund).not.toBeNull();

  // Stripe tells us: the pending refund settles to succeeded with its id.
  const ev = await chargeRefundedEvent(attemptId);
  expect((await deliverStripeEvent(ev)).status).toBe(200);
  const settled = await attemptState(attemptId);
  expect(settled).toMatchObject({
    refund_status: "succeeded",
    refund_amount_cents: PRICE_CENTS,
    stripe_refund_id: refund!.id,
  });

  // Replays change nothing.
  expect((await deliverStripeEvent(ev)).status).toBe(200);
  expect((await deliverStripeEvent(await chargeRefundedEvent(attemptId))).status).toBe(200);
  expect(await attemptState(attemptId)).toEqual(settled);
  expect(
    callsForAccount(b.accountId).filter((c) => c.method === "refund_create" && !c.replay),
  ).toHaveLength(1);
  expect(stripeNetwork).toEqual([]);
});

test("C · USD refund REFUSED by the processor: recorded failed, and no refund event can be forged", async ({ page }) => {
  const b = await build("c", "US");
  const attemptId = await chargeInUi(page, b, /Paid · \$185\.00 USD/);

  configureFakeStripeOutcome(refundKey(attemptId), "decline");
  const region = await requestRefundInUi(page);
  await expect(region.getByText("Refund succeeded.")).toHaveCount(0);
  await expect
    .poll(async () => (await attemptState(attemptId)).refund_status, { timeout: 30_000 })
    .toBe("failed");
  expect(await attemptState(attemptId)).toMatchObject({
    status: "succeeded",
    refund_failure_code: "e2e_fake_refund_refused",
    stripe_refund_id: null,
  });
  // The processor made no refund, so the transport refuses to report one.
  expect(processorRefund(attemptId)).toBeNull();
  await expect(chargeRefundedEvent(attemptId)).rejects.toThrow(/made no refund/);
  expect(stripeNetwork).toEqual([]);
});

test("D · CANADIAN REGRESSION: charge, refund and replay in CAD are unchanged", async ({ page }) => {
  const b = await build("d", "CA");
  const attemptId = await chargeInUi(page, b, /Paid · \$185\.00 CAD/);

  const region = await requestRefundInUi(page);
  await expect(region.getByText("Refund succeeded.")).toBeVisible({ timeout: 30_000 });
  const refunded = await attemptState(attemptId);
  expect(refunded).toMatchObject({ currency: "cad", refund_status: "succeeded", refund_amount_cents: PRICE_CENTS });

  for (const ev of [await paymentIntentSucceededEvent(attemptId), await chargeRefundedEvent(attemptId)]) {
    expect((await deliverStripeEvent(ev)).status).toBe(200);
  }
  expect(await attemptState(attemptId)).toEqual(refunded);
  expect(stripeNetwork).toEqual([]);
});
