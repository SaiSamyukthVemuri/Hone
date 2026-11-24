import { expect, test, type Page } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  getE2eServiceId,
  seedE2eDashboardClient,
  seedE2eStudio,
  seedE2eTodayAppointment,
  sql,
} from "../e2e/helpers/seed";

// SAM'S $0 DECISION (24 Nov 2026), proved on the DASHBOARD checkout. The agreed price decides what $0 means:
//   ALREADY FREE  an explicit $0 price shows "No payment due"; the visit finishes with no reason, receipt or Stripe attempt.
//                 A MISSING price asks the practitioner to check the fee and is never read as free.
//   FEE WAIVED    a positive fee reduced to $0 (or the Fee waived choice) shows the original fee, asks a short reason, says
//                 "Confirm fee waiver", and records who waived it, why, and that no money was collected.
//   STILL OWES    a $90 fee with $0 paid today keeps the whole $90 outstanding.
// Every visit is RELOADED afterwards and its status and balance read back from the database and from the page.
// Fake Stripe lane only (e2e-payment): nothing here can charge a card or send a message.

async function visit(price: number | null) {
  const studio = await seedE2eStudio();
  const { clientId } = await seedE2eDashboardClient(studio, { label: "Zero fee client" });
  const serviceId = await getE2eServiceId(studio.studioId);
  await sql("update public.services set price_cents = $3 where id = $1 and studio_id = $2", [serviceId, studio.studioId, price]);
  await sql(
    `insert into public.studio_payment_jurisdictions (studio_id, payment_country, payment_currency, source, verification_reference)
     values ($1, 'CA', 'cad', 'operator', 'synthetic zero fee checkout')`,
    [studio.studioId],
  );
  const { appointmentId } = await seedE2eTodayAppointment(studio, {
    clientId, startsMinutesFromNow: -45, endsMinutesFromNow: -15, withService: true,
  });
  return { studio, appointmentId };
}

const settlements = (appointmentId: string) => sql<{
  method: string; reference_fee_cents: number | null; quoted_amount_cents: number | null; amount_cents: number;
  fee_adjustment_reason: string | null; note: string | null; recorded_by_practitioner_id: string | null;
}>(
  `select method, reference_fee_cents, quoted_amount_cents, amount_cents, fee_adjustment_reason, note, recorded_by_practitioner_id
     from public.appointment_settlements where appointment_id = $1 and superseded_at is null order by recorded_at`,
  [appointmentId],
);
const status = async (appointmentId: string) =>
  (await sql<{ status: string }>("select status from public.appointments where id = $1", [appointmentId]))[0].status;
const attempts = (studioId: string) => sql("select id from public.payment_charge_attempts where studio_id = $1", [studioId]);
const openCheckout = async (page: Page, appointmentId: string) => {
  await page.goto("/dashboard");
  await page.locator(`#appointment-${appointmentId}`).getByRole("button", { name: "Checkout", exact: true }).click();
  return page.getByRole("alertdialog");
};

