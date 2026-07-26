import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftElectrolysisSession,
  seedE2eChartedBlendBlockWithGalvanicIntensity,
  seedE2eBareBlock,
  getSavedBlockSetup,
  getBlockPrimaryEntry,
  getBlockEntryCount,
  getSessionBlockCount,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Galvanic-intensity retirement — REAL browser, REAL local stack.
//
// galvanic_intensity_percent is a RETIRED reading. This spec proves the
// server-authoritative write policy end-to-end against the actual charting forms
// and Postgres (read back via node-pg):
//   * in-form "Copy settings" copies valid reusable settings but NEVER galvanic
//     intensity, even from a source that still carries a legacy value;
//   * a NEW entry always stores NULL — even a forged request carrying 42;
//   * the "first entry absent" update branch stores NULL for the brand-new row;
//   * an unrelated edit of a historical entry PRESERVES its stored value exactly.
// 42 is a CHECK-valid value (0..100), so a NULL result unambiguously proves the
// server-authoritative NULL — not a constraint bounce.

const T = 20_000;

type SavedBlock = Record<string, unknown> & {
  entry: Record<string, unknown> | null;
  entries: Array<Record<string, unknown>>;
};

// The full legacy source: a blend/PicoBlend block whose primary entry carries a
// non-null galvanic_intensity_percent AND the full reusable reading set.
const SOURCE = {
  primaryArea: "Lip",
  apilusModality: "Picoblend",
  energyLevel: 120,
  machineFrequency: "13.56 MHz",
  thermolysisIntensityPercent: 8,
  thermolysisDurationSeconds: 0.5,
  galvanicMa: 0.6,
  galvanicDurationSeconds: 7,
  unitsOfLye: 55,
  galvanicIntensityPercent: 42,
  pulseCount: 3,
} as const;

