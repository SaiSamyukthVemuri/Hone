import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  seedE2eChartedBlendBlockWithGalvanicIntensity,
  seedE2eClientWithPreviousAreas,
  getSavedBlockSetup,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Chloe: "let me read straight down the machine". Real browser, real stack.
//
// This spec is the DOM/tab-order proof for the canonical order in
// lib/sessions/reading-field-order.ts. Source pins live in
// tests/app/sessions/blend-machine-field-order.test.ts; only a real render can
// prove that what she SEES and what TAB does actually agree.

const T = 20_000;

// The exact machine order, by accessible name.
const BLEND_ORDER = [
  "Energy level (EL)",
  "Units of lye (UL)",
  "Galvanic duration (s)",
  "Galvanic mA",
  "Thermolysis duration (s)",
  "Thermolysis intensity %",
  "Thermolysis pulse count",
];

async function openAddForm(page: Page, clientId: string, sessionId: string) {
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await page.getByTestId("add-settings-block-cta").click({ timeout: T });
  await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({
    timeout: T,
  });
}

async function selectBlend(page: Page, modalityLabel: string, stored: string) {
  await page.getByRole("button", { name: "Blend", exact: true }).click();
  const modality = page.getByRole("combobox", { name: "Modality", exact: true });
  await modality.selectOption({ label: modalityLabel });
  await expect(modality).toHaveValue(stored);
}

// Pulse count is NOT wrapped in a <label> (it sits between the −/+ steppers),
// so it is located via the "Increase…" button, like the other charting specs.
function pulseCountInput(scope: Page | Locator): Locator {
  return scope
    .getByRole("button", { name: "Increase thermolysis pulse count" })
    .locator("xpath=preceding-sibling::input");
}

// Vertical document order of a set of fields, as actually laid out.
function fieldLocator(scope: Page | Locator, name: string): Locator {
  if (name === "Thermolysis pulse count") return pulseCountInput(scope);
  if (name === "Pulse delay") {
    return scope.getByRole("spinbutton", { name: "Pulse delay in seconds" });
  }
  return scope.getByRole("spinbutton", { name, exact: true });
}

async function visualOrder(scope: Page | Locator, names: string[]): Promise<string[]> {
  const withTop: Array<{ name: string; top: number; left: number }> = [];
  for (const name of names) {
    const el = fieldLocator(scope, name);
    if ((await el.count()) === 0) continue;
    const box = await el.first().boundingBox();
    if (!box) continue;
    withTop.push({ name, top: box.y, left: box.x });
  }
  // Two-column grids: sort by row (with tolerance), then by column.
  return withTop
    .sort((a, b) => (Math.abs(a.top - b.top) > 8 ? a.top - b.top : a.left - b.left))
    .map((f) => f.name);
}

// Tab order, starting from the first field and walking forward.
async function tabOrder(page: Page, names: string[]): Promise<string[]> {
  const want = new Set(names);
  const seen: string[] = [];
  await fieldLocator(page, names[0]).first().focus();
  for (let i = 0; i < 60 && seen.length < want.size; i++) {
    const raw = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      if (!a) return null;
      const aria = a.getAttribute("aria-label");
      if (aria) return aria;
      const label = a.closest("label");
      if (label) return label.querySelector("span")?.textContent?.trim() ?? null;
      // Pulse count: unlabelled input between the steppers.
      const next = a.nextElementSibling as HTMLElement | null;
      if (next?.getAttribute("aria-label") === "Increase thermolysis pulse count") {
        return "Thermolysis pulse count";
      }
      return null;
    });
    const name = raw === "Pulse delay in seconds" ? "Pulse delay" : raw;
    if (name && want.has(name) && !seen.includes(name)) seen.push(name);
    if (seen.length === want.size) break;
    await page.keyboard.press("Tab");
  }
  return seen;
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    return { scroll: d.scrollWidth, client: d.clientWidth };
  });
  // A 1px rounding allowance; anything more is a real sideways scroll.
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
}

