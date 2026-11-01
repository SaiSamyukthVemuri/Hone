import { test } from "@playwright/test";
import { seedE2eStudio, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { R2_SEQUENCE, clickRail, observe, capture, saveObservations, type Observation } from "./helpers/settings-r2";

// Settings R2 (HON-68): the exact click sequence Profile > Personal details >
// Calendar > Display preferences > Studio details > Email > Text > Self-service >
// Postcare > Intake > Cancellation > Booking > Payments > Integrations, driven
// through the rail/menu at desktop 1280 and mobile 390. Records what a person sees
// after each step (screenshots + observations) and asserts nothing about the
// refinement; the behavioural assertions are in settings-r2-behaviours.spec.ts.
// Output only when SETTINGS_SHOTS_DIR is set; phase is SETTINGS_PHASE (before|after).

let seed: E2eSeed;
test.beforeAll(async () => {
  seed = await seedE2eStudio();
});

for (const width of [1280, 390]) {
  test(`click sequence at ${width}px`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await loginAsOwner(page, seed);
    await page.goto("/settings/profile");
    await page.getByRole("heading", { name: /^Profile$/ }).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    const rows: Observation[] = [];
    for (const step of R2_SEQUENCE) {
      await clickRail(page, step.entry, step.section);
      rows.push(await observe(page, step.id));
      await capture(page, step.id);
    }
    saveObservations(width, rows);
  });
}
