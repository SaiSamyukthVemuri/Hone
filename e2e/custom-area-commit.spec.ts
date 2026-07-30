import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  getSessionBlockAreas,
  getSessionBlockPrimaryAreas,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Custom-area keystroke duplication hotfix (Chloe production feedback) — real
// browser, real local stack, DB rows as ground truth.
//
// REPRODUCED DEFECT (production head c64366c9): the multi-area settings-block
// editor treated every AreaPicker onChange as a COMMITTED area, and the picker's
// free-text "Other" input fired onChange on every keystroke. Typing an 8-letter
// custom area appended EIGHT selected rows (one per prefix), the write action
// persisted all eight as session_block_areas rows, and session_blocks.
// primary_area was projected from the FIRST fragment — a single letter.
//
// These specs type CHARACTER BY CHARACTER with pressSequentially. fill() emits a
// single input event and would pass even against the broken build, so it must
// NOT be used here.
//
// The custom label used below ("Glabella") is a neutral anatomical term that is
// already the app's own placeholder example. No client name, no client data, and
// nothing from the reporter's screenshots appears in this fixture.

const T = 20_000;
const CUSTOM_AREA = "Glabella";

const customInput = (page: Page) => page.locator('[data-testid$="-add-area-custom"]');
const addButton = (page: Page) => page.locator('[data-testid$="-add-area-custom-add"]');
const areaRows = (page: Page) => page.locator('[data-testid^="area-row-"]');

async function openBlockForm(page: Page, clientId: string, sessionId: string) {
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  // Charting polish (PR #476): the form no longer auto-opens.
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
}

async function openOtherInput(page: Page) {
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(customInput(page)).toBeVisible({ timeout: T });
}

async function noOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(w.s, `${label}: no horizontal overflow (${w.s} vs ${w.c})`).toBeLessThanOrEqual(w.c);
}

