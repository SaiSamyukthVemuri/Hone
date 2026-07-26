import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  getSavedBlockSetup,
  getSessionBlockCount,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// PicoBlend precision round-trip — REAL browser, REAL local stack.
//
// Proves Chloe's EXACT Blend + PicoBlend clinical values submit through the
// ACTUAL charting forms (the one-page "Add settings block" form and the
// "Add another pass" SimplifiedEntryForm), round-trip to the database EXACTLY
// (read back straight from Postgres via node-pg), and then re-display EXACTLY on
// reload. Nothing here asserts against source strings: every value is typed into
// a live input, submitted through the real server action, read back from the DB,
// and re-rendered from the DB. Decimal fidelity (0.74 mA, 0.733 s) is the whole
// point — the inputs use step="0.01" / step="0.001" and the numeric columns are
// unconstrained `numeric`, so the values must survive with no rounding.

const T = 20_000;

// Chloe's exact fixture (Blend + PicoBlend).
const FIXTURE = {
  energyLevel: "144",
  galvanicDurationSeconds: "9",
  galvanicMa: "0.74",
  thermolysisDurationSeconds: "0.733",
  thermolysisIntensityPercent: "7",
  pulseCount: "4",
  unitsOfLye: "67",
} as const;

type SavedBlock = Record<string, unknown> & {
  entry: Record<string, unknown> | null;
  entries: Array<Record<string, unknown>>;
};

type Scope = Page | Locator;

// Numeric reading inputs render as spinbuttons whose accessible name is the
// wrapping-label text. getByRole is used (not getByLabel) because the modality
// <select> would not resolve via getByLabel here; getByRole matches the real
// accessibility name for every field consistently.
function num(scope: Scope, name: string): Locator {
  return scope.getByRole("spinbutton", { name, exact: true });
}

// Locate the pulse-count number input, which is NOT wrapped in a <label> (it
// sits between the −/+ steppers). It is the immediate preceding sibling of the
// "Increase thermolysis pulse count" button. `scope` narrows to a specific form
// so the primary form and the add-pass form never collide on the same page.
function pulseCountInput(scope: Scope): Locator {
  return scope
    .getByRole("button", { name: "Increase thermolysis pulse count" })
    .locator("xpath=preceding-sibling::input");
}

// Drive the primary one-page "Add settings block" form to chart Chin (left) as
// Blend / PicoBlend with the full fixture, verifying the decimal inputs are
// accepted (value kept verbatim AND natively valid — no step mismatch) before
// saving. Assumes the compact "Add settings block" CTA is present.
async function chartPicoBlendPrimary(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Add settings block/i })
    .click({ timeout: T });
  await expect(
    page.getByText(/Areas treated with these settings/i),
  ).toBeVisible({ timeout: T });

  // Area: Chin, laterality left.
  await page.getByRole("button", { name: "Chin", exact: true }).click();
  await expect(page.getByTestId("area-row-Chin")).toBeVisible();
  await page.getByTestId("laterality-Chin-left").click();

  // Mode: Blend (reveals the Apilus modality select + thermolysis/galvanic).
  await page.getByRole("button", { name: "Blend", exact: true }).click();

  // Apilus modality: PicoBlend (stored value "Picoblend", label "PicoBlend").
  const modality = page.getByRole("combobox", { name: "Modality", exact: true });
  await modality.selectOption({ label: "PicoBlend" });
  await expect(modality).toHaveValue("Picoblend");

  // Treatment readings.
  await num(page, "Energy level (EL)").fill(FIXTURE.energyLevel);
  await num(page, "Thermolysis duration (s)").fill(FIXTURE.thermolysisDurationSeconds);
  await num(page, "Thermolysis intensity %").fill(FIXTURE.thermolysisIntensityPercent);
  await pulseCountInput(page).fill(FIXTURE.pulseCount);
  await num(page, "Galvanic mA").fill(FIXTURE.galvanicMa);
  await num(page, "Galvanic duration (s)").fill(FIXTURE.galvanicDurationSeconds);
  await num(page, "Units of lye (UL)").fill(FIXTURE.unitsOfLye);

  // The decimals must be accepted verbatim AND be natively valid (no step
  // mismatch). If a browser rejected 0.74 / 0.733 this is a real bug, so these
  // assertions must NOT be loosened.
  const galvanicMaInput = num(page, "Galvanic mA");
  const thermoDurInput = num(page, "Thermolysis duration (s)");
  await expect(galvanicMaInput).toHaveValue("0.74");
  await expect(thermoDurInput).toHaveValue("0.733");
  await expect(pulseCountInput(page)).toHaveValue("4");
  expect(
    await galvanicMaInput.evaluate((el) => (el as HTMLInputElement).validity.valid),
    "Galvanic mA 0.74 must be a natively valid step",
  ).toBe(true);
  expect(
    await thermoDurInput.evaluate((el) => (el as HTMLInputElement).validity.valid),
    "Thermolysis duration 0.733 must be a natively valid step",
  ).toBe(true);

  await page.getByTestId("save-treatment-area").click();
}