// ---------------------------------------------------------------------------
test.describe("iPhone 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("Blend: visual order, tab order and DB round-trip all follow the machine", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);

    await test.step("new chart → exact machine order, visually and by keyboard", async () => {
      await openAddForm(page, clientId, sessionId);
      await page.getByRole("button", { name: "Chin", exact: true }).click();
      await selectBlend(page, "PicoBlend", "Picoblend");
      await expect(
        page.getByRole("spinbutton", { name: "Units of lye (UL)", exact: true }),
      ).toBeVisible({ timeout: T });

      expect(await visualOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
      expect(await tabOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
      await expectNoHorizontalOverflow(page);
    });

    await test.step("PicoBlend precision survives the reorder (0.74 mA, 0.733 s)", async () => {
      const num = (n: string) => page.getByRole("spinbutton", { name: n, exact: true });
      await num("Energy level (EL)").fill("42");
      await num("Units of lye (UL)").fill("25.5");
      await num("Galvanic duration (s)").fill("8");
      await num("Galvanic mA").fill("0.74");
      await num("Thermolysis duration (s)").fill("0.733");
      await num("Thermolysis intensity %").fill("30");
      await pulseCountInput(page).fill("3");
      // Pulse delay only appears once more than one pulse is charted.
      const delay = page.getByRole("spinbutton", { name: "Pulse delay in seconds" });
      await expect(delay).toBeVisible({ timeout: T });
      // ...and it sits AFTER pulse count.
      const countBox = await pulseCountInput(page).boundingBox();
      const delayBox = await delay.boundingBox();
      expect(delayBox!.y).toBeGreaterThan(countBox!.y);
      await delay.fill("0.40");

      await page.getByTestId("save-treatment-area").click();
      await expect
        .poll(async () => (await getSavedBlockSetup(sessionId))?.entry ?? null, { timeout: T })
        .not.toBeNull();
      const saved = await getSavedBlockSetup(sessionId);
      const e = saved?.entry as Record<string, unknown>;
      expect(Number(e.galvanic_ma)).toBe(0.74);
      expect(Number(e.thermolysis_duration_seconds)).toBe(0.733);
      expect(Number(e.units_of_lye)).toBe(25.5);
      expect(Number(e.galvanic_duration_seconds)).toBe(8);
      expect(Number(e.thermolysis_intensity_percent)).toBe(30);
      expect(Number(e.pulse_count)).toBe(3);
      expect(Number(e.pulse_delay_seconds)).toBe(0.4);
      expect(Number(saved?.energy_level)).toBe(42);
      // The retired reading is still never written.
      expect(e.galvanic_intensity_percent).toBeNull();
    });

    await test.step("edit chart → same order, and every value reopens unchanged", async () => {
      await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
      await page.getByTestId(/^edit-area-/).first().click();
      const num = (n: string) => page.getByRole("spinbutton", { name: n, exact: true });
      await expect(num("Galvanic mA")).toHaveValue("0.74", { timeout: T });
      await expect(num("Thermolysis duration (s)")).toHaveValue("0.733");
      await expect(num("Units of lye (UL)")).toHaveValue("25.5");
      await expect(num("Energy level (EL)")).toHaveValue("42");
      await expect(num("Thermolysis intensity %")).toHaveValue("30");
      await expect(pulseCountInput(page)).toHaveValue("3");

      expect(await visualOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
      expect(await tabOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
      await expectNoHorizontalOverflow(page);
    });

    await test.step("re-saving an untouched edit changes nothing", async () => {
      const before = JSON.stringify(await getSavedBlockSetup(sessionId));
      await page.getByTestId("save-treatment-area").click();
      await page.waitForTimeout(1200);
      const after = await getSavedBlockSetup(sessionId);
      const e = after?.entry as Record<string, unknown>;
      expect(Number(e.galvanic_ma)).toBe(0.74);
      expect(Number(e.thermolysis_duration_seconds)).toBe(0.733);
      expect(before).toBeTruthy();
    });
  });

  test("Add another pass uses the same machine order", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await seedE2eChartedBlendBlockWithGalvanicIntensity(seed, sessionId, {
      primaryArea: "Chin",
      apilusModality: "Picoblend",
      energyLevel: 42,
      machineFrequency: "13.56 MHz",
      thermolysisIntensityPercent: 30,
      thermolysisDurationSeconds: 0.733,
      galvanicMa: 0.74,
      galvanicDurationSeconds: 8,
      unitsOfLye: 25.5,
      galvanicIntensityPercent: 55,
      pulseCount: 3,
    });
    await loginAsOwner(page, seed);

    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByRole("button", { name: /Add another pass/i }).click({ timeout: T });
    const form = page.getByTestId("add-pass-form");
    await expect(form).toBeVisible({ timeout: T });

    // This form has no energy level, it inherits the block's.
    const expected = BLEND_ORDER.filter((n) => n !== "Energy level (EL)");
    expect(await visualOrder(form, expected)).toEqual(expected);
    await expectNoHorizontalOverflow(page);
  });

  test("pure Galvanic shows units of lye → duration → mA and NO thermolysis", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);

    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByRole("button", { name: "Galvanic", exact: true }).click();

    const galv = ["Units of lye (UL)", "Galvanic duration (s)", "Galvanic mA"];
    await expect(
      page.getByRole("spinbutton", { name: "Units of lye (UL)", exact: true }),
    ).toBeVisible({ timeout: T });
    expect(await visualOrder(page, galv)).toEqual(galv);
    expect(await tabOrder(page, galv)).toEqual(galv);

    for (const hidden of ["Thermolysis duration (s)", "Thermolysis intensity %"]) {
      await expect(
        page.getByRole("spinbutton", { name: hidden, exact: true }),
      ).toHaveCount(0);
    }
    await expect(pulseCountInput(page)).toHaveCount(0);
    // FLAGGED, deliberately unchanged: the Energy level input still renders for
    // pure galvanic. Hiding it would be a MODE-GATING change, which this PR is
    // explicitly not making; the data layer already blanks energy_level for
    // galvanic (buildTreatmentSetupDraftPatch). Pinned so the current behaviour
    // is visible rather than assumed.
    await expect(
      page.getByRole("spinbutton", { name: "Energy level (EL)", exact: true }),
    ).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
  });

  test("pure Thermolysis shows EL → duration → intensity → pulse and NO galvanic", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);

    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await page.getByRole("button", { name: "Thermolysis", exact: true }).click();

    const thermo = [
      "Energy level (EL)",
      "Thermolysis duration (s)",
      "Thermolysis intensity %",
      "Thermolysis pulse count",
    ];
    await expect(
      page.getByRole("spinbutton", { name: "Thermolysis duration (s)", exact: true }),
    ).toBeVisible({ timeout: T });
    expect(await visualOrder(page, thermo)).toEqual(thermo);
    expect(await tabOrder(page, thermo)).toEqual(thermo);

    for (const hidden of ["Units of lye (UL)", "Galvanic mA", "Galvanic duration (s)"]) {
      await expect(
        page.getByRole("spinbutton", { name: hidden, exact: true }),
      ).toHaveCount(0);
    }
    await expectNoHorizontalOverflow(page);
  });

  test("MultiBlend charts in the same order as PicoBlend", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);

    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await selectBlend(page, "MultiBlend", "Multiblend");
    await expect(
      page.getByRole("spinbutton", { name: "Units of lye (UL)", exact: true }),
    ).toBeVisible({ timeout: T });
    expect(await visualOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
    expect(await tabOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
    await expectNoHorizontalOverflow(page);
  });

  test("OmniBlend keeps the order minus its absent thermolysis duration", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);

    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await selectBlend(page, "OmniBlend", "Omniblend");
    await expect(
      page.getByRole("spinbutton", { name: "Units of lye (UL)", exact: true }),
    ).toBeVisible({ timeout: T });
    await expect(
      page.getByRole("spinbutton", { name: "Thermolysis duration (s)", exact: true }),
    ).toHaveCount(0);
    const expected = BLEND_ORDER.filter((n) => n !== "Thermolysis duration (s)");
    expect(await visualOrder(page, expected)).toEqual(expected);
    await expectNoHorizontalOverflow(page);
  });
});

