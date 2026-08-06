import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClientWithPreviousAreas,
  getSessionBlockCount,
  getSessionBlockAreas,
  getFirstBlockMinutes,
  getFirstBlockRow,
  getFirstEntryRow,
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
    // Scoped to the copy PANEL. The page-wide lookup this replaces became
    // ambiguous once the charting screen gained its own "Last treatment"
    // memory card, which names the same area — and it was always the panel's
    // own row that this step is about.
    await expect(
      page
        .getByTestId("copy-previous-preview-panel")
        .getByText("left Chin", { exact: false }),
    ).toBeVisible();
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

test("editing cards writes nothing until commit; only the EDITED values persist; minutes blank @390px", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId, todaySessionId } = await seedE2eClientWithPreviousAreas(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${todaySessionId}`);

  await page.getByTestId("copy-previous-preview").click();
  const card = page.getByTestId(/^copy-draft-[0-9a-f-]+$/).first();
  await expect(card).toBeVisible({ timeout: T });

  await test.step("edit laterality → Right (source was left)", async () => {
    await card.getByRole("button", { name: "Right", exact: true }).click();
    expect(await getSessionBlockCount(todaySessionId)).toBe(0); // still no writes
  });

  await test.step("edit mode → Galvanic (source was blend; clears energy/thermolysis)", async () => {
    await card.getByRole("button", { name: "Galvanic", exact: true }).click();
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
  });

  await test.step("edit a galvanic reading", async () => {
    const ma = card.getByLabel("Galvanic mA");
    await ma.fill("0.3");
    expect(await getSessionBlockCount(todaySessionId)).toBe(0);
  });

  await test.step("clear the probe (source had one)", async () => {
    // The collapsed probe summary shows Change + Clear; clear it directly.
    await card.getByRole("button", { name: "Clear", exact: true }).click();
    expect(await getSessionBlockCount(todaySessionId)).toBe(0); // STILL zero writes
  });

  await test.step("commit → only the edited values persist; originals do not; minutes blank", async () => {
    await page.getByTestId("copy-previous-commit").click();
    await expect.poll(() => getSessionBlockCount(todaySessionId), { timeout: T }).toBe(1);
    // Edited area laterality persisted.
    await expect
      .poll(async () => (await getSessionBlockAreas(todaySessionId)).join(","), { timeout: T })
      .toBe("Chin|right");
    const block = await getFirstBlockRow(todaySessionId);
    const entry = await getFirstEntryRow(todaySessionId);
    expect(block?.mode).toBe("galv"); // edited mode
    expect(block?.probe_key).toBeNull(); // probe cleared (original probe did NOT persist)
    expect(block?.minutes_performed).toBeNull(); // minutes never copied
    expect(block?.energy_level).toBeNull(); // galvanic cleared the original energy (10)
    expect(entry?.mode).toBe("galv");
    expect(Number(entry?.galvanic_ma)).toBe(0.3); // edited reading
    expect(entry?.thermolysis_intensity_percent).toBeNull(); // original thermo (40) did NOT persist
  });
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