test.describe("what $0 means at the dashboard till", () => {
  test("ALREADY FREE: an explicit $0 price says No payment due and finishes with no reason, receipt or Stripe attempt", async ({ page }) => {
    const { studio, appointmentId } = await visit(0);
    await loginAsOwner(page, studio);
    await page.goto("/dashboard");
    const row = page.locator(`#appointment-${appointmentId}`);
    // No Checkout, no reason and no receipt are offered: the row says No payment due and the visit is simply finished.
    await expect(row.getByText("No payment due", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Checkout", exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: "Mark completed", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Mark completed", exact: true }).click();
    await expect.poll(() => status(appointmentId)).toBe("completed");
    expect(await settlements(appointmentId)).toEqual([]);
    expect(await attempts(studio.studioId)).toEqual([]);
    await page.goto("/dashboard");
    await expect(page.locator(`#appointment-${appointmentId}`)).toContainText(/Completed/i);
    await expect(page.locator(`#appointment-${appointmentId}`).getByText("No payment due", { exact: true })).toBeVisible();
    expect(await settlements(appointmentId)).toEqual([]);
    expect(await attempts(studio.studioId)).toEqual([]);
  });

  test("MISSING PRICE: asks to check the fee, is never read as free, and records nothing", async ({ page }) => {
    const { studio, appointmentId } = await visit(null);
    await loginAsOwner(page, studio);
    const draft = await openCheckout(page, appointmentId);
    await expect(draft.getByText(/Check the fee before you finish the visit/i)).toBeVisible();
    await expect(draft.getByText("No payment due")).toHaveCount(0);
    expect(await settlements(appointmentId)).toEqual([]);
    expect(await attempts(studio.studioId)).toEqual([]);
    await page.reload();
    await expect(page.locator(`#appointment-${appointmentId}`)).not.toContainText("No payment due");
  });

  test("FEE WAIVED: a $90 fee reduced to $0 shows the original fee, needs a reason, and records who, why and no money", async ({ page }) => {
    const { studio, appointmentId } = await visit(9000);
    await loginAsOwner(page, studio);
    const draft = await openCheckout(page, appointmentId);
    await expect(draft.getByText("Booked fee $90.00", { exact: false })).toBeVisible();
    await draft.getByLabel("Final fee", { exact: true }).fill("0.00");
    await expect(draft.getByText("Booked fee $90.00", { exact: false })).toBeVisible();
    await expect(draft.getByLabel("Reason for price adjustment", { exact: true })).toBeVisible();
    await expect(draft.getByRole("button", { name: "Confirm fee waiver", exact: true })).toBeDisabled();
    await draft.getByLabel("Reason for price adjustment", { exact: true }).fill("Complimentary touch-up");
    await draft.getByRole("button", { name: "Finish visit", exact: true }).click();
    const checkout = page.getByRole("dialog");
    await checkout.getByRole("button", { name: "Confirm fee waiver", exact: true }).click();
    await expect.poll(async () => (await settlements(appointmentId)).length).toBe(1);
    const [row] = await settlements(appointmentId);
    expect(row).toMatchObject({
      method: "waived", reference_fee_cents: 9000, quoted_amount_cents: 0, amount_cents: 9000,
      fee_adjustment_reason: "Complimentary touch-up",
    });
    expect(row.recorded_by_practitioner_id).toBeTruthy();
    expect(await attempts(studio.studioId)).toEqual([]);
    expect(await status(appointmentId)).toBe("completed");
    await page.goto("/dashboard");
    await expect(page.locator(`#appointment-${appointmentId}`)).toContainText(/Fee waived/i);
    expect(await settlements(appointmentId)).toHaveLength(1);
  });

  test("FEE WAIVED by choice: the Fee waived option also asks for a reason before it records anything", async ({ page }) => {
    const { studio, appointmentId } = await visit(9000);
    await loginAsOwner(page, studio);
    const draft = await openCheckout(page, appointmentId);
    await draft.getByRole("button", { name: "Fee waived", exact: true }).click();
    await draft.getByRole("button", { name: "Finish visit", exact: true }).click();
    const checkout = page.getByRole("dialog");
    await checkout.getByRole("button", { name: "Confirm fee waiver", exact: true }).click();
    await expect(checkout.getByRole("alert")).toContainText(/reason for the fee waiver/i);
    expect(await settlements(appointmentId)).toEqual([]);
    await checkout.getByLabel(/Reason for fee waiver/i).fill("Friend of the studio");
    await checkout.getByRole("button", { name: "Confirm fee waiver", exact: true }).click();
    await expect.poll(async () => (await settlements(appointmentId)).length).toBe(1);
    const [row] = await settlements(appointmentId);
    expect(row).toMatchObject({ method: "waived", amount_cents: 9000, note: "Friend of the studio" });
    expect(row.recorded_by_practitioner_id).toBeTruthy();
    expect(await attempts(studio.studioId)).toEqual([]);
    await page.goto("/dashboard");
    await expect(page.locator(`#appointment-${appointmentId}`)).toContainText(/Fee waived/i);
  });

  test("STILL OWES: a $90 fee with $0 paid today keeps the whole $90 outstanding", async ({ page }) => {
    const { studio, appointmentId } = await visit(9000);
    await loginAsOwner(page, studio);
    const draft = await openCheckout(page, appointmentId);
    await draft.getByRole("button", { name: "Still owes", exact: true }).click();
    await draft.getByRole("button", { name: "Finish visit", exact: true }).click();
    const checkout = page.getByRole("dialog");
    await checkout.getByRole("button", { name: "Record amount owed", exact: true }).click();
    await expect.poll(async () => (await settlements(appointmentId)).length).toBe(1);
    const [row] = await settlements(appointmentId);
    expect(row).toMatchObject({ method: "still_owes", amount_cents: 9000, quoted_amount_cents: 9000 });
    expect(await attempts(studio.studioId)).toEqual([]);
    expect(await status(appointmentId)).toBe("completed");
    await page.goto("/dashboard");
    await expect(page.locator(`#appointment-${appointmentId}`)).toContainText(/owes|owing|outstanding/i);
    expect(await settlements(appointmentId)).toHaveLength(1);
  });
});
