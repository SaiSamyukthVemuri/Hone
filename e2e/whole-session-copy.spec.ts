import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClientWithPreviousAreas,
  getSessionBlockCount,
  getSessionBlockAreas,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Whole-session "Copy areas and settings" draft model (0157) — real browser,
// real stack, 390px iPhone. Proves the NON-NEGOTIABLE safety boundary: the
// preview creates ZERO blocks; only the explicit commit writes; and the
// committed copy reproduces the reviewed area(s).

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

async function noOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(sw, `no horizontal overflow (${sw} vs ${cw})`).toBeLessThanOrEqual(cw);
}

test("preview creates zero blocks; only the explicit commit writes @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, todaySessionId } = await seedE2eClientWithPreviousAreas(seed);
  await loginAsOwner(page, seed);
  const url = `/clients/${clientId}/sessions/${todaySessionId}`;

  await test.step("the copy panel offers a preview on the empty chart", async () => {
    await page.goto(url);
    await expect(page.getByTestId("copy-previous-preview")).toBeVisible({ timeout: T });
    // Zero blocks so far.
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
    await noOverflow(page);
  });

  await test.step("building the preview creates NO block (ephemeral, in-memory)", async () => {
    await page.getByTestId("copy-previous-preview").click();
    await expect(page.getByTestId("copy-previous-preview-panel")).toBeVisible({ timeout: T });
    // A draft card for the previous area is shown...
    await expect(page.getByText("left Chin", { exact: false })).toBeVisible();
    // ...but NOTHING was written.
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
    await noOverflow(page);
  });

  await test.step("cancel writes nothing; re-open still writes nothing", async () => {
    await page.getByTestId("copy-previous-cancel").click();
    await expect(page.getByTestId("copy-previous-preview")).toBeVisible({ timeout: T });
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
    // Re-open the preview.
    await page.getByTestId("copy-previous-preview").click();
    await expect(page.getByTestId("copy-previous-preview-panel")).toBeVisible({ timeout: T });
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
  });

  await test.step("the explicit commit creates exactly the reviewed block + area", async () => {
    await page.getByTestId("copy-previous-commit").click();
    await expect
      .poll(() => getSessionBlockCount(todaySessionId), { timeout: T })
      .toBe(1);
    await expect
      .poll(async () => (await getSessionBlockAreas(todaySessionId)).join(","), { timeout: T })
      .toBe("Chin|left");
  });
});

test("removing a draft card before commit copies only what remains @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, todaySessionId } = await seedE2eClientWithPreviousAreas(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${todaySessionId}`);

  await page.getByTestId("copy-previous-preview").click();
  await expect(page.getByTestId("copy-previous-preview-panel")).toBeVisible({ timeout: T });
  // Remove the only card, then commit → the commit button is disabled with no
  // cards, so nothing is written and the chart stays empty.
  await page.getByTestId(/^copy-draft-remove-/).first().click();
  await expect(page.getByTestId(/^copy-draft-/).first()).toHaveCount(0);
  await expect(page.getByTestId("copy-previous-commit")).toBeDisabled();
  expect(await getSessionBlockCount(todaySessionId)).toBe(0);
});
