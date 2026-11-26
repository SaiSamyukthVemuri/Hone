import { expect, test } from "@playwright/test";
import { addDays, todayInTz } from "../lib/booking/tz";
import { loginAsOwner } from "./helpers/flows";
import {
  getClientAppointmentsWithPractitioner,
  getE2eServiceId,
  getStudioTimezone,
  seedE2eDashboardClient,
  seedE2eEndedAppointmentSession,
  seedE2eStudio,
  seedE2eTodayAppointment,
  sql,
} from "./helpers/seed";

test("Rebook opens the full calendar and returns to the original visit with its new upcoming appointment", async ({ page }) => {
  const studio = await seedE2eStudio();
  const client = await seedE2eDashboardClient(studio, { label: "Rebooking client" });
  const { appointmentId } = await seedE2eTodayAppointment(studio, {
    clientId: client.clientId, startsMinutesFromNow: -30, endsMinutesFromNow: 0, withService: true,
  });
  const serviceId = await getE2eServiceId(studio.studioId);
  const day = todayInTz(await getStudioTimezone(studio.studioId));
  const nextWeek = addDays(day, 7);
  await loginAsOwner(page, studio);
  await page.goto("/dashboard?period=month");
  const row = page.locator(`#appointment-${appointmentId}`);
  await row.getByRole("link", { name: "Rebook", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === "/calendar" && url.searchParams.get("view") === "week" && url.searchParams.get("rebook") === appointmentId);
  await page.getByTestId("calendar-next").click();
  await page.getByRole("button", { name: `Open quick-book draft for ${nextWeek}`, exact: true }).press("Enter");
  const drawer = page.getByRole("dialog", { name: "New appointment" });
  await expect(drawer.getByText(client.name, { exact: true })).toBeVisible();
  await expect(drawer.getByRole("combobox").first()).toHaveValue(serviceId);
  await drawer.getByRole("button", { name: /^\d{1,2}:\d{2}\s?(AM|PM)$/i }).last().click();
  await drawer.getByRole("button", { name: "Book appointment", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === "/dashboard" && url.searchParams.get("period") === "month" && url.hash === `#appointment-${appointmentId}`);
  const appointments = await getClientAppointmentsWithPractitioner(studio.studioId, client.clientId);
  expect(appointments).toHaveLength(2);
  const newVisit = appointments.find(visit => visit.id !== appointmentId)!;
  await expect(row.locator(`a[href="/calendar/${newVisit.id}"]`)).toBeVisible();
});

test("Chart opens the visit’s linked session or the appointment-bound modality picker without creating a session", async ({ page }) => {
  const studio = await seedE2eStudio();
  const linked = await seedE2eEndedAppointmentSession(studio, { endedHoursAgo: 1, charted: true });
  const client = await seedE2eDashboardClient(studio, { label: "Uncharted client" });
  const unlinked = await seedE2eTodayAppointment(studio, {
    clientId: client.clientId, startsMinutesFromNow: -30, endsMinutesFromNow: 0,
  });
  await loginAsOwner(page, studio);
  await page.locator(`#appointment-${linked.appointmentId}`).getByRole("link", { name: "Chart", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/clients/${linked.clientId}/sessions/${linked.sessionId}`);
  await expect(page.getByRole("heading", { level: 1, name: /electrolysis session/i })).toBeVisible();
  await page.goBack();
  await page.locator(`#appointment-${unlinked.appointmentId}`).getByRole("link", { name: "Chart", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/clients/${client.clientId}/sessions/new` && url.searchParams.get("appointment_id") === unlinked.appointmentId);
  await expect(page.getByRole("button", { name: /electrolysis/i })).toBeVisible();
  const sessions = await sql<{ id: string }>(
    "select id from public.sessions where studio_id = $1 and client_id = $2",
    [studio.studioId, client.clientId],
  );
  expect(sessions).toHaveLength(0);
});

test("Checkout keeps a partial e-transfer draft through completion and records only the confirmed receipt", async ({ page }) => {
  const studio = await seedE2eStudio();
  const { clientId } = await seedE2eDashboardClient(studio, { label: "Checkout client" });
  const serviceId = await getE2eServiceId(studio.studioId);
  await sql("update public.services set price_cents = 9000 where id = $1 and studio_id = $2", [serviceId, studio.studioId]);
  await sql(
    `insert into public.studio_payment_jurisdictions
       (studio_id, payment_country, payment_currency, source, verification_reference)
     values ($1, 'CA', 'cad', 'operator', 'synthetic dashboard checkout')`,
    [studio.studioId],
  );
  const { appointmentId } = await seedE2eTodayAppointment(studio, {
    clientId, startsMinutesFromNow: -45, endsMinutesFromNow: -15, withService: true,
  });
  const receipts = () => sql(
    `select method, reference_fee_cents, quoted_amount_cents, amount_cents, fee_adjustment_reason
       from public.appointment_settlements where appointment_id = $1 order by recorded_at`,
    [appointmentId],
  );

  await loginAsOwner(page, studio);
  await page.locator(`#appointment-${appointmentId}`).getByRole("button", { name: "Checkout", exact: true }).click();
  const draft = page.getByRole("alertdialog");
  await expect(draft.getByRole("button", { name: "Stripe", exact: true })).toBeDisabled();
  for (const name of ["Cash", "E-transfer", "Other external", "Still owes", "Fee waived"]) {
    await expect(draft.getByRole("button", { name, exact: true })).toBeEnabled();
  }
  await expect(draft.getByRole("button", { name: /send portal link/i })).toHaveCount(0);
  await draft.getByRole("button", { name: "E-transfer", exact: true }).click();
  await draft.getByLabel("Final fee", { exact: true }).fill("75.50");
  await draft.getByLabel("Reason for price adjustment", { exact: true }).fill("Shortened visit");
  await draft.getByLabel("Amount received", { exact: true }).fill("50.25");
  const confirmation = "Confirm payment · $50.25 CAD";
  await expect(draft.getByRole("button", { name: confirmation, exact: true })).toBeDisabled();
  await draft.getByRole("button", { name: "Finish visit", exact: true }).click();

  const checkout = page.getByRole("dialog");
  await expect(checkout.getByRole("button", { name: "E-transfer", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(checkout.getByLabel("Final fee", { exact: true })).toHaveValue("75.50");
  await expect(checkout.getByLabel("Amount received", { exact: true })).toHaveValue("50.25");
  await expect(checkout.getByText("Balance remaining $25.25 CAD", { exact: true })).toBeVisible();
  expect(await receipts()).toEqual([]);
  await checkout.getByRole("button", { name: confirmation, exact: true }).click();
  await expect.poll(receipts).toEqual([{
    method: "paid_e_transfer", reference_fee_cents: 9000, quoted_amount_cents: 7550,
    amount_cents: 5025, fee_adjustment_reason: "Shortened visit",
  }]);
  expect(await sql("select id from public.payment_charge_attempts where studio_id = $1", [studio.studioId])).toEqual([]);
});
