import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  seedClientPersonalNotes,
  getClientPersonalNotes,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Personal Notes bullet workflow, run in MOBILE CHROMIUM at iPhone (390px)
// dimensions + hasTouch (the repo E2E engine is Chromium — this is NOT real iOS
// Safari/WebKit). Proves: existing text loads unchanged, Add bullet + Enter
// continuation work, save persists the exact PLAIN text, reload restores it, and
// there is no horizontal overflow.

async function noOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `${label}: no horizontal overflow (${w.s} vs ${w.c})`).toBeLessThanOrEqual(w.c);
}

test("owner adds bullets to Personal Notes on iPhone; plain text persists", async ({ browser }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await seedClientPersonalNotes(clientId, "Loves gardening.");

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}?tab=personal`);

    const ta = page.locator('textarea[name="personal_notes"]');
    await expect(ta).toBeVisible({ timeout: 20_000 });
    // 1) existing text loads unchanged.
    await expect(ta).toHaveValue("Loves gardening.");
    await noOverflow(page, "personal tab @390 (loaded)");

    // Move to end, start a new line, then Add bullet + continuation.
    await ta.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: /Add bullet/ }).click();
    await page.keyboard.type("Ask about vacation");
    await page.keyboard.press("Enter"); // continues with "• "
    await page.keyboard.type("Prefers afternoons");
    await expect(ta).toHaveValue("Loves gardening.\n• Ask about vacation\n• Prefers afternoons");
    await noOverflow(page, "personal tab @390 (bulleting)");

    // Save, then reload — plain text preserved exactly.
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 15_000 });
    // The browser normalizes <textarea> newlines to CRLF when the form's
    // FormData is built on submit (WHATWG form-submission spec) — so the stored
    // value uses "\r\n". This is pre-existing for every multi-line note and the
    // existing save action is unchanged; the browser converts CRLF back to "\n"
    // when the value is loaded into a textarea, so the practitioner always sees
    // the same plain text (asserted via toHaveValue after reload below). Compare
    // stored content modulo that line-ending encoding.
    expect((await getClientPersonalNotes(clientId)).replace(/\r\n/g, "\n")).toBe(
      "Loves gardening.\n• Ask about vacation\n• Prefers afternoons",
    );
    await page.reload();
    await expect(page.locator('textarea[name="personal_notes"]')).toHaveValue(
      "Loves gardening.\n• Ask about vacation\n• Prefers afternoons",
    );
    await noOverflow(page, "personal tab @390 (after reload)");
  } finally {
    await ctx.close();
  }
});
