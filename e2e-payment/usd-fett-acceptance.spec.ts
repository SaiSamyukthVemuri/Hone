import { test, expect, type Request } from "@playwright/test";
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
  readFakeStripeCalls,
  callsForAccount,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";
import { seedStudio } from "../tests/db/helpers/harness";
import { seedUsdPaymentLayer } from "../tests/db/helpers/usd-payment-fixture";

// ===========================================================================
// PAY-CCY-06 (#824) — the Fett USD acceptance flow, on the fake processor
// ===========================================================================
//
// The scripted payment step of the Friday rehearsal, built from the COMPOSABLE
// USD layer (tests/db/helpers/usd-payment-fixture.ts) that DB/WAIT can lay onto
// the synthetic Fett studio (#853). Here it is laid onto a plain harness studio
// in Los Angeles so this spec does not depend on #853 landing first.
//
//   A. prepare -> charge -> RECEIPT -> refund, in USD, end to end.
//   B. wrong-country refusal: a US studio whose Stripe account Stripe reported
//      as Canadian is refused before anything is prepared or sent to Stripe.
//
// The Canadian regression is the rest of this lane's specs, run alongside.
// Nothing here reaches Stripe: the fake processor records every call and
// `api.stripe.com` is asserted untouched.

const PRICE_CENTS = 18_500; // $185.00

type Built = { studioId: string; clientId: string; sessionId: string; accountId: string; ownerEmail: string; clientEmail: string };
const built: Built[] = [];
const stripeNetwork: string[] = [];

async function build(label: string, accountCountry: "US" | "CA"): Promise<Built> {
  const s = await seedStudio(`fett-usd-${label}`);
  await adminQuery(`update public.studios set timezone = 'America/Los_Angeles' where id = $1`, [s.studioId]);
  const { account, card, visit } = await seedUsdPaymentLayer(s, { priceCents: PRICE_CENTS, accountCountry });
  const ownerEmail = await attachOwnerLogin(s, `fett-usd-${label}`);
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

test("A · US studio: prepare, charge, receipt and refund in USD", async ({ page }) => {
  page.on("request", (r: Request) => {
    if (/api\.stripe\.com/.test(r.url())) stripeNetwork.push(r.url());
  });
  const b = await build("happy", "US");

  await loginByMagicLink(page, b.ownerEmail);
  await page.goto(`/clients/${b.clientId}/sessions/${b.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });

  await expect(region.getByText("Final charge (USD)")).toBeVisible({ timeout: 20_000 });
  await expect(region.getByLabel("Final charge in US dollars")).toHaveValue("185.00");
  await region.getByRole("button", { name: /prepare session payment/i }).click();
  const runCharge = region.getByRole("button", { name: /^run charge$/i });
  await expect(runCharge).toBeVisible({ timeout: 20_000 });

  const [attempt] = await getSessionPaymentAttemptRows(b.sessionId);
  expect(attempt).toBeDefined();
  configureFakeStripeOutcome(idempotencySelectorForAttempt(attempt.id), "success");
  await runCharge.click();
  await region.getByRole("button", { name: /confirm: run charge/i }).click();
  await expect(region.getByTestId("payment-summary-paid")).toContainText(/Paid · \$185\.00/, {
    timeout: 30_000,
  });

  const pi = readFakeStripeCalls().find((c) => c.method === "pi_create" && c.stripeAccount === b.accountId)!;
  expect(pi).toMatchObject({ amountCents: PRICE_CENTS, currency: "usd", replay: false });

  // RECEIPT. The automatic receipt goes to the client's card-on-file email,
  // which the fixture made acceptable to the fake email transport.
  await expect
    .poll(
      async () =>
        (
          await adminQuery(
            `select receipt_status, receipt_email_to from public.payment_charge_attempts where id = $1`,
            [attempt.id],
          )
        ).rows[0],
      { timeout: 30_000 },
    )
    .toEqual({ receipt_status: "sent", receipt_email_to: b.clientEmail });

  // REFUND, as the owner.
  await page.reload();
  const after = page.getByRole("region", { name: "Session payment" });
  await after.getByRole("button", { name: /^refund charge$/i }).click();
  await after.getByRole("button", { name: /confirm: refund charge/i }).click();
  await expect(after.getByText("Refund succeeded.")).toBeVisible({ timeout: 30_000 });

  const row = await adminQuery(
    `select status, currency, amount_cents, refund_status, refund_amount_cents
       from public.payment_charge_attempts where id = $1`,
    [attempt.id],
  );
  expect(row.rows[0]).toEqual({
    status: "succeeded",
    currency: "usd",
    amount_cents: PRICE_CENTS,
    refund_status: "succeeded",
    refund_amount_cents: PRICE_CENTS,
  });
  const refunds = callsForAccount(b.accountId).filter((c) => c.method === "refund_create");
  expect(refunds).toHaveLength(1);
  expect(refunds[0].amountCents).toBe(PRICE_CENTS);
  expect(stripeNetwork).toEqual([]);
});

test("B · wrong-country refusal: nothing is prepared and Stripe is never called", async ({ page }) => {
  const b = await build("wrong-country", "CA");

  await loginByMagicLink(page, b.ownerEmail);
  await page.goto(`/clients/${b.clientId}/sessions/${b.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });

  await expect(region.getByText(/registered in a different country/i)).toBeVisible({ timeout: 20_000 });
  await expect(region.getByRole("button", { name: /prepare session payment/i })).toHaveCount(0);

  // The owner's settings page names the mismatch and promises no replacement.
  await page.goto("/settings/payments");
  const card = page.getByTestId("payment-country-card");
  await expect(card).toHaveAttribute("data-tone", "blocked");
  await expect(card).toContainText("United States · charges in USD");
  await expect(card).toContainText(/registered in Canada, not United States/);

  expect(await getSessionPaymentAttemptRows(b.sessionId)).toHaveLength(0);
  expect(callsForAccount(b.accountId)).toHaveLength(0);
});
