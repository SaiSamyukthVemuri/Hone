import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  seedE2eChartedThermolysisBlock,
  getSavedBlockSetup,
  getSessionBlockCount,
  getSessionBlockAreas,
  getFirstBlockMinutes,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// In-form "Copy settings from another area in this session" — real browser,
// real stack, iPhone (390px) width. Proves the copy carries the primary entry's
// machine READINGS (thermolysis intensity/duration/pulse), preserves the
// destination area, and — after Save + reload — the copied setup PERSISTS
// exactly while every outcome stays blank. It is a client-side prefill: nothing
// persists until Save, so it cannot fabricate performed treatment.
//
// Session 1C adds the MINUTES half. Minutes performed describes the treatment
// that already happened, so it is not reusable setup: copying it silently
// overwrote destination-specific minutes the practitioner had already typed.
// Two real-browser cases below — a blank destination stays blank, and a
// destination that was already filled in keeps its own number, not the source's.

const MINUTES_FIELD = /Minutes performed/i;

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const T = 20_000;

async function noHorizontalOverflow(page: import("@playwright/test").Page) {
  const { scrollW, clientW } = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(scrollW, `horizontal overflow (${scrollW} vs ${clientW})`).toBeLessThanOrEqual(clientW);
}

test("in-form Copy settings carries machine readings, preserves the destination area, and persists after Save (390px)", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await seedE2eChartedThermolysisBlock(seed, sessionId, {
    primaryArea: "Chin",
    energyLevel: 42,
    machineFrequency: "13.56 MHz",
    thermolysisIntensityPercent: 30,
    thermolysisDurationSeconds: 0.12,
    pulseCount: 3,
    // A distinctive source value: if minutes ever copy again, the destination
    // assertions below name exactly this number.
    minutesPerformed: 37,
  });
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

  await test.step("open a NEW settings block (source block already exists)", async () => {
    await page.getByRole("button", { name: /Add settings block/i }).click({ timeout: T });
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
    await noHorizontalOverflow(page);
  });

  await test.step("choose a DIFFERENT destination area (Cheeks) + laterality", async () => {
    await page.getByRole("button", { name: "Cheeks", exact: true }).click();
    await expect(page.getByTestId("area-row-Cheeks")).toBeVisible();
    await page.getByTestId("laterality-Cheeks-left").click();
  });

  await test.step("a fresh destination's Minutes field starts blank", async () => {
    await expect(page.getByLabel(MINUTES_FIELD)).toHaveValue("");
  });

  await test.step("Copy settings → machine readings prefill; destination area preserved; NOT yet persisted", async () => {
    await page.getByRole("button", { name: /Copy settings from another area/i }).click();
    await expect(page.getByText(/copied from Chin|from Chin/i)).toBeVisible({ timeout: T });
    await expect(page.getByLabel("Energy level (EL)")).toHaveValue("42");
    await expect(page.getByLabel("Thermolysis intensity %")).toHaveValue("30");
    // Minutes performed is an OUTCOME: the source's 37 must not arrive here.
    await expect(page.getByLabel(MINUTES_FIELD)).toHaveValue("");
    // Destination area is NOT overwritten by the source's area.
    await expect(page.getByTestId("area-row-Cheeks")).toBeVisible();
    await expect(page.getByTestId("area-row-Chin")).toHaveCount(0);
    await noHorizontalOverflow(page);
    // "Persists ONLY after Save": the prefill has written NOTHING. Only the
    // pre-seeded source block exists; there is no destination block yet.
    expect(await getSessionBlockCount(sessionId)).toBe(1);
    expect(await getSessionBlockAreas(sessionId)).toEqual([]);
  });

  await test.step("Save the new area → the destination block is created; then reload", async () => {
    await page.getByTestId("save-treatment-area").click();
    // A SECOND block (the Cheeks destination) now exists — the copy persisted
    // only on Save.
    await expect
      .poll(async () => getSessionBlockCount(sessionId), { timeout: T })
      .toBe(2);
    await expect
      .poll(async () => (await getSessionBlockAreas(sessionId)).join(","), { timeout: T })
      .toBe("Cheeks|left");
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await expect(page.getByText("Left Cheeks", { exact: false })).toBeVisible({ timeout: T });
    await noHorizontalOverflow(page);
  });

  await test.step("reload preserves the copied setup EXACTLY on the destination block; outcomes stay blank", async () => {
    // getSavedBlockSetup reads the NEWEST block = the saved Cheeks destination
    // (the seeded Chin source is the earlier block, never read here).
    const saved = (await getSavedBlockSetup(sessionId)) as Record<string, unknown> & {
      entry: Record<string, unknown> | null;
    };
    // Destination is the Cheeks block (structured area), not the Chin source.
    expect(await getSessionBlockAreas(sessionId)).toEqual(["Cheeks|left"]);
    // Copied setup persisted exactly on the destination.
    expect(Number(saved.energy_level)).toBe(42);
    expect(saved.machine_frequency).toBe("13.56 MHz");
    expect(saved.mode).toBe("thermo");
    expect(saved.probe_key).toBe("sterex-stainless-steel-two-piece-f2-short");
    expect(saved.entry).not.toBeNull();
    expect(Number(saved.entry!.thermolysis_intensity_percent)).toBe(30);
    expect(Number(saved.entry!.thermolysis_duration_seconds)).toBeCloseTo(0.12, 5);
    expect(Number(saved.entry!.pulse_count)).toBe(3);
    expect(Number(saved.entry!.pulse_delay_seconds)).toBeCloseTo(0.4, 5);
    // Every outcome/response field is blank/fresh — INCLUDING minutes, which
    // the source block carries as 37 and the copy must never have written.
    expect(saved.minutes_performed).toBeNull();
    expect(saved.tolerance_rating).toBeNull();
    expect(saved.reaction_type).toBeNull();
    expect(saved.reaction_notes).toBeNull();
    expect(saved.caution_for_next_session).toBe(false);
    expect(saved.caution_note).toBeNull();
    expect(saved.numbing_status).toBeNull();
    expect(saved.probe_lot_number).toBeNull();
    expect(saved.probe_lot_confirmed).toBe(false);
    expect(saved.entry!.hairs_treated).toBeNull();
    expect(saved.entry!.comments).toBeNull();
    expect(saved.entry!.observation_chips).toEqual([]);
  });

  await test.step("the SOURCE block's own minutes are untouched by the copy", async () => {
    expect(await getFirstBlockMinutes(sessionId)).toBe(37);
  });
});