// ---------------------------------------------------------------------------
// Desktop/iPad profile — the full commit contract.
// ---------------------------------------------------------------------------
test.describe("custom area commits once, not once per keystroke", () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

  test("typing adds nothing; Enter adds exactly one row that saves cleanly", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);
    await openBlockForm(page, clientId, sessionId);
    await openOtherInput(page);

    await test.step("every prefix keystroke leaves ZERO selected rows", async () => {
      const input = customInput(page);
      await input.click();
      for (let i = 1; i <= CUSTOM_AREA.length; i += 1) {
        await input.pressSequentially(CUSTOM_AREA[i - 1], { delay: 20 });
        const typedSoFar = CUSTOM_AREA.slice(0, i);
        await expect(input).toHaveValue(typedSoFar);
        // THE regression assertion. On the broken build this is `i` rows.
        await expect(areaRows(page), `after typing "${typedSoFar}"`).toHaveCount(0);
      }
      await expect(page.getByText(/No areas selected yet/i)).toBeVisible();
    });

    await test.step("Enter commits exactly one row and clears the draft", async () => {
      await customInput(page).press("Enter");
      await expect(areaRows(page)).toHaveCount(1);
      await expect(page.getByTestId(`area-row-${CUSTOM_AREA}`)).toBeVisible();
      await expect(customInput(page)).toHaveValue("");
    });

    await test.step("repeated Enter on an empty draft never duplicates", async () => {
      for (let i = 0; i < 3; i += 1) await customInput(page).press("Enter");
      await expect(areaRows(page)).toHaveCount(1);
    });

    await test.step("the form did not submit when Enter was pressed", async () => {
      // Enter inside the custom-area input must commit the area, never submit
      // the settings block: the editor is still open and nothing is saved yet.
      await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible();
      expect(await getSessionBlockAreas(sessionId)).toEqual([]);
    });

    await test.step("per-area laterality still works on the committed row", async () => {
      await page.getByTestId(`laterality-${CUSTOM_AREA}-left`).click();
      await expect(page.getByTestId(`laterality-${CUSTOM_AREA}-left`)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    await test.step("save → exactly ONE area row and a clean legacy projection", async () => {
      await page.getByTestId("save-treatment-area").click();
      await expect
        .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
        .toBe(`${CUSTOM_AREA}|left`);
      // The legacy projection is the committed area, NOT a one-letter fragment.
      expect(await getSessionBlockPrimaryAreas(sessionId)).toEqual([CUSTOM_AREA]);
    });

    await test.step("reload → the saved block shows the whole custom area", async () => {
      await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
      await expect(page.getByText(`Left ${CUSTOM_AREA}`, { exact: false })).toBeVisible({
        timeout: T,
      });
    });
  });

  test("blank cannot commit, duplicates dedupe, chips and remove still work", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);
    await openBlockForm(page, clientId, sessionId);

    await test.step("canonical chips still add immediately on one tap", async () => {
      await page.getByRole("button", { name: "Cheeks", exact: true }).click();
      await expect(page.getByTestId("area-row-Cheeks")).toBeVisible();
      await page.getByRole("button", { name: "Sideburns", exact: true }).click();
      await expect(areaRows(page)).toHaveCount(2);
    });

    await openOtherInput(page);

    await test.step("blank / whitespace-only can never commit", async () => {
      await expect(addButton(page)).toBeDisabled();
      await customInput(page).press("Enter");
      await expect(areaRows(page)).toHaveCount(2);

      await customInput(page).pressSequentially("   ", { delay: 20 });
      await expect(addButton(page)).toBeDisabled();
      await customInput(page).press("Enter");
      await expect(areaRows(page)).toHaveCount(2);
      await customInput(page).fill("");
    });

    await test.step("the Add area button commits exactly one row", async () => {
      await customInput(page).pressSequentially(CUSTOM_AREA, { delay: 20 });
      await expect(areaRows(page)).toHaveCount(2);
      await addButton(page).click();
      await expect(areaRows(page)).toHaveCount(3);
      await expect(page.getByTestId(`area-row-${CUSTOM_AREA}`)).toBeVisible();
    });

    await test.step("surrounding whitespace is trimmed, repeated spaces collapsed", async () => {
      await customInput(page).pressSequentially("  outer   ankle  ", { delay: 10 });
      await addButton(page).click();
      await expect(page.getByTestId("area-row-outer ankle")).toBeVisible();
      await expect(areaRows(page)).toHaveCount(4);
    });

    await test.step("case-insensitive duplicate protection: a re-add adds nothing", async () => {
      await customInput(page).pressSequentially(CUSTOM_AREA.toLowerCase(), { delay: 10 });
      await addButton(page).click();
      await expect(areaRows(page)).toHaveCount(4);
      await expect(page.getByText(/is already in this settings block/i)).toBeVisible();
      // A canonical chip already added also dedupes through the text path.
      await customInput(page).pressSequentially("cheeks", { delay: 10 });
      await addButton(page).click();
      await expect(areaRows(page)).toHaveCount(4);
    });

    await test.step("remove still works", async () => {
      await page.getByRole("button", { name: `Remove ${CUSTOM_AREA}` }).click();
      await expect(page.getByTestId(`area-row-${CUSTOM_AREA}`)).toHaveCount(0);
      await expect(areaRows(page)).toHaveCount(3);
    });

    await test.step("multiple areas save and reload together", async () => {
      await page.getByTestId("apply-all-bilateral").click();
      await page.getByTestId("save-treatment-area").click();
      await expect
        .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
        .toBe("Cheeks|bilateral,Sideburns|bilateral,outer ankle|bilateral");

      await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
      await expect(page.getByText("Bilateral Cheeks", { exact: false })).toBeVisible({ timeout: T });
      await expect(page.getByText("Bilateral outer ankle", { exact: false })).toBeVisible();
    });
  });
});

// ---------------------------------------------------------------------------
// iPhone profile (390px, hasTouch) — Chloe's actual device dimensions.
// ENGINE NOTE: the repo E2E engine is Chromium; this is an iPhone-dimension
// Chromium run, not real iOS Safari/WebKit (see playwright.mobile.config.ts).
// ---------------------------------------------------------------------------
test.describe("iPhone profile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("typing a custom area on a phone adds nothing until Add area is tapped", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);
    await openBlockForm(page, clientId, sessionId);
    await noOverflow(page, "block form @390 (opened)");
    await openOtherInput(page);
    await noOverflow(page, "block form @390 (custom area input open)");

    const input = customInput(page);
    await input.click();
    for (let i = 1; i <= CUSTOM_AREA.length; i += 1) {
      await input.pressSequentially(CUSTOM_AREA[i - 1], { delay: 20 });
      await expect(areaRows(page), `@390 after "${CUSTOM_AREA.slice(0, i)}"`).toHaveCount(0);
    }

    // The commit affordance is reachable and tappable at 390px.
    const add = addButton(page);
    await expect(add).toBeVisible();
    const box = await add.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(36);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await noOverflow(page, "block form @390 (draft typed)");

    await add.tap();
    await expect(areaRows(page)).toHaveCount(1);
    await expect(page.getByTestId(`area-row-${CUSTOM_AREA}`)).toBeVisible();
    await expect(input).toHaveValue("");
    await noOverflow(page, "block form @390 (committed)");

    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe(`${CUSTOM_AREA}|not_applicable`);
    expect(await getSessionBlockPrimaryAreas(sessionId)).toEqual([CUSTOM_AREA]);
  });
});
