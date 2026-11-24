import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { addDays, todayInTz } from "../lib/booking/tz";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  getClientAppointmentsWithPractitioner,
  getE2eServiceId,
  getStudioTimezone,
  seedE2eActiveCardOnFile,
  seedE2eCardOnFileCapability,
  seedE2eDashboardMemoryClient,
  seedE2eStudio,
  sql,
} from "../e2e/helpers/seed";

// RECORDED ACCEPTANCE WALKTHROUGH for the dashboard visit workflow (#1775), on desktop and on a phone.
// FAKE STRIPE LANE ONLY: this file lives under e2e-payment/, whose config starts the app with the server-only fake
// Stripe markers, so no real charge, refund, email or SMS can leave it. Video is on for every run.
//
// One client, one visit, in the order a practitioner would meet it:
//   1. Last visit details opened ONCE, showing the settings and the notes;
//   2. a pinned note added under the client's name;
//   3. a one-visit reminder shown for its visit and gone for the next one;
//   4. Checkout with all six payment choices and an editable fee ($90 -> $75.50, $50.25 by e-transfer);
//   5. Rebook through the full calendar and back to the SAME dashboard row, next appointment visible;
//   6. Chart opening the SAME session both times.

const SCREENS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, touch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, touch: true },
] as const;

const PLAN = "Drop one energy step and re-check tolerance";
const CAUTION = "Reactive erythema on the upper lip";
const PINNED = "Prefers the window chair";

// Video is recorded for every run; it must be set at the top level of the file.
test.use({ video: "on" });