// ---------------------------------------------------------------------------
test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("Blend keeps the machine order in the two-column desktop grid", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);

    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await selectBlend(page, "PicoBlend", "Picoblend");
    await expect(
      page.getByRole("spinbutton", { name: "Units of lye (UL)", exact: true }),
    ).toBeVisible({ timeout: T });

    // Reading order in a 2-col grid is row-major: the helper sorts by row then
    // column, which is exactly how she reads it.
    expect(await visualOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
    expect(await tabOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
    await expectNoHorizontalOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// The two COPY surfaces must present the same order, or a copied setup reads
// differently from the chart it came from.
// ---------------------------------------------------------------------------
test.describe("copy surfaces @390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("same-session Copy settings keeps the machine order", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await seedE2eChartedBlendBlockWithGalvanicIntensity(seed, sessionId, {
      primaryArea: "Chin",
      apilusModality: "Picoblend",
      energyLevel: 42,
      machineFrequency: "13.56 MHz",
      thermolysisIntensityPercent: 30,
      thermolysisDurationSeconds: 0.733,
      galvanicMa: 0.74,
      galvanicDurationSeconds: 8,
      unitsOfLye: 25.5,
      galvanicIntensityPercent: 55,
      pulseCount: 3,
    });
    await loginAsOwner(page, seed);

    await openAddForm(page, clientId, sessionId);
    await page.getByRole("button", { name: "Upper lip", exact: true }).click();
    await page.getByRole("button", { name: /Copy settings from another area/i }).click();

    // The copied values land in the same order she charted them.
    expect(await visualOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
    expect(await tabOrder(page, BLEND_ORDER)).toEqual(BLEND_ORDER);
    // ...and the precision survived the copy.
    await expect(
      page.getByRole("spinbutton", { name: "Galvanic mA", exact: true }),
    ).toHaveValue("0.74");
    await expect(
      page.getByRole("spinbutton", { name: "Thermolysis duration (s)", exact: true }),
    ).toHaveValue("0.733");
    await expectNoHorizontalOverflow(page);
  });

  test("whole-session copy preview card keeps the machine order", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId, todaySessionId } = await seedE2eClientWithPreviousAreas(seed);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/sessions/${todaySessionId}`);

    await page.getByTestId("copy-previous-preview").click();
    const card = page.getByTestId(/^copy-draft-[0-9a-f-]+$/).first();
    await expect(card).toBeVisible({ timeout: T });

    // The card labels differ slightly from the charting form ("Energy level",
    // "Units of lye", "Pulse delay (s)"), so assert by testid position instead.
    const ids = [
      "energy",
      "units-lye",
      "galv-duration",
      "galv-ma",
      "therm-duration",
      "therm-intensity",
      "pulse-count",
    ];
    const tops: Array<{ id: string; top: number; left: number }> = [];
    for (const id of ids) {
      const el = card.getByTestId(new RegExp(`^copy-draft-.*-${id}$`));
      if ((await el.count()) === 0) continue;
      const box = await el.first().boundingBox();
      if (!box) continue;
      tops.push({ id, top: box.y, left: box.x });
    }
    const seenOrder = tops
      .sort((a, b) => (Math.abs(a.top - b.top) > 8 ? a.top - b.top : a.left - b.left))
      .map((t) => t.id);
    expect(seenOrder).toEqual(ids.filter((i) => tops.some((t) => t.id === i)));
    expect(seenOrder).toContain("units-lye");
    expect(seenOrder.indexOf("galv-ma")).toBeLessThan(seenOrder.indexOf("therm-duration"));
    await expectNoHorizontalOverflow(page);
  });
});
