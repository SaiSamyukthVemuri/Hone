import { test, expect, type Request } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  seedEligiblePaymentWithLogin,
  getSessionPaymentAttemptRows,
  idempotencySelectorForAttempt,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  type PaymentSeed,
} from "./helpers/payment-fixture";
import { expectPreparedDurable, sessionPaymentRegion } from "./helpers/checkout-flow";
import { seedE2eMember } from "../e2e/helpers/seed";
import { loginByMagicLink } from "../e2e/helpers/flows";
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
//   HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all npx playwright test --config playwright.charting-payment.config.ts   (after building with the payment config's server env)
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

    // The fake refuses a declined charge the way Stripe does: the create call throws a card error carrying the PaymentIntent, and a signed payment_failed event
    // follows. The executor never records a terminal failure from the thrown error (the intent is not confirmed canceled), so the attempt waits as pending_stripe
    // and the WEBHOOK moves it to failed. Polled from the database until it settles, never asserted at an instant that races the event.
    const attemptState = async () =>
      (await adminQuery(`select status, stripe_status from public.payment_charge_attempts where session_id = $1 order by created_at`, [seed.sessionId])).rows as Array<{ status: string; stripe_status: string | null }>;
    await expect.poll(async () => (await attemptState()).map((r) => r.status), { timeout: 30_000, intervals: [250] }).toEqual(["failed"]);
    const state = (await attemptState())[0];
    expect(state.status).not.toBe("succeeded");
    await expect(page.getByTestId("payment-summary-paid")).toHaveCount(0);
    // The fake counts a processor "effect" for every NEW PaymentIntent create, captured or not. A decline therefore shows exactly ONE effect: one intent created and
    // left uncaptured. "No money moved" is that one intent plus no succeeded attempt (the attempt ends failed), and "no retry" is that the count stays 1.
    expect(countEffectsForAccount(seed.connectedAccountId), "a declined charge created exactly one intent, which nothing captured").toBe(1);
    await expect(page.getByTestId("payment-summary-paid")).toHaveCount(0);
    const attempts = (await getSessionPaymentAttemptRows(seed.sessionId)).length;

    await page.getByTestId("charting-view-toggle").click();
    await expect(page.getByTestId("charting-view-root")).toHaveAttribute("data-charting-view", "current", { timeout: T });
    await expect(page.getByTestId("payment-summary-paid")).toHaveCount(0);
    expect((await getSessionPaymentAttemptRows(seed.sessionId)).length, "no second attempt appeared").toBe(attempts);
    expect(countEffectsForAccount(seed.connectedAccountId), "switching views created no second intent (no retry)").toBe(1);
    expect((await attemptState()).map((r) => r.status), "and the attempt is still the one failed attempt").toEqual(["failed"]);
  } finally {
    await cleanupPaymentScenario(seed.studioId);
    cleanupFakeStripeLedger();
    await closePool();
  }
});

test("roles: the owner sees the Session payment region in both views (control); a practitioner in the same studio sees neither the region nor its controls", async ({ page, browser }) => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  const seed = await seedEligiblePaymentWithLogin({ label: "view-roles", bookedService: { name: "View Roles", priceCents: 22500 } });
  try {
    // Owner: the SAME locator the practitioner assertion uses, so a renamed region cannot make the practitioner case pass.
    await openInNewView(page, seed);
    await expect(sessionPaymentRegion(page), "owner, New view: the region exists (positive control)").toBeVisible({ timeout: T });
    await page.getByTestId("charting-view-toggle").click();
    await expect(page.getByTestId("charting-view-root")).toHaveAttribute("data-charting-view", "current", { timeout: T });
    await expect(sessionPaymentRegion(page), "owner, Current view: the region exists (positive control)").toBeVisible({ timeout: T });

    const member = await seedE2eMember(seed);
    const ctx = await browser.newContext();
    try {
      const p2 = await ctx.newPage();
      await loginByMagicLink(p2, member.email);
      await p2.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
      await expect(p2.getByTestId("charting-view-toggle"), "the practitioner reaches the chart, so an absent region is the role, not a refused page").toBeVisible({ timeout: T });
      for (const view of ["current", "new"] as const) {
        const toggle = p2.getByTestId("charting-view-toggle");
        if ((await toggle.getAttribute("aria-checked")) !== String(view === "new")) await toggle.click();
        await expect(p2.getByTestId("charting-view-root")).toHaveAttribute("data-charting-view", view, { timeout: T });
        await expect(sessionPaymentRegion(p2), `${view}: no payment region for a practitioner`).toHaveCount(0);
        await expect(p2.getByRole("button", { name: /prepare session payment|run charge/i })).toHaveCount(0);
      }
    } finally {
      await ctx.close();
    }
  } finally {
    await cleanupPaymentScenario(seed.studioId);
    cleanupFakeStripeLedger();
  }
});
