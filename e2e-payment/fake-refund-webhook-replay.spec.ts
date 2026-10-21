import { test, expect, type Page, type Request } from "@playwright/test";
import { bookAppointment, loginByMagicLink } from "../e2e/helpers/flows";
import { seedE2eStudio, getClientIdByEmail, getAppointmentsForClient, getIntakeTokenForClient, getSessionsForClient, getSessionContentDigest, getOwnerPractitionerIdForStudio } from "../e2e/helpers/seed";
import {
  attachOwnerLogin,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  getSessionPaymentAttemptRows,
  readClinicalIntegritySnapshot,
  idempotencySelectorForAttempt,
} from "./helpers/payment-fixture";
import {
  resetFakeStripeLedger,
  clearFakeStripeOutcome,
  configureFakeStripeOutcome,
  callsForAccount,
  readFakeStripeCalls,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";
import {
  chargeRefundedEvent,
  deliverStripeEvent,
  paymentIntentSucceededEvent,
  processorRefund,
} from "./helpers/fake-stripe-webhook";
import { PAYMENT_E2E_APP_ORIGIN, PAYMENT_WEB_SERVER_ENV, readStripeEgress, stripeEgressGuardArmed } from "./helpers/payment-env";
import { metadataDigest } from "./helpers/fake-stripe-metadata-digest";
import { seedStudio } from "../tests/db/helpers/harness";
import {
  bindFakeStripeAccount,
  makeStudioUsd,
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
// No real key, no network call to Stripe (asserted in the SERVER process by
// e2e-payment/helpers/stripe-egress-guard.cjs, and in the browser), no real money.
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
//      The owner's card is truthful at both points (PAY-CCY-10): while pending
//      it claims no success and offers no second refund; once settled it shows
//      refunded with the right money and nothing still pending.
//   C  USD, refund REFUSED by the processor: recorded failed; there is no refund
//      to report, so no refund event can be built. The owner's card still shows
//      paid, says the refund failed, and offers the refund again (PAY-CCY-10).
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
            refund_amount_cents, stripe_refund_id, stripe_refund_status, refunded_at,
            stripe_refund_event_id, stripe_refund_event_created::text as stripe_refund_event_created,
            stripe_charge_refund_event_id, stripe_charge_refund_event_created::text as stripe_charge_refund_event_created,
            refund_failure_code, updated_at
       from public.payment_charge_attempts where id = $1`,
    [attemptId],
  );
  return r.rows[0] as Record<string, unknown>;
}

/** A new signed observation enriches provenance; it must not rewrite refund
 * identity, first completion time, money, or independent aggregate truth. */
function expectSignedRefundObservation(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  event: { id: string; created: number },
) {
  expect(after.updated_at).toBeInstanceOf(Date);
  expect((after.updated_at as Date).getTime()).toBeGreaterThanOrEqual(
    (before.updated_at as Date).getTime(),
  );
  expect(after).toEqual({
    ...before,
    stripe_refund_event_id: event.id,
    stripe_refund_event_created: String(event.created),
    updated_at: after.updated_at,
  });
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

/** The owner's payment card as a fresh page load renders it from persisted
 * state (PAY-CCY-10): what the owner would actually see after the fact. */
async function ownerPaymentView(page: Page) {
  await page.reload();
  const region = page.getByRole("region", { name: "Session payment" });
  await expect(region).toBeVisible({ timeout: 20_000 });
  return region;
}

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

  // The first signed observation adds provenance to the action response.
  // Same-event replay changes NOTHING, including updated_at; a fresh event may
  // advance only signed provenance and its observation timestamp.
  expect(refunded.stripe_refund_event_id).toBeNull();
  expect(refunded.stripe_refund_event_created).toBeNull();
  const refundEvent = await chargeRefundedEvent(attemptId);
  expect((await deliverStripeEvent(refundEvent)).status).toBe(200);
  const observed = await attemptState(attemptId);
  expectSignedRefundObservation(refunded, observed, refundEvent);
  expect((await deliverStripeEvent(refundEvent)).status).toBe(200);
  expect(await attemptState(attemptId)).toEqual(observed);
  const freshRefundEvent = await chargeRefundedEvent(attemptId);
  expect((await deliverStripeEvent(freshRefundEvent)).status).toBe(200);
  const replayed = await attemptState(attemptId);
  expectSignedRefundObservation(observed, replayed, freshRefundEvent);
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
  expect(await attemptState(attemptId)).toEqual(replayed);
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

  // NEGATIVE CONTROL (Codex P2 4264919593): a Hone row naming a charge the
  // processor never produced gets NO event; the helper does not manufacture
  // a matching one. Last in this test: the update moves updated_at.
  const realCharge = (
    await adminQuery(`select stripe_charge_id from public.payment_charge_attempts where id = $1`, [attemptId])
  ).rows[0].stripe_charge_id as string;
  await adminQuery(
    `update public.payment_charge_attempts set stripe_charge_id = $2 where id = $1`,
    [attemptId, `${realCharge}_wrong`],
  );
  try {
    await expect(chargeRefundedEvent(attemptId)).rejects.toThrow(/provider lineage broken/);
    await expect(paymentIntentSucceededEvent(attemptId)).rejects.toThrow(/provider lineage broken/);
  } finally {
    await adminQuery(
      `update public.payment_charge_attempts set stripe_charge_id = $2 where id = $1`,
      [attemptId, realCharge],
    );
  }
  // Control: restored, the same row builds its event again.
  expect(((await chargeRefundedEvent(attemptId)).data.object as { id: string }).id).toBe(realCharge);

  expect(stripeNetwork).toEqual([]); // browser side
  expect(stripeEgressGuardArmed()).toBe(true); // the guard IS in the payment server
  expect(readStripeEgress()).toEqual([]); // SERVER side: the payment web server never reached Stripe
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

  // OWNER VIEW while the outcome is unknown (PAY-CCY-10): truthful. It says
  // pending, claims no success and no refunded money, and offers no second
  // refund (a retry here could refund twice).
  let view = await ownerPaymentView(page);
  await expect(view.getByText("Refund pending.")).toBeVisible();
  await expect(view.getByTestId("payment-summary-refund_pending")).toContainText(/Refund processing · \$185\.00 USD/);
  await expect(view.getByTestId("payment-summary-refunded")).toHaveCount(0);
  await expect(view.getByText("Refund succeeded.")).toHaveCount(0);
  await expect(view.getByText(/Amount refunded/)).toHaveCount(0);
  await expect(view.getByText(/^Refunded/)).toHaveCount(0);
  await expect(view.getByRole("button", { name: /^refund charge$/i })).toHaveCount(0);

  // Stripe tells us: the pending refund settles to succeeded with its id.
  const ev = await chargeRefundedEvent(attemptId);
  expect((await deliverStripeEvent(ev)).status).toBe(200);
  const settled = await attemptState(attemptId);
  expect(settled).toMatchObject({
    refund_status: "succeeded",
    refund_amount_cents: PRICE_CENTS,
    stripe_refund_id: refund!.id,
  });

  // OWNER VIEW after the webhook settled it: refunded, with the right money,
  // and nothing still saying pending.
  view = await ownerPaymentView(page);
  await expect(view.getByText("Refund succeeded.")).toBeVisible();
  await expect(view.getByText(/Amount refunded: \$185\.00 USD/)).toBeVisible();
  await expect(view.getByTestId("payment-summary-refunded")).toContainText(/Refunded · \$185\.00 USD/);
  await expect(view.getByTestId("payment-summary-refund_pending")).toHaveCount(0);
  await expect(view.getByText("Refund pending.")).toHaveCount(0);
  await expect(view.getByText(/Refund processing/)).toHaveCount(0);
  await expect(view.getByRole("button", { name: /^refund charge$/i })).toHaveCount(0);

  expect(settled).toMatchObject({ stripe_refund_event_id: ev.id, stripe_refund_event_created: String(ev.created) });
  // Identical delivery is a strict no-op; a new signed observation retains
  // the first completion and individual Refund while recording its provenance.
  expect((await deliverStripeEvent(ev)).status).toBe(200);
  expect(await attemptState(attemptId)).toEqual(settled);
  const freshEvent = await chargeRefundedEvent(attemptId);
  expect((await deliverStripeEvent(freshEvent)).status).toBe(200);
  expectSignedRefundObservation(settled, await attemptState(attemptId), freshEvent);
  expect(
    callsForAccount(b.accountId).filter((c) => c.method === "refund_create" && !c.replay),
  ).toHaveLength(1);
  expect(stripeNetwork).toEqual([]); // browser side
  expect(stripeEgressGuardArmed()).toBe(true); // the guard IS in the payment server
  expect(readStripeEgress()).toEqual([]); // SERVER side: the payment web server never reached Stripe
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

  // OWNER VIEW after a refusal (PAY-CCY-10): still paid, says the refund
  // failed, claims no refunded money, and offers the refund again.
  const view = await ownerPaymentView(page);
  await expect(view.getByText("Refund failed.")).toBeVisible();
  await expect(view.getByTestId("payment-summary-paid")).toContainText(/Paid · \$185\.00 USD/);
  await expect(view.getByTestId("payment-summary-refunded")).toHaveCount(0);
  await expect(view.getByText("Refund succeeded.")).toHaveCount(0);
  await expect(view.getByText(/Amount refunded/)).toHaveCount(0);
  await expect(view.getByText(/^Refunded/)).toHaveCount(0);
  await expect(view.getByRole("button", { name: /^refund charge$/i })).toBeVisible();
  expect(stripeNetwork).toEqual([]); // browser side
  expect(stripeEgressGuardArmed()).toBe(true); // the guard IS in the payment server
  expect(readStripeEgress()).toEqual([]); // SERVER side: the payment web server never reached Stripe
});

test("D · CANADIAN REGRESSION: charge, refund and replay in CAD are unchanged", async ({ page }) => {
  const b = await build("d", "CA");
  const attemptId = await chargeInUi(page, b, /Paid · \$185\.00 CAD/);

  const region = await requestRefundInUi(page);
  await expect(region.getByText("Refund succeeded.")).toBeVisible({ timeout: 30_000 });
  const refunded = await attemptState(attemptId);
  expect(refunded).toMatchObject({ currency: "cad", refund_status: "succeeded", refund_amount_cents: PRICE_CENTS });

  expect((await deliverStripeEvent(await paymentIntentSucceededEvent(attemptId))).status).toBe(200);
  expect(await attemptState(attemptId)).toEqual(refunded);
  const refundEvent = await chargeRefundedEvent(attemptId);
  expect((await deliverStripeEvent(refundEvent)).status).toBe(200);
  const observed = await attemptState(attemptId);
  expectSignedRefundObservation(refunded, observed, refundEvent);
  expect((await deliverStripeEvent(refundEvent)).status).toBe(200);
  expect(await attemptState(attemptId)).toEqual(observed);
  expect(stripeNetwork).toEqual([]); // browser side
  expect(stripeEgressGuardArmed()).toBe(true); // the guard IS in the payment server
  expect(readStripeEgress()).toEqual([]); // SERVER side: the payment web server never reached Stripe
});


// HON-18: one linked journey, rather than adding unrelated suite totals.
// This case is meaningful only on the final aligned/enforced candidate, through
// the EXISTING payment server. It adds no provider flag, helper or SQL mutation.
// SMS is intentionally skipped; Google requires observed disabled outbound/worker
// controls and no studio connection (not an observed worker skip). Receipt email is fake
// acceptance only. No print/admin/native/photo proof is replayed here.
test("E · two synthetic studios keep one booking/intake/chart/money lineage and deny foreign access", async ({ page, browser }, testInfo) => {
  expect(PAYMENT_WEB_SERVER_ENV.HONE_E2E_FAKE_STRIPE).toBe("1");
  expect(PAYMENT_WEB_SERVER_ENV.HONE_E2E_FAKE_RESEND).toBe("1");
  // A global override would erase the per-recipient refusal/acceptance scenario.
  expect(PAYMENT_WEB_SERVER_ENV.HONE_E2E_FAKE_RESEND_MODE).toBeUndefined();
  expect(stripeEgressGuardArmed()).toBe(true);
  expect(readStripeEgress()).toEqual([]);
  page.on("request", (r: Request) => { if (/api\.stripe\.com/.test(r.url())) stripeNetwork.push(r.url()); });
  const journeys: Array<Built & { appointmentId: string; intakeId: string; attemptId: string; clientName: string; digest: string }> = [];

  for (const country of ["CA", "US"] as const) {
    const currency = country === "US" ? "usd" : "cad";
    const seed = await seedE2eStudio();
    seed.clientEmail = `reject+journey-${seed.runId}@harness.local`;
    if (country === "US") await makeStudioUsd({ studioId: seed.studioId }, { acknowledgePrices: true });
    const b: Built = { studioId: seed.studioId, clientId: "", sessionId: "", accountId: "", ownerEmail: seed.ownerEmail, clientEmail: seed.clientEmail };
    built.push(b); // Existing run-scoped cleanup owns even a partly built case.
    // This paid journey uses a paid consultation BEFORE any booking exists.
    // A free consultation intentionally has no payment-preparation form.
    const initialService = (await adminQuery(`select id,studio_id,name,modality,price_cents,active
      from public.services where studio_id=$1 and name=$2`, [seed.studioId, seed.serviceName])).rows;
    expect(initialService).toHaveLength(1);
    expect(initialService[0]).toMatchObject({ studio_id: seed.studioId, name: seed.serviceName,
      modality: "consultation", price_cents: 0, active: true });
    const pricedService = (await adminQuery(`update public.services set price_cents=12000
      where id=$3 and studio_id=$1 and name=$2 and modality='consultation' and price_cents=0 and active=true
      returning id,studio_id,name,price_cents`, [seed.studioId, seed.serviceName, initialService[0].id])).rows;
    expect(pricedService).toHaveLength(1);
    expect(pricedService[0]).toMatchObject({ id: initialService[0].id, studio_id: seed.studioId,
      name: seed.serviceName, price_cents: 12000 });

    await test.step(`${country}: containment preconditions before booking`, async () => {
      const flags = (await adminQuery(`select send_confirmation_emails,send_confirmation_sms,
        send_24h_sms_reminders,send_2h_sms_reminders,google_calendar_connection_enabled,
        google_calendar_outbound_sync_enabled
        from public.studios where id=$1`, [seed.studioId])).rows;
      expect(flags).toEqual([{ send_confirmation_emails: true, send_confirmation_sms: false,
        send_24h_sms_reminders: false, send_2h_sms_reminders: false, google_calendar_connection_enabled: false,
        google_calendar_outbound_sync_enabled: false }]);
      // Existing 0121/0125 gates: read actual target state, never enable or reset it.
      // No connection at all is stronger than merely no connected row. Unknown or
      // enabled worker state refuses this journey before its first booking.
      expect((await adminQuery(`select id from public.calendar_connections
        where studio_id=$1`, [seed.studioId])).rows).toEqual([]);
      expect((await adminQuery(`select worker_enabled from public.calendar_sync_control
        where id=true`)).rows).toEqual([{ worker_enabled: false }]);
    });
    const booking = await browser.newPage({ baseURL: PAYMENT_E2E_APP_ORIGIN });
    booking.on("request", (r: Request) => { if (/api\.stripe\.com/.test(r.url())) stripeNetwork.push(r.url()); });
    let appointmentId = ""; let intakeId = "";
    try {
      await test.step(`${country}: public booking commits while fake confirmation refuses`, async () => {
        await bookAppointment(booking, seed);
        await expect(booking.getByText(/We couldn.t confirm that our confirmation email/)).toBeVisible();
        await expect(booking.getByRole("link", { name: "Manage booking", exact: true })).toBeVisible();
        b.clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
        expect(b.clientId).toBeTruthy();
        const appts = await getAppointmentsForClient(seed.studioId, b.clientId);
        expect(appts).toHaveLength(1); expect(appts[0].status).toBe("confirmed");
        appointmentId = appts[0].id;
        const facts = (await adminQuery(`select studio_id,client_id,confirmation_sent_at,confirmation_send_attempts,
          sms_confirmation_sent_at,sms_confirmation_send_attempts from public.appointments where id=$1 and studio_id=$2`,
          [appointmentId, seed.studioId])).rows[0];
        expect(facts).toMatchObject({ studio_id: seed.studioId, client_id: b.clientId,
          confirmation_sent_at: null, sms_confirmation_sent_at: null, sms_confirmation_send_attempts: 0 });
        expect(Number(facts.confirmation_send_attempts)).toBeGreaterThan(0);
      });
      await test.step(`${country}: submit intake for that same booked client through the existing wizard`, async () => {
        const token = await getIntakeTokenForClient(seed.studioId, seed.clientEmail); expect(token).toBeTruthy();
        const intakes = (await adminQuery("select id from public.client_intake_forms where studio_id=$1 and client_id=$2", [seed.studioId, b.clientId])).rows;
        expect(intakes).toHaveLength(1); intakeId = intakes[0].id;
        await booking.goto(`/intake/${token}`);
        // Same bounded, error-driven UI walker as the existing core-memory-loop.
        // No responses UPDATE or revision/CAS RPC is hardwired into this spec.
        for (let step = 0; step < 40; step++) {
          if (booking.url().includes("thank-you")) break;
          for (const input of await booking.locator("input[type=text]:visible, input:not([type]):visible, textarea:visible").all()) {
            if ((await input.inputValue()) === "") {
              const id = (await input.getAttribute("id")) ?? "";
              await input.fill(id.includes("email") ? seed.clientEmail : "Synthetic answer");
            }
          }
          for (const input of await booking.locator("input[type=date]:visible").all()) {
            if ((await input.inputValue()) === "") await input.fill("1990-01-01");
          }
          await booking.getByRole("button", { name: /submit intake|next|continue/i }).first().click();
          await booking.waitForTimeout(400);
          for (const alert of await booking.getByRole("alert").all()) {
            const container = alert.locator("..");
            const no = container.getByRole("button", { name: /^No$/ });
            const checks = container.locator("input[type=checkbox]");
            const option = container.getByRole("button").first();
            if (await no.count()) await no.first().click();
            else if (await checks.count()) await checks.first().check();
            else if (await option.count()) await option.click();
          }
        }
        await expect(booking).toHaveURL(/thank-you/, { timeout: 20_000 });
        const intake = (await adminQuery("select studio_id,client_id,status,submitted_at from public.client_intake_forms where id=$1 and studio_id=$2", [intakeId, seed.studioId])).rows[0];
        expect(intake).toMatchObject({ studio_id: seed.studioId, client_id: b.clientId, status: "submitted" });
        expect(intake.submitted_at).not.toBeNull();
      });
    } finally { await booking.close(); }

    await test.step(`${country}: chart and complete that exact appointment in the owner UI`, async () => {
      await loginByMagicLink(page, seed.ownerEmail);
      await page.goto(`/clients/${b.clientId}/sessions/new?appointment_id=${appointmentId}`);
      await page.getByRole("button", { name: /electrolysis/i }).click();
      await page.waitForURL(/sessions\//, { timeout: 20_000 });
      await page.getByTestId("add-settings-block-cta").click({ timeout: 20_000 });
      await page.getByRole("button", { name: "Chin", exact: true }).click();
      await page.getByRole("button", { name: "13.56 MHz" }).click();
      await page.getByRole("button", { name: "Sterex" }).click();
      await page.getByPlaceholder("e.g. 460941").fill(`JOURNEY-${seed.runId}`);
      await page.getByRole("spinbutton", { name: /minutes performed/i }).fill("15");
      await page.getByRole("button", { name: "Mild discomfort" }).click();
      await page.getByRole("button", { name: "+ Mild redness" }).click();
      await page.getByRole("button", { name: /save settings block/i }).click();
      await expect(page.getByText(`JOURNEY-${seed.runId}`).first()).toBeVisible({ timeout: 20_000 });
      const sessions = await getSessionsForClient(b.clientId); expect(sessions).toHaveLength(1);
      b.sessionId = sessions[0].id; expect(sessions[0].studio_id).toBe(seed.studioId);
      const complete = page.getByTestId("mark-appointment-complete");
      // Public booking deliberately selected a future slot. First prove the
      // real completion time gate, then align ONLY that synthetic appointment
      // to the past; keep its identity, duration, status and entire chart chain.
      await expect(complete).toBeDisabled();
      const beforeTime = (await adminQuery(`select id,studio_id,client_id,status,
        starts_at > now() as future,extract(epoch from (ends_at-starts_at))::int as duration_seconds
        from public.appointments where id=$1 and studio_id=$2 and client_id=$3`,
      [appointmentId, seed.studioId, b.clientId])).rows;
      expect(beforeTime).toHaveLength(1);
      expect(beforeTime[0]).toMatchObject({ id: appointmentId, studio_id: seed.studioId,
        client_id: b.clientId, status: "confirmed", future: true });
      expect(beforeTime[0].duration_seconds).toBeGreaterThan(0);
      const alignedTime = (await adminQuery(`update public.appointments
        set ends_at=now()-interval '90 minutes'+(ends_at-starts_at),
            starts_at=now()-interval '90 minutes'
        where id=$1 and studio_id=$2 and client_id=$3 and status='confirmed' and starts_at>now()
        returning id,studio_id,client_id,status,starts_at<=now() as started,
          extract(epoch from (ends_at-starts_at))::int as duration_seconds`,
      [appointmentId, seed.studioId, b.clientId])).rows;
      expect(alignedTime).toEqual([{ id: appointmentId, studio_id: seed.studioId,
        client_id: b.clientId, status: "confirmed", started: true,
        duration_seconds: beforeTime[0].duration_seconds }]);
      await page.reload();
      await expect(complete).toBeEnabled();
      await complete.click(); await page.getByTestId("confirm-dialog-confirm").click();
      await expect(page.getByTestId("finish-completion-status")).toHaveText("Completed", { timeout: 20_000 });
      const linked = (await adminQuery(`select s.studio_id,s.client_id,s.appointment_id,a.status
        from public.sessions s join public.appointments a on a.id=s.appointment_id and a.studio_id=s.studio_id
        where s.id=$1 and s.studio_id=$2`, [b.sessionId, seed.studioId])).rows;
      expect(linked).toEqual([{ studio_id: seed.studioId, client_id: b.clientId, appointment_id: appointmentId, status: "completed" }]);
    });
    const ownerId = await getOwnerPractitionerIdForStudio(seed.studioId);
    const account = await bindFakeStripeAccount({ studioId: seed.studioId }, { reportedCountry: country });
    const card = await seedCardOnFile({ studioId: seed.studioId, practitionerId: ownerId, clientId: b.clientId }, account);
    b.accountId = account.accountId; b.clientEmail = card.clientEmail;
    const beforeClinical = await readClinicalIntegritySnapshot(b.sessionId);
    expect(beforeClinical).toMatchObject({ exists: true, started: true, blockCount: 1 });
    const digest = await getSessionContentDigest(b.sessionId);
    let attemptId = "";
    await test.step(`${country}: owner-authored fake charge/refund stays bound to that chart and intake`, async () => {
      await page.reload();
      const region = page.getByRole("region", { name: "Session payment" });
      // Preserve the booked $120 reference; the owner explicitly authors a
      // $185 total with the existing required adjustment explanation.
      await expect(region.getByTestId("authoritative-amount")).toHaveText("$120.00");
      await region.getByTestId("final-charge-input").fill("185.00");
      await region.getByTestId("adjustment-reason-input").fill("Synthetic aftercare product adjustment");
      await region.getByRole("button", { name: /prepare session payment/i }).click();
      const run = region.getByRole("button", { name: /^run charge$/i }); await expect(run).toBeVisible();
      const attempts = await getSessionPaymentAttemptRows(b.sessionId); expect(attempts).toHaveLength(1); attemptId = attempts[0].id;
      configureFakeStripeOutcome(idempotencySelectorForAttempt(attemptId), "success");
      await run.click(); await region.getByRole("button", { name: /confirm: run charge/i }).click();
      await expect(region.getByTestId("payment-summary-paid")).toContainText(`$185.00 ${currency.toUpperCase()}`, { timeout: 30_000 });
      const pi = callsForAccount(account.accountId).filter((c) => c.method === "pi_create" && !c.replay);
      expect(pi).toHaveLength(1);
      expect(pi[0]).toMatchObject({ amountCents: PRICE_CENTS, currency,
        stripeAccount: account.accountId, idempotencyKey: idempotencySelectorForAttempt(attemptId) });
      expect(pi[0].chargeId).toBeNull(); // Unconfirmed object creation is not money.
      expect(pi[0].metadataDigest).toBeTruthy();
      const confirmed = callsForAccount(account.accountId).filter((c) => c.method === "pi_confirm" && !c.replay);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]).toMatchObject({ resultId: pi[0].resultId,
        stripeAccount: account.accountId, amountCents: PRICE_CENTS, currency,
        idempotencyKey: `hone:session_payment:${attemptId}:v2:confirm:${pi[0].resultId}`,
        payerDigest: pi[0].payerDigest, metadataDigest: pi[0].metadataDigest });
      expect(confirmed[0].chargeId).toEqual(expect.stringMatching(/^ch_[A-Za-z0-9_]+$/));
      await expect.poll(async () => (await adminQuery("select receipt_status,receipt_email_to from public.payment_charge_attempts where id=$1 and studio_id=$2", [attemptId, seed.studioId])).rows[0], { timeout: 30_000 })
        .toEqual({ receipt_status: "sent", receipt_email_to: card.clientEmail }); // FAKE acceptance, not delivery.
      configureFakeStripeOutcome(refundKey(attemptId), "success");
      const refundedUi = await requestRefundInUi(page);
      await expect(refundedUi.getByText("Refund succeeded.")).toBeVisible({ timeout: 30_000 });
      expect(await attemptState(attemptId)).toMatchObject({ status: "succeeded", currency, amount_cents: PRICE_CENTS, refund_status: "succeeded", refund_amount_cents: PRICE_CENTS });
      const refunds = callsForAccount(account.accountId).filter((c) => c.method === "refund_create" && !c.replay);
      expect(refunds).toHaveLength(1); expect(refunds[0].amountCents).toBe(PRICE_CENTS);
      expect(pi[0].resultId).toBeTruthy();
      expect(pi[0].payerDigest).toBe(metadataDigest({ payer: card.customerId }));
      expect(refunds[0].resultId).toBeTruthy();
      expect(refunds[0].chargeId).toBe(confirmed[0].chargeId);
      const identities = (await adminQuery(`select studio_id,client_id,session_id,
        stripe_account_id,stripe_customer_id,stripe_payment_intent_id,stripe_charge_id,
        stripe_refund_id,stripe_livemode from public.payment_charge_attempts
        where id=$1 and studio_id=$2`, [attemptId, seed.studioId])).rows;
      expect(identities).toEqual([{ studio_id: seed.studioId, client_id: b.clientId,
        session_id: b.sessionId, stripe_account_id: account.accountId,
        stripe_customer_id: card.customerId, stripe_payment_intent_id: pi[0].resultId,
        stripe_charge_id: confirmed[0].chargeId, stripe_refund_id: refunds[0].resultId,
        stripe_livemode: false }]);
      const lineage = (await adminQuery(`select p.studio_id,p.client_id,p.session_id,s.appointment_id,i.id as intake_id
        from public.payment_charge_attempts p join public.sessions s on s.id=p.session_id and s.studio_id=p.studio_id and s.client_id=p.client_id
        join public.client_intake_forms i on i.client_id=p.client_id and i.studio_id=p.studio_id
        where p.id=$1 and p.studio_id=$2 and i.id=$3`, [attemptId, seed.studioId, intakeId])).rows;
      expect(lineage).toEqual([{ studio_id: seed.studioId, client_id: b.clientId, session_id: b.sessionId, appointment_id: appointmentId, intake_id: intakeId }]);
      expect((await adminQuery(`select service_id from public.appointments
        where id=$1 and studio_id=$2 and client_id=$3`,
      [appointmentId, seed.studioId, b.clientId])).rows).toEqual([{ service_id: pricedService[0].id }]);
      expect(await readClinicalIntegritySnapshot(b.sessionId)).toEqual(beforeClinical);
      expect(await getSessionContentDigest(b.sessionId)).toBe(digest);
    });
    testInfo.annotations.push({ type: "notification-truth", description: `${country}: booking email=FAKE_REFUSED; receipt email=FAKE_ACCEPTED_NOT_DELIVERED; SMS=SKIP(studio_toggle_off,0attempts); Google=DISABLED_PRECONDITIONS(connection_flag_false,outbound_sync_false,no_studio_connection,worker_false). No SDK-wide SMS/Google egress measurement claimed.` });
    journeys.push({ ...b, appointmentId, intakeId, attemptId, clientName: seed.clientName, digest });
  }
  expect(new Set(journeys.map((x) => x.studioId)).size).toBe(2);
  expect(new Set(journeys.map((x) => x.clientId)).size).toBe(2);
  expect(new Set(journeys.map((x) => x.accountId)).size).toBe(2);
  const providerBefore = readFakeStripeCalls();
  const moneyBefore = await Promise.all(journeys.map((x) => attemptState(x.attemptId)));
  await test.step("each other owner and an anonymous context are denied without clinical or money effects", async () => {
    for (let i = 0; i < journeys.length; i++) {
      const actor = journeys[i], target = journeys[1 - i];
      await loginByMagicLink(page, actor.ownerEmail);
      await page.goto(`/clients/${target.clientId}/sessions/${target.sessionId}`);
      await expect(page.getByText(/could not be found|not found/i).first()).toBeVisible();
      await expect(page.getByRole("region", { name: "Session payment" })).toHaveCount(0);
      await expect(page.getByText(target.clientName, { exact: true })).toHaveCount(0);
    }
    const anon = await browser.newPage({ baseURL: PAYMENT_E2E_APP_ORIGIN });
    anon.on("request", (r: Request) => { if (/api\.stripe\.com/.test(r.url())) stripeNetwork.push(r.url()); });
    try {
      for (const target of journeys) {
        await anon.goto(`/clients/${target.clientId}/sessions/${target.sessionId}`);
        await anon.waitForURL(/login/, { timeout: 15_000 });
      }
    } finally { await anon.close(); }
    expect(readFakeStripeCalls()).toEqual(providerBefore);
    expect(await Promise.all(journeys.map((x) => attemptState(x.attemptId)))).toEqual(moneyBefore);
    for (const target of journeys) expect(await getSessionContentDigest(target.sessionId)).toBe(target.digest);
  });
  expect(stripeNetwork).toEqual([]);
  expect(stripeEgressGuardArmed()).toBe(true); expect(readStripeEgress()).toEqual([]);
});
