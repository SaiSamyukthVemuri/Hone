import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  seedPinnedNote,
  getPinnedNoteById,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Editing a mutable pinned note at iPhone width (Chloe's request): Edit opens an
// inline editor pre-filled with the current text; Save updates the SAME note in
// place (same id, no duplicate); Cancel leaves it unchanged; no horizontal
// overflow while editing.

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(
    w.s,
    `${label}: page must not scroll horizontally (${w.s} vs ${w.c})`,
  ).toBeLessThanOrEqual(w.c);
}

async function iphone(browser: import("@playwright/test").Browser) {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 2,
  });
}

test("owner edits a pinned note in place on an iPhone viewport", async ({ browser }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const noteId = await seedPinnedNote(seed.studioId, clientId, "Allergy: latex");

  const ctx = await iphone(browser);
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    await expect(page.getByText("Allergy: latex")).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, "client profile @390 (view)");

    await page.getByRole("button", { name: "Edit pinned note" }).click();
    const editor = page.getByRole("textbox", { name: "Edit pinned note" });
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("Allergy: latex"); // pre-filled
    await expectNoHorizontalOverflow(page, "client profile @390 (editing)");

    await editor.fill("Allergy: latex + penicillin");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect(page.getByText("Allergy: latex + penicillin")).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, "client profile @390 (after save)");

    // Same note id, text changed → edited in place, not deleted + recreated.
    const row = await getPinnedNoteById(noteId);
    expect(row?.id).toBe(noteId);
    expect(row?.text).toBe("Allergy: latex + penicillin");
  } finally {
    await ctx.close();
  }
});

test("cancel leaves the pinned note unchanged", async ({ browser }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const noteId = await seedPinnedNote(seed.studioId, clientId, "Keep me");

  const ctx = await iphone(browser);
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    await page.getByRole("button", { name: "Edit pinned note" }).click();
    const editor = page.getByRole("textbox", { name: "Edit pinned note" });
    await editor.fill("changed but cancelled");
    await page.getByRole("button", { name: /^Cancel$/ }).click();

    await expect(page.getByText("Keep me")).toBeVisible();
    const row = await getPinnedNoteById(noteId);
    expect(row?.text).toBe("Keep me"); // unchanged
  } finally {
    await ctx.close();
  }
});
