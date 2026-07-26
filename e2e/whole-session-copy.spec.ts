import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClientWithPreviousAreas,
  getSessionBlockCount,
  getSessionBlockAreas,
  getFirstBlockMinutes,
  bumpSourceBlockEnergy,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Whole-session "Copy areas and settings" draft model (0157) — real browser,
// real stack, 390px iPhone. Proves the amended safety boundary: the preview
// creates ZERO blocks; only the explicit commit writes; the committed copy
// reproduces the reviewed area(s) with machine settings but BLANK minutes; a
// stale preview fails closed with a safe message and zero writes.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

async function noOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(sw, `no horizontal overflow (${sw} vs ${cw})`).toBeLessThanOrEqual(cw);
}

test("preview creates zero blocks; commit copies areas+settings with BLANK minutes @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, todaySessionId } = await seedE2eClientWithPreviousAreas(seed);
  await loginAsOwner(page, seed);
  const url = `/clients/${clientId}/sessions/${todaySessionId}`;

  await test.step("the copy panel offers a preview on the empty chart", async () => {
    await page.goto(url);
    await expect(page.getByTestId("copy-previous-preview")).toBeVisible({ timeout: T });
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
    await noOverflow(page);
  });

  await test.step("building the preview creates NO block (ephemeral, in-memory)", async () => {
    await page.getByTestId("copy-previous-preview").click();
    await expect(page.getByTestId("copy-previous-preview-panel")).toBeVisible({ timeout: T });
    await expect(page.getByText("left Chin", { exact: false })).toBeVisible();
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
    await noOverflow(page);
  });

  await test.step("cancel writes nothing; re-open still writes nothing", async () => {
    await page.getByTestId("copy-previous-cancel").click();
    await expect(page.getByTestId("copy-previous-preview")).toBeVisible({ timeout: T });
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
    await page.getByTestId("copy-previous-preview").click();
    await expect(page.getByTestId("copy-previous-preview-panel")).toBeVisible({ timeout: T });
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
  });

  await test.step("the explicit commit creates the reviewed block + area, with BLANK minutes", async () => {
    await page.getByTestId("copy-previous-commit").click();
    await expect.poll(() => getSessionBlockCount(todaySessionId), { timeout: T }).toBe(1);
    await expect
      .poll(async () => (await getSessionBlockAreas(todaySessionId)).join(","), { timeout: T })
      .toBe("Chin|left");
    // P1-5: minutes are NOT copied — today's block minutes start blank.
    expect(await getFirstBlockMinutes(todaySessionId)).toBeNull();
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
  await page.getByTestId(/^copy-draft-remove-/).first().click();
  await expect(page.getByTestId(/^copy-draft-/)).toHaveCount(0);
  await expect(page.getByTestId("copy-previous-commit")).toBeDisabled();
  expect(await getSessionBlockCount(todaySessionId)).toBe(0);
});

test("a STALE preview fails closed with a safe message and zero writes @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, todaySessionId, previousSessionId } =
    await seedE2eClientWithPreviousAreas(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${todaySessionId}`);

  await page.getByTestId("copy-previous-preview").click();
  await expect(page.getByTestId("copy-previous-preview-panel")).toBeVisible({ timeout: T });

  // The source visit changes AFTER the preview was built.
  await bumpSourceBlockEnergy(previousSessionId);

  await page.getByTestId("copy-previous-commit").click();
  // Scope to the panel's alert (Next's global route-announcer also has role=alert).
  const alert = page.getByTestId("copy-previous-preview-panel").getByRole("alert");
  await expect(alert).toBeVisible({ timeout: T });
  // Safe, human message — never raw DB text (SQLSTATE / constraint / relation).
  await expect(alert).toContainText(/previous visit changed|reload the preview/i);
  const alertText = (await alert.textContent()) ?? "";
  expect(alertText).not.toMatch(/HN0\d\d|SQLSTATE|constraint|relation|session_copy_operations|null value/i);
  // Nothing was written.
  expect(await getSessionBlockCount(todaySessionId)).toBe(0);
});