for (const screen of SCREENS) {
  test.describe(`dashboard visit workflow — ${screen.name}`, () => {
    test.use({ viewport: screen.viewport, hasTouch: screen.touch, isMobile: screen.touch });
    test.setTimeout(240_000);

    test(`from last visit to checkout, rebook and chart (${screen.name})`, async ({ page }) => {
      const studio = await seedE2eStudio();
      await seedE2eCardOnFileCapability(studio);
      const { clientId, appointmentId } = await seedE2eDashboardMemoryClient(studio, { cautionNote: CAUTION, nextVisitNote: PLAN });
      const clientName = (await sql<{ name: string }>("select name from public.clients where id = $1", [clientId]))[0].name;
      const serviceId = await getE2eServiceId(studio.studioId);
      await sql("update public.services set price_cents = 9000, modality = 'electrolysis' where id = $1 and studio_id = $2", [serviceId, studio.studioId]);
      await sql(
        `insert into public.studio_payment_jurisdictions (studio_id, payment_country, payment_currency, source, verification_reference)
         values ($1, 'CA', 'cad', 'operator', 'synthetic dashboard workflow')`,
        [studio.studioId],
      );
      await seedE2eActiveCardOnFile(studio, clientId);
      const tz = await getStudioTimezone(studio.studioId);
      // The memory client's own appointment today is the visit: it is the immediate next one after the charted prior visit.
      await sql("update public.appointments set service_id = $2 where id = $1", [appointmentId, serviceId]);
      const sessionId = randomUUID();
      const practitionerId = (await sql<{ id: string }>("select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1", [studio.studioId]))[0].id;
      // The visit is still ahead at first, which is when its one-visit reminder is meant to show. Later the visit happens:
      // see theVisitHappens() below, which moves it into the past and gives it its charted session.
      const theVisitHappens = async () => {
        await sql(
          `update public.appointments set starts_at = now() - interval '45 minutes', ends_at = now() - interval '15 minutes',
                  blocked_ends_at = now() - interval '15 minutes' where id = $1`,
          [appointmentId],
        );
        await sql(
          `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, appointment_id, started_at)
           values ($1,$2,$3,$4,'electrolysis',$5, now() - interval '40 minutes')`,
          [sessionId, studio.studioId, clientId, practitionerId, appointmentId],
        );
        await sql(
          `insert into public.session_blocks (id, studio_id, session_id, sort_order, primary_area, mode, energy_level, minutes_performed, machine_frequency)
           values ($1,$2,$3,1,'Chin','thermo',5,10,'13.56 MHz')`,
          [randomUUID(), studio.studioId, sessionId],
        );
      };
      const row = (p: Page) => p.locator(`#appointment-${appointmentId}`);
      const shot = (p: Page, n: string) => p.screenshot({ path: test.info().outputPath(`${screen.name}-${n}.png`), fullPage: true });

      await loginAsOwner(page, studio);
      await page.goto("/dashboard?period=month");
      await expect(row(page)).toBeVisible();

      await test.step("1. Last visit details opens once and shows the settings and the notes", async () => {
        await expect(row(page).getByTestId("dashboard-prep-remember")).toHaveText(`For this visit · ${PLAN}`);
        const toggle = row(page).getByRole("button", { name: /^Last visit details for / });
        await toggle.click();
        const full = row(page).getByTestId("dashboard-memory-full");
        await expect(full).toBeVisible();
        await expect(full.getByTestId("prep-area-label").first()).toBeVisible();
        await expect(full).toContainText("Synchro");
        await expect(full.getByTestId("prep-note-item").first()).toContainText(CAUTION);
        await expect(row(page).getByRole("button", { name: /^Hide last visit details for / })).toHaveAttribute("aria-expanded", "true");
        await shot(page, "1-last-visit-details");
      });

      await test.step("2. A pinned note is added under the client's name and stays after a reload", async () => {
        await row(page).getByRole("button", { name: `Add pinned note for ${clientName}` }).click();
        await row(page).getByRole("textbox", { name: `Pinned note for ${clientName}` }).fill(PINNED);
        await row(page).getByRole("button", { name: /^Save pinned note/ }).click();
        await expect(row(page).getByText(PINNED, { exact: true })).toBeVisible();
        await page.reload();
        await expect(row(page).getByText(PINNED, { exact: true })).toBeVisible();
        await shot(page, "2-pinned-note");
      });

      await theVisitHappens();
      await page.reload();

      await test.step("4. Checkout offers all six choices and an editable fee; $90 becomes $75.50 with $50.25 by e-transfer", async () => {
        await row(page).getByRole("button", { name: "Checkout", exact: true }).click();
        const draft = page.getByRole("alertdialog");
        for (const name of ["Stripe", "Cash", "E-transfer", "Other external", "Still owes", "Fee waived"]) {
          await expect(draft.getByRole("button", { name, exact: true }), `${name} is offered and usable`).toBeEnabled();
        }
        for (const name of ["Stripe", "Cash", "Other external", "Still owes", "Fee waived", "E-transfer"]) {
          await draft.getByRole("button", { name, exact: true }).click();
          await expect(draft.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
        }
        await draft.getByLabel("Final fee", { exact: true }).fill("75.50");
        await draft.getByLabel("Reason for price adjustment", { exact: true }).fill("Shortened visit");
        await draft.getByLabel("Amount received", { exact: true }).fill("50.25");
        await shot(page, "4a-checkout-draft");
        await draft.getByRole("button", { name: "Finish visit", exact: true }).click();
        const checkout = page.getByRole("dialog");
        await expect(checkout.getByLabel("Final fee", { exact: true })).toHaveValue("75.50");
        await expect(checkout.getByText("Balance remaining $25.25 CAD", { exact: true })).toBeVisible();
        const receipts = () => sql(
          `select method, reference_fee_cents, quoted_amount_cents, amount_cents from public.appointment_settlements where appointment_id = $1 order by recorded_at`,
          [appointmentId],
        );
        expect(await receipts()).toEqual([]);
        await shot(page, "4b-checkout-confirm");
        await checkout.getByRole("button", { name: "Confirm payment · $50.25 CAD", exact: true }).click();
        await expect.poll(receipts).toEqual([{ method: "paid_e_transfer", reference_fee_cents: 9000, quoted_amount_cents: 7550, amount_cents: 5025 }]);
        expect(await sql("select id from public.payment_charge_attempts where studio_id = $1", [studio.studioId])).toEqual([]);
        await page.goto("/dashboard?period=month");
        await expect(row(page)).toContainText("Part paid · e-transfer");
        await shot(page, "4c-after-checkout");
        // The balance itself is read back on the visit's own page, reloaded fresh: $25.25 still owed of $75.50.
        await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
        await expect(page.getByText(/\$25\.25 still owed of \$75\.50/)).toBeVisible();
        await shot(page, "4d-balance-on-the-visit");
        await page.goto("/dashboard?period=month");
      });

      await test.step("5. Rebook goes to the full calendar and returns to the same row with the next appointment", async () => {
        await row(page).getByRole("link", { name: "Rebook", exact: true }).click();
        await expect(page).toHaveURL((u) => u.pathname === "/calendar" && u.searchParams.get("rebook") === appointmentId);
        const nextWeek = addDays(todayInTz(tz), 7);
        await page.getByTestId("calendar-next").click();
        await page.getByRole("button", { name: `Open quick-book draft for ${nextWeek}`, exact: true }).press("Enter");
        const drawer = page.getByRole("dialog", { name: "New appointment" });
        await expect(drawer.getByText(clientName, { exact: true })).toBeVisible();
        await shot(page, "5a-rebook-drawer");
        await drawer.getByRole("button", { name: /^\d{1,2}:\d{2}\s?(AM|PM)$/i }).last().click();
        await drawer.getByRole("button", { name: "Book appointment", exact: true }).click();
        await expect(page).toHaveURL((u) => u.pathname === "/dashboard" && u.hash === `#appointment-${appointmentId}`);
        const visits = await getClientAppointmentsWithPractitioner(studio.studioId, clientId);
        const next = visits.find((v) => v.id !== appointmentId)!;
        await expect(row(page).locator(`a[href="/calendar/${next.id}"]`)).toBeVisible();
        await shot(page, "5b-back-on-the-row");

        await test.step("3. The one-visit reminder is not carried onto the next appointment", async () => {
          await page.goto(`/dashboard?day=${nextWeek}`);
          const later = page.locator(`#appointment-${next.id}`);
          await expect(later).toBeVisible();
          await expect(later).not.toContainText(PLAN);
          await expect(later.getByTestId("dashboard-prep-remember")).toHaveCount(0);
          await shot(page, "3-reminder-gone-next-visit");
          await page.goto("/dashboard?period=month");
        });
      });

      await test.step("6. Chart reopens the SAME session", async () => {
        const open = async () => {
          await row(page).getByRole("link", { name: "Chart", exact: true }).click();
          await expect(page).toHaveURL((u) => u.pathname === `/clients/${clientId}/sessions/${sessionId}`);
        };
        await open();
        await shot(page, "6a-chart-first");
        await page.goBack();
        await open();
        await shot(page, "6b-chart-second");
        expect(await sql("select id from public.sessions where studio_id = $1 and client_id = $2 and appointment_id = $3", [studio.studioId, clientId, appointmentId])).toHaveLength(1);
      });
    });
  });
}
