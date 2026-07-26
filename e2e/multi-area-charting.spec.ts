import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  getSessionBlockAreas,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Multi-area + per-area laterality charting (migration 0128) — real browser,
// real stack, iPad width. One settings block treats multiple areas, each with
// its own laterality; the DB rows + the reload are ground truth.

test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

const T = 20_000;

test("one settings block treats multiple areas with independent laterality", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);

  const openForm = async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    // Charting polish: the form no longer auto-opens — a zero-block session
    // shows the compact CTA, and opening is an explicit tap.
    await page.getByTestId("add-settings-block-cta").click({ timeout: T });
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
  };

  await test.step("add Cheeks + Sideburns to one settings block", async () => {
    await openForm();
    await page.getByRole("button", { name: "Cheeks", exact: true }).click();
    await page.getByRole("button", { name: "Sideburns", exact: true }).click();
    await expect(page.getByTestId("area-row-Cheeks")).toBeVisible();
    await expect(page.getByTestId("area-row-Sideburns")).toBeVisible();
  });

  await test.step("set Left cheeks + Right sideburns", async () => {
    await page.getByTestId("laterality-Cheeks-left").click();
    await page.getByTestId("laterality-Sideburns-right").click();
    await expect(page.getByTestId("laterality-Cheeks-left")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("laterality-Sideburns-right")).toHaveAttribute("aria-pressed", "true");
  });

  await test.step("save → DB holds both areas with the right laterality", async () => {
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|left,Sideburns|right");
  });

  await test.step("reload → the saved block shows both areas + laterality", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await expect(page.getByText("Left Cheeks", { exact: false })).toBeVisible({ timeout: T });
    await expect(page.getByText("Right Sideburns", { exact: false })).toBeVisible();
  });

  await test.step("edit → remove one area → save → only that area is gone", async () => {
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("area-row-Sideburns")).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: /Remove Sideburns/i }).click();
    await expect(page.getByTestId("area-row-Sideburns")).toHaveCount(0);
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|left");
  });
});
