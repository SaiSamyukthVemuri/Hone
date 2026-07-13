import { test, expect, type Request } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  seedEligiblePaymentWithLogin,
  getSessionPaymentAttemptRows,
  readClinicalIntegritySnapshot,
  idempotencySelectorForAttempt,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  type PaymentSeed,
  type ClinicalIntegritySnapshot,
} from "./helpers/payment-fixture";
import {
  resetFakeStripeLedger,
  clearFakeStripeOutcome,
  configureFakeStripeOutcome,
  readFakeStripeCalls,
  countFakeStripeCalls,
  countFakeStripeInvocations,
  countFakeStripeEffects,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";

// ===========================================================================
// Quick-checkout payment — the iPad success journey (PR #419).
// ===========================================================================
//
// Drives the COMPLETE browser charge flow through the guarded fake-Stripe
// boundary: dashboard → quick checkout → prepare → explicit confirmation →
// execute → persisted Paid state, then proves the charge is idempotent, moved
// no real money, and left the clinical record untouched.
//
// The eligibility chain is the untouched, CI-proven fixture (the REAL
// getSessionPaymentEligibility resolver governs it — see the DB-integration
// lane tests/db/quick-checkout-eligibility.db.test.ts). Here the browser
// re-confirms it through the live server action (the modal shows the Prepare
// form only when the resolver returns eligible), then charges through the fake.

const AMOUNT_LABEL = /Paid · \$225\.00/;

let seed: PaymentSeed;
let clinicalBefore: ClinicalIntegritySnapshot;
const stripeNetworkRequests: string[] = [];

test.beforeAll(async () => {
  // A clean fake ledger for this run (survives a Playwright retry).
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  seed = await seedEligiblePaymentWithLogin({ label: "success" });
});

test.afterAll(async () => {
  try {
    await cleanupPaymentScenario(seed.studioId);
  } finally {
    cleanupFakeStripeLedger();
    await closePool();
  }
});

test("iPad success journey: dashboard → prepare → confirm → execute → persisted Paid", async ({
  page,
}) => {
  // Fail loudly if the browser ever tries to reach Stripe directly (belt; the
  // substantive no-network proof is that the fake ledger recorded the call and
  // the real client was never constructed).
  page.on("request", (req: Request) => {
    if (/api\.stripe\.com/.test(req.url())) stripeNetworkRequests.push(req.url());
  });

  // --- Pre-browser: assert the eligibility INPUTS + capture baselines (step 2/4).
  const facts = (
    await adminQuery(
      `select
         a.status as appt_status,
         (s.started_at is not null) as session_started,
         (s.finalized_at is null) as not_finalized,
         cpm.status as card_status,
         cpm.stripe_livemode as card_livemode,
         (sps.stripe_account_status = 'enabled' and sps.stripe_charges_enabled) as connect_enabled,
         sps.stripe_livemode as connect_livemode,
         s.price_paid_cents as amount
       from public.sessions s
       join public.appointments a on a.id = s.appointment_id
       join public.client_payment_methods cpm on cpm.client_id = s.client_id and cpm.studio_id = s.studio_id
       join public.studio_payment_settings sps on sps.studio_id = s.studio_id
       where s.id = $1`,
      [seed.sessionId],
    )
  ).rows[0] as Record<string, unknown>;
  expect(facts.appt_status).toBe("completed");
  expect(facts.session_started).toBe(true);
  expect(facts.not_finalized).toBe(true);
  expect(facts.card_status).toBe("active");
  expect(facts.card_livemode).toBe(false); // test mode
  expect(facts.connect_enabled).toBe(true);
  expect(facts.connect_livemode).toBe(false); // test mode
  expect(Number(facts.amount)).toBe(seed.expectedAmountMinor); // 22500

  // No attempt yet, and the fake ledger is empty (step 3).
  expect(await getSessionPaymentAttemptRows(seed.sessionId)).toHaveLength(0);
  expect(readFakeStripeCalls()).toHaveLength(0);

  clinicalBefore = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(clinicalBefore.exists).toBe(true);
  expect(clinicalBefore.started).toBe(true);

  // --- Log in as the real (magic-link) owner and open the dashboard (step 4/5).
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");

  // --- Locate the fixture appointment; Checkout visible, Paid not (steps 6-8).
  const checkoutButton = page.getByTestId("checkout-button");
  await expect(checkoutButton).toBeVisible();
  await expect(page.getByTestId("appointment-payment-paid")).toHaveCount(0);

  // --- Open quick checkout; confirm context, amount, saved-card, no ids (9-13).
  await checkoutButton.click();
  const modal = page.getByTestId("quick-checkout-modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByText(seed.clientName)).toBeVisible();
  await expect(modal.getByLabel("Amount in Canadian dollars")).toHaveValue("225.00");
  await expect(modal.getByText(/ending in 4242/i)).toBeVisible();
  // Processor identifiers are never shown by default (owner-only disclosure; and
  // there is no PaymentIntent yet anyway).
  await expect(modal.getByText(/pi_test_e2e/)).toHaveCount(0);

  // --- Prepare the payment (steps 14-15). The internal note is required.
  await modal
    .getByPlaceholder(/short note explaining the session payment/i)
    .fill("E2E success-path session payment");
  await modal.getByRole("button", { name: /prepare session payment/i }).click();

  // The modal loads trusted context ONCE per open (a server action), so a
  // successful prepare shows the in-modal confirmation; the persisted 'ready' row
  // + Run charge surface when the checkout is reopened with fresh context.
  await expect(modal.getByText(/session payment prepared/i)).toBeVisible();

  // --- Exactly one prepared attempt; ledger still empty (steps 16-18).
  const preparedRows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(preparedRows).toHaveLength(1);
  expect(preparedRows[0].status).toBe("ready");
  expect(readFakeStripeCalls()).toHaveLength(0);

  // --- Configure fake success for THIS attempt's server-generated selector (19-20).
  const attemptId = preparedRows[0].id;
  const selector = idempotencySelectorForAttempt(attemptId);
  configureFakeStripeOutcome(selector, "success");

  // --- Reopen the checkout so the prepared attempt drives the Ready panel. A
  //     'ready' attempt is still "chargeable", so the dashboard keeps Checkout.
  await modal.getByTestId("quick-checkout-close").click();
  await expect(modal).toHaveCount(0);
  await checkoutButton.click();
  await expect(modal).toBeVisible();

  // --- Execute the charge with the explicit two-click confirmation (21-23).
  const runCharge = modal.getByRole("button", { name: /^run charge$/i });
  await expect(runCharge).toBeVisible();
  await runCharge.click(); // arms the confirm step
  const confirmCharge = modal.getByRole("button", { name: /confirm: run charge/i });
  await expect(confirmCharge).toBeVisible();
  await confirmCharge.click();

  // --- Persisted Paid (steps 24-25).
  const paidLine = modal.getByTestId("payment-summary-paid");
  await expect(paidLine).toBeVisible({ timeout: 30_000 });
  await expect(paidLine).toContainText(AMOUNT_LABEL);

  // --- Exactly one succeeded attempt (step 26).
  const chargedRows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(chargedRows).toHaveLength(1);
  expect(chargedRows[0].status).toBe("succeeded");

  // --- Exactly one fake paymentIntents.create: 1 invocation, 1 effect (27-28).
  expect(countFakeStripeInvocations()).toBe(1);
  expect(countFakeStripeEffects()).toBe(1);
  const piCall = readFakeStripeCalls().find((c) => c.method === "pi_create")!;
  expect(piCall.replay).toBe(false);
  expect(piCall.idempotencyKey).toBe(selector);
  expect(piCall.stripeAccount).toBe(`acct_test_e2e_${seed.scenario.runId}`);
  expect(piCall.amountCents).toBe(seed.expectedAmountMinor);
  expect(piCall.currency).toBe("cad");
  expect(piCall.resultId).toMatch(/^pi_test_e2e_/);

  // --- No real Stripe network request occurred (step 29 + no-network proof).
  expect(stripeNetworkRequests).toEqual([]);
  // The fake recorded the processor call; no refund path ran.
  expect(countFakeStripeCalls("refund_create")).toBe(0);

  // --- Close the modal (step 30).
  await modal.getByTestId("quick-checkout-close").click();
  await expect(modal).toHaveCount(0);

  // --- Dashboard reflects the persisted Paid state after reload (steps 31-33).
  // (executeAction revalidates the session/clients paths, not /dashboard, so the
  // durable proof is the post-reload server render driven by the DB.)
  await page.goto("/dashboard");
  await expect(page.getByTestId("appointment-payment-paid")).toBeVisible();
  await expect(page.getByTestId("checkout-button")).toHaveCount(0);

  // --- Calendar surface shows the SAME persisted Paid; no charge affordance (34-37).
  await page.goto(`/calendar/${seed.appointmentId}`);
  await expect(page.getByTestId("appointment-payment-paid")).toBeVisible();
  await expect(page.getByTestId("checkout-button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /prepare session payment/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /run charge/i })).toHaveCount(0);

  // --- Attempt + fake call counts unchanged; no second charge (steps 38-39).
  const finalRows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(finalRows).toHaveLength(1);
  expect(finalRows[0].status).toBe("succeeded");
  expect(countFakeStripeInvocations()).toBe(1);
  expect(countFakeStripeEffects()).toBe(1);

  // --- Clinical record untouched: before === after (step 40 / Section 6).
  const clinicalAfter = await readClinicalIntegritySnapshot(seed.sessionId);
  expect(clinicalAfter).toEqual(clinicalBefore);
  expect(clinicalAfter.started).toBe(true); // still started, never finalized by payment
  expect(clinicalAfter.blockCount).toBe(clinicalBefore.blockCount);
  expect(clinicalAfter.areaCount).toBe(clinicalBefore.areaCount);
  expect(clinicalAfter.consultationNoteCount).toBe(clinicalBefore.consultationNoteCount);
  expect(clinicalAfter.skinHairNoteCount).toBe(clinicalBefore.skinHairNoteCount);
  // The session is not clinically finalized by taking payment.
  const finalizedCheck = (
    await adminQuery(`select finalized_at from public.sessions where id = $1`, [
      seed.sessionId,
    ])
  ).rows[0] as { finalized_at: string | null };
  expect(finalizedCheck.finalized_at).toBeNull();
});