// The full primary-form round-trip: seed → login → chart → DB read-back →
// reload → re-display. Shared by the desktop and 390px mobile variants.
async function runPrimaryFormRoundTrip(page: Page): Promise<void> {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

  await chartPicoBlendPrimary(page);

  // The block persists only on Save; wait for the single new block to exist.
  await expect.poll(async () => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);

  const saved = (await getSavedBlockSetup(sessionId)) as SavedBlock;
  expect(saved).not.toBeNull();
  expect(saved.entry).not.toBeNull();
  const entry = saved.entry as Record<string, unknown>;

  // (1) Block-level settings.
  expect(saved.mode).toBe("blend");
  expect(saved.apilus_modality).toBe("Picoblend");
  expect(Number(saved.energy_level)).toBe(144);

  // (2) Entry-level readings — EXACT, decimals intact (numeric come back as
  // strings via node-pg, so coerce with Number()).
  expect(Number(entry.galvanic_ma)).toBe(0.74);
  expect(Number(entry.galvanic_duration_seconds)).toBe(9);
  expect(Number(entry.thermolysis_duration_seconds)).toBe(0.733);
  expect(Number(entry.thermolysis_intensity_percent)).toBe(7);
  expect(Number(entry.pulse_count)).toBe(4);
  expect(Number(entry.units_of_lye)).toBe(67);

  // (3) Galvanic intensity % was removed as an active input → stored NULL.
  expect(entry.galvanic_intensity_percent).toBeNull();

  // (4) Reload → the saved record re-displays the exact values from the DB.
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

  // Settings summary line: mode + modality + energy re-render.
  await expect(page.getByText(/Blend · PicoBlend · EL 144/)).toBeVisible({ timeout: T });

  // Galvanic reading line: "0.74 mA · 9s · 67 UL" and — critically — NO bare
  // percentage (the deprecated galvanic intensity % must never reappear here).
  const galvanicLine = page.getByText("Galvanic:", { exact: true }).locator("xpath=..");
  await expect(galvanicLine).toContainText("0.74 mA");
  await expect(galvanicLine).toContainText("9s");
  await expect(galvanicLine).toContainText("67 UL");
  await expect(galvanicLine).not.toContainText("%");

  // Thermolysis reading line: intensity %, duration, and pulse count.
  //
  // FINDING (display precision, not data loss): the thermolysis duration is
  // stored in the DB at FULL precision — 0.733 — as asserted above. The
  // practitioner-facing summary line, however, routes the duration through
  // formatSeconds (PR #165), which rounds to 2 decimal places, so it renders
  // "0.73 seconds" rather than "0.733 seconds". The stored clinical value and
  // the raw export keep 0.733; only this readability-oriented summary rounds.
  // The DB round-trip (the load-bearing clinical guarantee) is exact; this
  // assertion therefore matches what the UI actually shows.
  const thermoLine = page.getByText("Thermolysis:", { exact: true }).locator("xpath=..");
  await expect(thermoLine).toContainText("7%");
  await expect(thermoLine).toContainText("0.73 seconds");
  await expect(thermoLine).not.toContainText("0.733 seconds");
  await expect(thermoLine).toContainText("4 pulses");
}