test.describe("galvanic intensity is retired from every current write path", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("(1) in-form Copy settings copies valid reusable settings but NEVER galvanic intensity", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    const { blockId: sourceBlockId } =
      await seedE2eChartedBlendBlockWithGalvanicIntensity(seed, sessionId, SOURCE);

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

    // Open the "Add settings block" form for a NEW area (Chin).
    await page.getByRole("button", { name: /Add settings block/i }).click({ timeout: T });
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await expect(page.getByTestId("area-row-Chin")).toBeVisible();
    await page.getByTestId("laterality-Chin-left").click();

    // Copy settings from the (only) prior area in this session.
    await page.getByRole("button", { name: /Copy settings/i }).click();

    // The reusable machine setup is now prefilled (mode/modality/readings).
    await expect(
      page.getByRole("combobox", { name: "Modality", exact: true }),
    ).toHaveValue("Picoblend", { timeout: T });

    await page.getByTestId("save-treatment-area").click();

    // Two blocks now: the seeded source + the new destination.
    await expect.poll(async () => getSessionBlockCount(sessionId), { timeout: T }).toBe(2);

    const dest = (await getSavedBlockSetup(sessionId)) as SavedBlock; // NEWEST = destination
    const destEntry = dest.entry as Record<string, unknown>;
    expect(dest.mode).toBe("blend");
    expect(dest.apilus_modality).toBe("Picoblend");

    // Valid reusable galvanic + thermolysis settings ARE copied...
    expect(Number(destEntry.galvanic_ma)).toBe(SOURCE.galvanicMa);
    expect(Number(destEntry.galvanic_duration_seconds)).toBe(SOURCE.galvanicDurationSeconds);
    expect(Number(destEntry.units_of_lye)).toBe(SOURCE.unitsOfLye);
    expect(Number(destEntry.thermolysis_intensity_percent)).toBe(SOURCE.thermolysisIntensityPercent);
    expect(Number(destEntry.thermolysis_duration_seconds)).toBe(SOURCE.thermolysisDurationSeconds);
    expect(Number(destEntry.pulse_count)).toBe(SOURCE.pulseCount);

    // ...but galvanic intensity is NEVER copied into the new record.
    expect(destEntry.galvanic_intensity_percent).toBeNull();

    // And the historical source is untouched (still exactly 42).
    const src = await getBlockPrimaryEntry(sourceBlockId);
    expect(Number(src?.galvanic_intensity_percent)).toBe(42);
  });

  test("(2) the primary block-form create stores galvanic_intensity_percent = NULL (no input to supply)", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

    await page.getByRole("button", { name: /Add settings block/i }).click({ timeout: T });
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await expect(page.getByTestId("area-row-Chin")).toBeVisible();
    await page.getByTestId("laterality-Chin-left").click();
    await page.getByRole("button", { name: "Blend", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Modality", exact: true })
      .selectOption({ label: "PicoBlend" });
    await page.getByRole("spinbutton", { name: "Galvanic mA", exact: true }).fill("0.74");
    await page.getByTestId("save-treatment-area").click();

    await expect.poll(async () => getSessionBlockCount(sessionId), { timeout: T }).toBe(1);
    const saved = (await getSavedBlockSetup(sessionId)) as SavedBlock;
    expect((saved.entry as Record<string, unknown>).galvanic_intensity_percent).toBeNull();
  });

  test("(3) a FORGED add-another-pass request carrying galvanic_intensity_percent=42 still stores NULL", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    // A real blend block to add a pass onto (its primary entry carries 42).
    const { blockId } = await seedE2eChartedBlendBlockWithGalvanicIntensity(
      seed,
      sessionId,
      SOURCE,
    );
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

    // Open "Add another pass" (SimplifiedEntryForm → addElectrolysisEntryAction,
    // which submits a manually-built FormData).
    await page.getByTestId(`add-pass-${blockId}`).click();
    const form = page.getByTestId("add-pass-form");
    await expect(form).toBeVisible({ timeout: T });
    // Any valid body-map area works for this pass; the assertion is about the
    // forged galvanic-intensity value, not the area.
    await form.getByRole("button", { name: "Chin", exact: true }).click();
    await form.getByRole("spinbutton", { name: "Galvanic mA", exact: true }).fill("0.74");

    // FORGE: patch FormData.set so the outgoing request the server action receives
    // literally carries galvanic_intensity_percent=42 (a value the DB CHECK would
    // accept). The form itself never sets this field; the injection fires once when
    // the form sets units_of_lye. If the server were not authoritative, 42 would
    // land — so a NULL read-back is a real security guarantee, not a no-op.
    await page.evaluate(() => {
      // Cast to a string-only signature so we don't resolve FormData.set's Blob
      // overload; the charting forms only ever set string values.
      const proto = FormData.prototype as unknown as {
        set: (name: string, value: string) => void;
      };
      const orig = proto.set;
      let injected = false;
      proto.set = function (this: FormData, name: string, value: string) {
        orig.call(this, name, value);
        if (name === "units_of_lye" && !injected) {
          injected = true;
          orig.call(this, "galvanic_intensity_percent", "42");
        }
      };
    });

    await form.getByTestId("add-pass-submit").click();

    // Two live entries now on the block; the newest is the forged add-pass.
    await expect
      .poll(async () => ((await getSavedBlockSetup(sessionId)) as SavedBlock).entries.length, {
        timeout: T,
      })
      .toBe(2);
    const saved = (await getSavedBlockSetup(sessionId)) as SavedBlock;
    const added = saved.entries[saved.entries.length - 1];
    expect(Number(added.galvanic_ma)).toBe(0.74); // the forged request DID go through...
    expect(added.galvanic_intensity_percent).toBeNull(); // ...but 42 was ignored.
    // The original entry is untouched.
    expect(Number(saved.entries[0].galvanic_intensity_percent)).toBe(42);
  });

  test("(4) creating the first entry through the update-area action stores NULL", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    // A bare blend block with NO entry — editing it INSERTS the first entry.
    const { blockId } = await seedE2eBareBlock(seed, sessionId, { mode: "blend" });
    expect(await getBlockEntryCount(blockId)).toBe(0);

    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

    await page.getByTestId(`edit-area-${blockId}`).click();
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });
    // Add an area + a galvanic reading so a first entry is created.
    await page.getByRole("button", { name: "Chin", exact: true }).click();
    await expect(page.getByTestId("area-row-Chin")).toBeVisible();
    await page.getByTestId("laterality-Chin-left").click();
    await page.getByRole("spinbutton", { name: "Galvanic mA", exact: true }).fill("0.74");
    await page.getByTestId("save-treatment-area").click();

    await expect.poll(async () => getBlockEntryCount(blockId), { timeout: T }).toBe(1);
    const entry = await getBlockPrimaryEntry(blockId);
    expect(Number(entry?.galvanic_ma)).toBe(0.74);
    expect(entry?.galvanic_intensity_percent).toBeNull();
  });

  test("(5) editing an existing historical entry preserves its stored galvanic intensity exactly", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
    const { blockId } = await seedE2eChartedBlendBlockWithGalvanicIntensity(
      seed,
      sessionId,
      SOURCE,
    );
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

    await page.getByTestId(`edit-area-${blockId}`).click();
    await expect(page.getByText(/Areas treated with these settings/i)).toBeVisible({ timeout: T });

    // Change an UNRELATED field (Additional notes) and save.
    const notes = page.getByTestId("additional-notes");
    await notes.fill("Unrelated edit — checking galvanic intensity is preserved.");
    await page.getByTestId("save-treatment-area").click();

    // The unrelated change persisted...
    await expect
      .poll(async () => (await getBlockPrimaryEntry(blockId))?.comments, { timeout: T })
      .toContain("Unrelated edit");
    // ...and the historical galvanic intensity is UNTOUCHED (still exactly 42).
    const entry = await getBlockPrimaryEntry(blockId);
    expect(Number(entry?.galvanic_intensity_percent)).toBe(42);
  });
});
