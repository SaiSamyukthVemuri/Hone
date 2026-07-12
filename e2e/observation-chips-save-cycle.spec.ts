import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDraftSessionWithLegacyChipEntry,
  getEntryObservationChips,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Emergency chip-loading fix — full save cycle in a REAL browser at MOBILE width
// (Chloe's screenshot context), exercising the REAL forms + REAL server actions
// with DATABASE read-back between steps. Covers both surfaces:
//   * block-setup-form EDIT (Chloe's reported surface): legacy chips preload as
//     SELECTED controls, add/remove persists, reload keeps them.
//   * SimplifiedEntryForm CREATE ("Add pass"): select/save/persist + deselect +
//     no duplicates.

const A = "Coarse hair";
const B = "Slight edema";
const C = "Lots of anagen";
const D = "Erythema";
const MOBILE = { width: 390, height: 844 };

async function chipButton(page: Page, label: string) {
  // A structured chip button shows the label when SELECTED, and "+ <label>" when
  // not. This resolves whichever is present.
  const selected = page.getByRole("button", { name: label, exact: true });
  if (await selected.count()) return selected.first();
  return page.getByRole("button", { name: `+ ${label}`, exact: true }).first();
}

test("block-setup-form: legacy chips preload as SELECTED, add + remove persist (mobile)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftSessionWithLegacyChipEntry(
    seed,
    `${A}, ${B}, tender near jaw, ${C}`, // chips in the legacy comments; observation_chips = []
  );
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

  await test.step("open the treatment area for edit → the 3 legacy chips are pre-SELECTED", async () => {
    await page.getByRole("button", { name: "Edit" }).first().click();
    for (const chip of [A, B, C]) {
      await expect(page.getByRole("button", { name: chip, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
        { timeout: 20_000 },
      );
    }
    // The non-chip free text stays as the note.
    await expect(page.getByText(/tender near jaw/i).first()).toBeVisible();
  });

  await test.step("add a 4th chip, save → DB has all four (migrated from comments + new)", async () => {
    await (await chipButton(page, D)).click();
    await page.getByRole("button", { name: /save treatment area/i }).click();
    await expect.poll(async () => (await getEntryObservationChips(sessionId, "first")).slice().sort().join("|"), {
      timeout: 20_000,
    }).toBe([A, B, C, D].slice().sort().join("|"));
  });

  await test.step("reload → reopen → all four remain selected", async () => {
    await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await page.getByRole("button", { name: "Edit" }).first().click();
    for (const chip of [A, B, C, D]) {
      await expect(page.getByRole("button", { name: chip, exact: true })).toHaveAttribute("aria-pressed", "true", {
        timeout: 20_000,
      });
    }
  });

  await test.step("deselect one, save → only that chip is removed (no dupes)", async () => {
    await (await chipButton(page, D)).click(); // D is selected → this deselects
    await page.getByRole("button", { name: /save treatment area/i }).click();
    await expect.poll(async () => (await getEntryObservationChips(sessionId, "first")).slice().sort().join("|"), {
      timeout: 20_000,
    }).toBe([A, B, C].slice().sort().join("|"));
    // No duplicates in the stored array.
    const stored = await getEntryObservationChips(sessionId, "first");
    expect(new Set(stored).size).toBe(stored.length);
  });
});

test("SimplifiedEntryForm: select 3 chips → save → persist; deselect + no dupes (mobile)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  const seed = await seedE2eStudio();
  // A block already exists (SimplifiedEntryForm is the "Add pass" surface inside a block).
  const { clientId, sessionId } = await seedE2eDraftSessionWithLegacyChipEntry(seed, "existing note");
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

  await test.step("Add pass with 3 chips → the new entry stores exactly those three", async () => {
    await page.getByRole("button", { name: /add another pass/i }).click();
    await page.getByRole("button", { name: "Chin", exact: true }).first().click(); // area
    for (const chip of [A, B, C]) await (await chipButton(page, chip)).click();
    await page.getByRole("button", { name: /^Add pass$/ }).click();
    await expect.poll(async () => (await getEntryObservationChips(sessionId, "last")).slice().sort().join("|"), {
      timeout: 20_000,
    }).toBe([A, B, C].slice().sort().join("|"));
  });

  await test.step("Add another pass, toggle a chip OFF before save → no duplicate, deselection honored", async () => {
    await page.getByRole("button", { name: /add another pass/i }).click();
    await page.getByRole("button", { name: "Chin", exact: true }).first().click();
    const a = await chipButton(page, A);
    await a.click(); // select A
    await (await chipButton(page, A)).click(); // deselect A (toggle)
    await (await chipButton(page, B)).click(); // select B
    await page.getByRole("button", { name: /^Add pass$/ }).click();
    await expect.poll(async () => (await getEntryObservationChips(sessionId, "last")).join("|"), {
      timeout: 20_000,
    }).toBe(B); // only B; A was deselected; no duplicate
  });
});
