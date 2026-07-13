import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  seedE2eProbeInventoryItem,
  seedE2eLegacyBlock,
  getSessionBlockAreas,
  getSessionBlockProbeLots,
  bumpSessionBlockUpdatedAt,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Full multi-area charting RELEASE flow (migration 0128 areas + 0129 atomic
// write) — real browser, real stack, iPad width. Proves the whole practitioner
// journey end to end: multiple areas + per-area laterality + an ACTIVE probe lot
// from inventory, saved atomically; every display surface shows BOTH areas + the
// probe; editing to one area removes the other everywhere with no stale rows; a
// concurrent stale edit is a visible conflict with NO data loss; and a legacy
// single-area block still renders. The DB rows + reloads are ground truth.

test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

const T = 20_000;

test("multi-area + probe lot: save, display everywhere, edit-down, conflict, legacy", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  // Active probe inventory: one clearly-active lot + one expired lot (still
  // selectable, flagged), so the selector must not silently pick and the active
  // one is findable.
  await seedE2eProbeInventoryItem(seed, {
    lotNumber: "460941",
    description: "Sterex Gold F3 probe",
    expiryDate: null,
  });
  await seedE2eProbeInventoryItem(seed, {
    lotNumber: "990099",
    description: "Old Ballet probe",
    expiryDate: "2020-01-01",
  });
  await loginAsOwner(page, seed);

  const openCharting = async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  };

  await test.step("form auto-opens; add Cheeks + Sideburns", async () => {
    await openCharting();
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
      timeout: T,
    });
    await page.getByRole("button", { name: "Cheeks", exact: true }).click();
    await page.getByRole("button", { name: "Sideburns", exact: true }).click();
    await expect(page.getByTestId("area-row-Cheeks")).toBeVisible();
    await expect(page.getByTestId("area-row-Sideburns")).toBeVisible();
  });

  await test.step("set Left cheeks + Right sideburns", async () => {
    await page.getByTestId("laterality-Cheeks-left").click();
    await page.getByTestId("laterality-Sideburns-right").click();
    await expect(page.getByTestId("laterality-Cheeks-left")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("laterality-Sideburns-right")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  await test.step("pick an ACTIVE probe lot from inventory (search + select)", async () => {
    const input = page.getByTestId("probe-lot-input");
    await input.click();
    await input.fill("460");
    await page.getByTestId("probe-lot-option-460941").click();
    await expect(input).toHaveValue("460941");
  });

  await test.step("save → atomic write: both areas + laterality + probe snapshot", async () => {
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|left,Sideburns|right");
    await expect
      .poll(async () => (await getSessionBlockProbeLots(sessionId)).join(","), {
        timeout: T,
      })
      .toBe("460941");
  });

  await test.step("reload charting → both areas + laterality + probe are shown", async () => {
    await openCharting();
    await expect(
      page.getByText("Left Cheeks", { exact: false }).first(),
    ).toBeVisible({ timeout: T });
    await expect(
      page.getByText("Right Sideburns", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByText("460941", { exact: false }).first()).toBeVisible();
  });

  await test.step("client profile shows BOTH areas (last treatment + memory)", async () => {
    await page.goto(`/clients/${clientId}`);
    await expect(
      page.getByText("Left Cheeks", { exact: false }).first(),
    ).toBeVisible({ timeout: T });
    await expect(
      page.getByText("Right Sideburns", { exact: false }).first(),
    ).toBeVisible();
  });

  await test.step("edit → remove Sideburns → save → Sideburns gone everywhere", async () => {
    await openCharting();
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("area-row-Sideburns")).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: /Remove Sideburns/i }).click();
    await expect(page.getByTestId("area-row-Sideburns")).toHaveCount(0);
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|left");
    // No stale child row survived the down-edit.
    await openCharting();
    await expect(page.getByText("Right Sideburns", { exact: false })).toHaveCount(0);
    await expect(
      page.getByText("Left Cheeks", { exact: false }).first(),
    ).toBeVisible();
  });

  await test.step("stale concurrent edit → visible conflict, NO data loss", async () => {
    await openCharting();
    await page.getByTestId(/^edit-area-/).first().click();
    await expect(page.getByTestId("area-row-Cheeks")).toBeVisible({ timeout: T });
    // A different device saved this block after the form loaded.
    await bumpSessionBlockUpdatedAt(sessionId);
    // Change something and save the now-stale form.
    await page.getByTestId("laterality-Cheeks-right").click();
    await page.getByTestId("save-treatment-area").click();
    await expect(page.getByText(/changed elsewhere/i)).toBeVisible({ timeout: T });
    // The prior committed set is intact — nothing was half-written.
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|left");
  });

  await test.step("a legacy single-area block still renders its one area", async () => {
    await seedE2eLegacyBlock(seed, sessionId, {
      primaryArea: "Neck",
      side: null,
      sortOrder: 5,
    });
    await openCharting();
    await expect(page.getByText("Neck", { exact: false }).first()).toBeVisible({
      timeout: T,
    });
    // The legacy block has no child rows, so it never appears in the structured set.
    expect(await getSessionBlockAreas(sessionId)).toEqual(["Cheeks|left"]);
  });
});
