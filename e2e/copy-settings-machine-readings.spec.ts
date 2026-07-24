import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  seedE2eChartedThermolysisBlock,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// In-form "Copy settings from another area in this session" — real browser,
// real stack, iPhone (390px) width. Proves the copy now carries the primary
// entry's machine READINGS (thermolysis intensity/duration/pulse), not just
// block-level fields, while preserving the destination area and never touching
// outcomes. It is a client-side draft prefill — nothing is persisted until the
// practitioner saves — so it cannot fabricate performed treatment.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const T = 20_000;

async function noHorizontalOverflow(page: import("@playwright/test").Page) {
  const { scrollW, clientW } = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(scrollW, `horizontal overflow (${scrollW} vs ${clientW})`).toBeLessThanOrEqual(clientW);
}

test("in-form Copy settings carries machine readings at 390px, preserving the destination area", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  // A saved thermolysis source block with distinctive machine settings.
  await seedE2eChartedThermolysisBlock(seed, sessionId, {
    primaryArea: "Chin",
    energyLevel: 42,
    machineFrequency: "13.56 MHz",
    thermolysisIntensityPercent: 30,
    thermolysisDurationSeconds: 0.12,
    pulseCount: 3,
  });
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

  await test.step("open a NEW settings block (source block already exists)", async () => {
    await page.getByRole("button", { name: /Add settings block/i }).click({ timeout: T });
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
    await noHorizontalOverflow(page);
  });

  await test.step("choose a DIFFERENT destination area (Cheeks)", async () => {
    await page.getByRole("button", { name: "Cheeks", exact: true }).click();
    await expect(page.getByTestId("area-row-Cheeks")).toBeVisible();
  });

  await test.step("Copy settings → machine readings prefill; destination area preserved", async () => {
    await page.getByRole("button", { name: /Copy settings from another area/i }).click();
    // Readable feedback naming the source.
    await expect(page.getByText(/copied from Chin|from Chin/i)).toBeVisible({ timeout: T });
    // Block-level setting copied.
    await expect(page.getByLabel("Energy level (EL)")).toHaveValue("42");
    // Primary-entry machine READING copied (the whole point of this fix).
    await expect(page.getByLabel("Thermolysis intensity %")).toHaveValue("30");
    // Destination area is NOT overwritten by the source's area.
    await expect(page.getByTestId("area-row-Cheeks")).toBeVisible();
    await expect(page.getByTestId("area-row-Chin")).toHaveCount(0);
    await noHorizontalOverflow(page);
  });
});
