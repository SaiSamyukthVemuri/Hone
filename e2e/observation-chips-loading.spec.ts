import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eDraftSessionWithLegacyChipEntry } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Emergency chip-loading fix, real browser at MOBILE width (Chloe's screenshot
// context). Reproduces the exact failure: an electrolysis entry whose
// observations were saved into the LEGACY `comments` field (structured
// observation_chips empty). Before the fix the entry row showed no chip pills
// ("not loading"); after the fix the display hydrates them from comments and the
// chips render as pills, with the remaining text as the note.

test("legacy observation chips (stored in comments) render as pills on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // iPhone-ish
  const seed = await seedE2eStudio();
  const { clientId, sessionId } = await seedE2eDraftSessionWithLegacyChipEntry(
    seed,
    "Coarse hair, Slight edema, tender near jaw, Lots of anagen",
  );
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);

  // The three chips hydrate from comments and render as pills. The legacy
  // "Slight edema" spelling resolves to the current canonical label
  // "Slight swelling (edema)" (vocabulary cleanup; no backfill).
  for (const chip of ["Coarse hair", "Slight swelling (edema)", "Lots of anagen"]) {
    await expect(page.getByText(chip, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  }
  // The non-chip free text is preserved as the note (nothing lost).
  await expect(page.getByText(/tender near jaw/i).first()).toBeVisible();
});
