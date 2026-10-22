import { test, expect, type Page } from "@playwright/test";
import { loginByMagicLink } from "../e2e/helpers/flows";
import {
  adminQuery,
  cleanupPaymentScenario,
  closePool,
  seedEligiblePaymentWithLogin,
  type PaymentSeed,
} from "./helpers/payment-fixture";

// ===========================================================================
// PAY-CCY-07 (#871, option B) in the browser: which "paid outside Hone"
// outcomes a studio is offered, and what is recorded, by payment COUNTRY.
// ===========================================================================
//
//   CA  e-transfer is offered ("Paid by e-transfer") and records paid_e_transfer
//       in CAD; "Paid another way" keeps its Canadian wording. Unchanged.
//   US  e-transfer is NOT offered (Interac is a Canadian rail); "Paid another
//       way (Zelle, Venmo, check)" records paid_other_external in USD.
//
// No processor is involved: settlement records what the studio says happened
// and never takes a payment. The studios are seeded with NO connected account
// or card, which is also what lets the real 0214 command make one of them US
// (it refuses once a studio has payment history).
//
// NOT HERE, BY DESIGN: a US request that names paid_e_transfer anyway. A browser
// cannot submit an action the UI does not render; that refusal is proven where
// it is enforced, by tests/app/settlement-country-enforcement.test.ts (server
// action) and the 0224 database guard (#872).

const AMOUNT = "45.00";
const seeds: PaymentSeed[] = [];

async function seedStudioIn(country: "CA" | "US"): Promise<PaymentSeed> {
  const seed = await seedEligiblePaymentWithLogin({
    label: `settle-${country.toLowerCase()}`,
    connect: "missing_account",
    withCard: false,
  });
  seeds.push(seed);
  if (country === "US") {
    // The seed configures priced services, so the real command requires the
    // owner's acknowledgement that those prices are now USD (it otherwise
    // refuses with refused_priced_configuration). Given here, as the US fixture
    // (tests/db/helpers/usd-payment-fixture makeStudioUsd) does.
    const r = await adminQuery(
      `select out_result from public.set_studio_payment_jurisdiction($1,'US','usd','e2e:settlement-country','synthetic US studio',true,'fixture:settlement-country-US-USD')`,
      [seed.studioId],
    );
    expect(["initialized", "changed", "unchanged"]).toContain(r.rows[0]?.out_result);
    const jurisdiction = await adminQuery(
      `select payment_country,payment_currency from public.studio_payment_jurisdictions where studio_id=$1`, [seed.studioId]);
    expect(jurisdiction.rows[0]).toEqual({ payment_country: "US", payment_currency: "usd" });
  }
  return seed;
}

async function openSettlement(page: Page, seed: PaymentSeed) {
  await loginByMagicLink(page, seed.ownerEmail);
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });
  await expect(region).toBeVisible({ timeout: 20_000 });
  return region;
}

async function recorded(appointmentId: string) {
  const r = await adminQuery(
    `select method, amount_cents, currency
       from public.appointment_settlements where appointment_id = $1`,
    [appointmentId],
  );
  return r.rows as Array<{ method: string; amount_cents: number; currency: string }>;
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  try {
    for (const s of seeds) await cleanupPaymentScenario(s.studioId).catch(() => undefined);
  } finally {
    await closePool();
  }
});

test("CA · e-transfer is offered and records paid_e_transfer in CAD (unchanged)", async ({ page }) => {
  const seed = await seedStudioIn("CA");
  const region = await openSettlement(page, seed);

  const eTransfer = region.getByTestId("settlement-open-paid_e_transfer");
  await expect(eTransfer).toHaveText("Paid by e-transfer");
  await expect(region.getByTestId("settlement-open-paid_other_external")).toHaveText("Paid another way");
  await expect(region.getByText(/Zelle|Venmo/)).toHaveCount(0);

  await eTransfer.click();
  await region.getByTestId("settlement-amount").fill(AMOUNT);
  await region.getByTestId("settlement-confirm-paid_e_transfer").click();

  await expect(region.getByTestId("appointment-settlement-recorded")).toContainText("Paid · e-transfer", {
    timeout: 20_000,
  });
  await expect(region.getByTestId("appointment-settlement-recorded")).toContainText(/\$45\.00 CAD/);
  expect(await recorded(seed.appointmentId)).toEqual([
    { method: "paid_e_transfer", amount_cents: 4500, currency: "cad" },
  ]);
});

test("US · no e-transfer; 'Paid another way (Zelle, Venmo, check)' records paid_other_external in USD", async ({ page }) => {
  const seed = await seedStudioIn("US");
  const region = await openSettlement(page, seed);

  await expect(region.getByTestId("settlement-open-paid_cash")).toBeVisible();
  await expect(region.getByTestId("settlement-open-paid_e_transfer")).toHaveCount(0);
  await expect(region.getByText(/e-transfer/i)).toHaveCount(0);
  const other = region.getByTestId("settlement-open-paid_other_external");
  await expect(other).toHaveText("Paid another way (Zelle, Venmo, check)");

  await other.click();
  await region.getByTestId("settlement-amount").fill(AMOUNT);
  await region.getByTestId("settlement-confirm-paid_other_external").click();

  await expect(region.getByTestId("appointment-settlement-recorded")).toContainText("Paid · other", {
    timeout: 20_000,
  });
  await expect(region.getByTestId("appointment-settlement-recorded")).toContainText(/\$45\.00 USD/);
  expect(await recorded(seed.appointmentId)).toEqual([
    { method: "paid_other_external", amount_cents: 4500, currency: "usd" },
  ]);
});