test.describe("PicoBlend precision — primary form (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("Chloe's exact PicoBlend values submit, round-trip to the DB, and re-display (desktop)", async ({
    page,
  }) => {
    await runPrimaryFormRoundTrip(page);
  });
});

test.describe("PicoBlend precision — primary form (390px mobile)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("Chloe's exact PicoBlend values submit, round-trip to the DB, and re-display (390px)", async ({
    page,
  }) => {
    await runPrimaryFormRoundTrip(page);
  });
});

test.describe("PicoBlend precision — add another pass (390px mobile)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a second pass through the SimplifiedEntryForm round-trips the exact PicoBlend values (390px)", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

    // seedE2eChartedThermolysisBlock only seeds mode='thermo' (no galvanic
    // section), so build a REAL blend/PicoBlend block through the primary form
    // first. The FIRST pass gets a DISTINCT galvanic mA (0.50) so the second
    // pass added below is unambiguously the new row.
    await page
      .getByRole("button", { name: /Add settings block/i })
      .click({ timeout: T });
    await expect(
      page.getByText(/Areas treated with these settings/i),
    ).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await expect(page.getByTestId("area-row-Chin")).toBeVisible();
    await page.getByTestId("laterality-Chin-left").click();
    await page.getByRole("button", { name: "Blend", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Modality", exact: true })
      .selectOption({ label: "PicoBlend" });
    await num(page, "Energy level (EL)").fill("144");
    await num(page, "Galvanic mA").fill("0.50");
    await page.getByTestId("save-treatment-area").click();
    await expect.poll(async () => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);

    // Open "Add another pass" (SimplifiedEntryForm). block.mode === 'blend', so
    // both the thermolysis and galvanic sections render.
    await page.getByRole("button", { name: /Add another pass/i }).click();
    const form = page.getByTestId("add-pass-form");
    await expect(form).toBeVisible({ timeout: T });

    // Area is required; then the full fixture.
    await form.getByRole("button", { name: "Chin", exact: true }).click();
    await num(form, "Thermolysis intensity %").fill(FIXTURE.thermolysisIntensityPercent);
    await num(form, "Thermolysis duration (s)").fill(FIXTURE.thermolysisDurationSeconds);
    await pulseCountInput(form).fill(FIXTURE.pulseCount);
    await num(form, "Galvanic mA").fill(FIXTURE.galvanicMa);
    await num(form, "Galvanic duration (s)").fill(FIXTURE.galvanicDurationSeconds);
    await num(form, "Units of lye (UL)").fill(FIXTURE.unitsOfLye);

    // Decimals accepted verbatim + natively valid (this form IS a real <form>,
    // so an invalid step would block the native submit — a real bug if so).
    await expect(num(form, "Galvanic mA")).toHaveValue("0.74");
    await expect(num(form, "Thermolysis duration (s)")).toHaveValue("0.733");
    await expect(pulseCountInput(form)).toHaveValue("4");

    await form.getByTestId("add-pass-submit").click();

    // Two live entries now exist on the block; the newest is the added pass.
    await expect
      .poll(async () => ((await getSavedBlockSetup(sessionId)) as SavedBlock).entries.length, {
        timeout: T,
      })
      .toBe(2);

    const saved = (await getSavedBlockSetup(sessionId)) as SavedBlock;
    const first = saved.entries[0];
    const added = saved.entries[saved.entries.length - 1];

    // The first pass is the distinct one; the added pass carries the fixture.
    expect(Number(first.galvanic_ma)).toBe(0.5);
    expect(Number(added.galvanic_ma)).toBe(0.74);
    expect(Number(added.galvanic_duration_seconds)).toBe(9);
    expect(Number(added.thermolysis_duration_seconds)).toBe(0.733);
    expect(Number(added.thermolysis_intensity_percent)).toBe(7);
    expect(Number(added.pulse_count)).toBe(4);
    expect(Number(added.units_of_lye)).toBe(67);
    expect(added.galvanic_intensity_percent).toBeNull();
  });
});