test("Copy settings preserves minutes the practitioner already typed on the destination (390px)", async ({ page }) => {
  // The destructive case the old contract actually caused: the destination's own
  // minutes are charted FIRST, then Copy settings is pressed to pull the machine
  // setup across — and the source's minutes silently replaced them.
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  await seedE2eChartedThermolysisBlock(seed, sessionId, {
    primaryArea: "Chin",
    energyLevel: 42,
    machineFrequency: "13.56 MHz",
    thermolysisIntensityPercent: 30,
    thermolysisDurationSeconds: 0.12,
    pulseCount: 3,
    minutesPerformed: 37,
  });
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

  await test.step("open a new destination area and type its own minutes first", async () => {
    await page.getByRole("button", { name: /Add settings block/i }).click({ timeout: T });
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Cheeks", exact: true }).click();
    await expect(page.getByTestId("area-row-Cheeks")).toBeVisible();
    await page.getByTestId("laterality-Cheeks-left").click();
    await page.getByLabel(MINUTES_FIELD).fill("12");
    await expect(page.getByLabel(MINUTES_FIELD)).toHaveValue("12");
  });

  await test.step("Copy settings → machine setup arrives, the typed 12 minutes survive", async () => {
    await page.getByRole("button", { name: /Copy settings from another area/i }).click();
    await expect(page.getByText(/copied from Chin|from Chin/i)).toBeVisible({ timeout: T });
    // Positive control: the copy really did run.
    await expect(page.getByLabel("Energy level (EL)")).toHaveValue("42");
    await expect(page.getByLabel("Thermolysis intensity %")).toHaveValue("30");
    // The point: not replaced by the source's 37, and not cleared to blank.
    await expect(page.getByLabel(MINUTES_FIELD)).toHaveValue("12");
    await noHorizontalOverflow(page);
  });

  await test.step("Save → the destination persists 12, and the source still has 37", async () => {
    await page.getByTestId("save-treatment-area").click();
    await expect
      .poll(async () => getSessionBlockCount(sessionId), { timeout: T })
      .toBe(2);
    const saved = (await getSavedBlockSetup(sessionId)) as Record<string, unknown>;
    expect(Number(saved.minutes_performed)).toBe(12);
    expect(Number(saved.energy_level)).toBe(42);
    // The source block is a treatment that already happened — untouched.
    expect(await getFirstBlockMinutes(sessionId)).toBe(37);
  });
});
