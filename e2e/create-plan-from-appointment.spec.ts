import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  seedFutureAppointmentAt,
  getStudioTimezone,
  getOwnerPractitionerId,
  getTreatmentPlanCount,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// "Create treatment plan" from an appointment (Chloe): the CTA on the appointment
// briefing opens the client's Treatment Plans tab with the EXISTING create form
// already open + focused; opening/cancelling creates nothing; only Save creates.

async function noOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `${label}: no horizontal overflow (${w.s} vs ${w.c})`).toBeLessThanOrEqual(w.c);
}

test("appointment CTA opens the create form (focused, no auto-create) on iPhone", async ({ browser }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(seed.studioId, ownerId, clientId, tz, "14:00");

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);

    await page.goto(`/calendar/${apptId}`);
    const cta = page.getByRole("link", { name: "Create treatment plan" });
    await expect(cta).toBeVisible({ timeout: 20_000 });
    await noOverflow(page, "appointment @390");
    await cta.click();

    // Landed on the treatment tab with the create form open + focused.
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+\?tab=treatment&create_plan=1&returnTo=/i);
    const nameInput = page.getByPlaceholder("e.g. Chin treatment plan");
    await expect(nameInput).toBeVisible({ timeout: 20_000 });
    await expect(nameInput).toBeFocused();
    await expect(page.getByRole("link", { name: "Back to appointment" })).toBeVisible();
    await noOverflow(page, "treatment tab @390 (form open)");

    // A) Opening created NOTHING.
    expect(await getTreatmentPlanCount(clientId)).toBe(0);

    // B) Cancel: form closes, URL drops the deep-link params, refresh keeps it closed, count 0.
    await page.getByRole("button", { name: /^Cancel$/ }).click();
    await expect(page).toHaveURL(new RegExp("/clients/" + clientId + "\\?tab=treatment$"));
    await expect(nameInput).toHaveCount(0);
    await page.reload();
    await expect(page.getByPlaceholder("e.g. Chin treatment plan")).toHaveCount(0);
    expect(await getTreatmentPlanCount(clientId)).toBe(0);

    // C) Save exactly one plan via the CTA + the EXISTING createTreatmentPlanAction.
    await page.goto(`/calendar/${apptId}`);
    await page.getByRole("link", { name: "Create treatment plan" }).click();
    const nameC = page.getByPlaceholder("e.g. Chin treatment plan");
    await expect(nameC).toBeVisible({ timeout: 20_000 });
    await nameC.fill("Chin treatment plan");
    await page.getByRole("button", { name: /^Create plan$/ }).click();
    await expect.poll(() => getTreatmentPlanCount(clientId), { timeout: 15_000 }).toBe(1);
    await noOverflow(page, "treatment tab @390 (after save)");
    // Refresh must NOT create another.
    await page.reload();
    expect(await getTreatmentPlanCount(clientId)).toBe(1);
    await noOverflow(page, "treatment tab @390 (after refresh)");
  } finally {
    await ctx.close();
  }
});
