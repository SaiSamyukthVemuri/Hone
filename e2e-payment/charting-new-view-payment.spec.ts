import { test, expect, type Request } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  seedEligiblePaymentWithLogin,
  getSessionPaymentAttemptRows,
  idempotencySelectorForAttempt,
  cleanupPaymentScenario,
  closePool,
  type PaymentSeed,
} from "./helpers/payment-fixture";
import { expectPreparedDurable, sessionPaymentRegion } from "./helpers/checkout-flow";
import {
  resetFakeStripeLedger,
  clearFakeStripeOutcome,
  configureFakeStripeOutcome,
  countEffectsForAccount,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";

// HON-80, payment states on the FAKE-STRIPE lane, from the session page in New view. Nothing real: the guarded fake processor is the only one that exists in
// this lane, the browser is watched for any request to Stripe, and the synthetic seed is local.
//
// Opt-in like the charting spec: run with the app server started with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all in its environment (the payment config applies its
// own server env over the inherited one, so the variable reaches the server), via
//   HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all npx playwright test --config playwright.payment.config.ts charting-new-view-payment
test.skip(process.env.HONE_CHARTING_NEW_VIEW_STUDIO_IDS !== "all", "needs the app server started with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all");

const T = 20_000;
const stripeRequests: string[] = [];

async function openInNewView(page: import("@playwright/test").Page, seed: PaymentSeed) {
  page.on("request", (req: Request) => {
    if (/api\.stripe\.com/.test(req.url())) stripeRequests.push(req.url());
  });
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const toggle = page.getByTestId("charting-view-toggle");
  await expect(toggle, "the switch must exist: start the app server with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all in its environment").toBeVisible({ timeout: T });
  if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
  await expect(page.getByTestId("charting-view-root")).toHaveAttribute("data-charting-view", "new", { timeout: T });
}

test.afterEach(async () => {
  expect(stripeRequests, "the browser never reaches Stripe").toEqual([]);
});

test("success: prepare, the confirmation names the amount and the action, run, Paid; the same in Current", async ({ page }) => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  const seed = await seedEligiblePaymentWithLogin({ label: "view-success", bookedService: { name: "View Success", priceCents: 22500 } });
  try {
    await openInNewView(page, seed);
    const region = sessionPaymentRegion(page);
    await page.getByRole("button", { name: /prepare session payment/i }).click();
    await expectPreparedDurable(region);
    await expect(region).toContainText("$225.00");
    const rows = await getSessionPaymentAttemptRows(seed.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ready");
    configureFakeStripeOutcome(idempotencySelectorForAttempt(rows[0].id), "success");

    await region.getByRole("button", { name: /^run charge$/i }).click();
    const confirm = region.getByRole("button", { name: /confirm: run charge/i });
    await expect(confirm, "the second step names the action").toBeVisible();
    await expect(region, "and the amount").toContainText("$225.00");
    await confirm.click();

    await expect(page.getByTestId("payment-summary-paid")).toContainText(/Paid · \$225\.00/, { timeout: 30_000 });
    expect((await getSessionPaymentAttemptRows(seed.sessionId))[0].status).toBe("succeeded");
    expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);

    await page.getByTestId("charting-view-toggle").click();
    await expect(page.getByTestId("charting-view-root")).toHaveAttribute("data-charting-view", "current", { timeout: T });
    await expect(page.getByTestId("payment-summary-paid")).toContainText(/Paid · \$225\.00/);
    expect(countEffectsForAccount(seed.connectedAccountId), "switching views moved no money").toBe(1);
  } finally {
    await cleanupPaymentScenario(seed.studioId);
    cleanupFakeStripeLedger();
  }
});

test("failure: a declined charge never shows Paid, and switching views changes nothing", async ({ page }) => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  const seed = await seedEligiblePaymentWithLogin({ label: "view-decline", bookedService: { name: "View Decline", priceCents: 22500 } });
  try {
    await openInNewView(page, seed);
    const region = sessionPaymentRegion(page);
    await page.getByRole("button", { name: /prepare session payment/i }).click();
    await expectPreparedDurable(region);
    const rows = await getSessionPaymentAttemptRows(seed.sessionId);
    configureFakeStripeOutcome(idempotencySelectorForAttempt(rows[0].id), "decline");

    await region.getByRole("button", { name: /^run charge$/i }).click();
    await region.getByRole("button", { name: /confirm: run charge/i }).click();

    await expect.poll(async () => (await getSessionPaymentAttemptRows(seed.sessionId))[0].status, { timeout: 30_000 }).not.toMatch(/^(ready|pending_stripe)$/);
    const status = (await getSessionPaymentAttemptRows(seed.sessionId))[0].status;
    expect(status).not.toBe("succeeded");
    await expect(page.getByTestId("payment-summary-paid")).toHaveCount(0);
    const attempts = (await getSessionPaymentAttemptRows(seed.sessionId)).length;

    await page.getByTestId("charting-view-toggle").click();
    await expect(page.getByTestId("charting-view-root")).toHaveAttribute("data-charting-view", "current", { timeout: T });
    await expect(page.getByTestId("payment-summary-paid")).toHaveCount(0);
    expect((await getSessionPaymentAttemptRows(seed.sessionId)).length, "no second attempt appeared").toBe(attempts);
  } finally {
    await cleanupPaymentScenario(seed.studioId);
    cleanupFakeStripeLedger();
    await closePool();
  }
});
