import { test, expect, type Page } from "@playwright/test";
import { installWebkitLocalhostFix, isWebKit } from "./helpers/webkit-localhost";

// HON-124 item 1: search the public site. Static, public pages, so no seed or login. The search is private by construction (the index ships in the bundle,
// matching runs in the browser), so this also proves what the page does NOT do: no request carries the query, and the URL never holds it.
//   1. By keyboard on desktop: the button opens the dialog with focus in the box, a typed question finds the pricing FAQ, Arrow Down reaches the result, Enter
//      follows it to /pricing#faq with the dialog gone and no query in the URL; Escape closes and returns focus to the button.
//   2. At 390 px: the button sits beside Menu, the dialog and its rows fit and are touch-sized, a word with no match says so, and nothing scrolls sideways.

// WebKit only: strip the https upgrade the app sends for http://localhost (e2e/helpers/webkit-localhost.ts), without which the page's CSS and scripts never load. A no-op in Chromium.
test.beforeEach(async ({ page }) => {
  if (isWebKit(page)) await installWebkitLocalhostFix(page.context());
});

const SEARCH = (page: Page) => page.getByRole("button", { name: "Search", exact: true });
const DIALOG = (page: Page) => page.getByRole("dialog", { name: "Search the site" });

test("by keyboard: open, type, reach a result, follow it; the query is never sent or kept; Escape returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const requests: { method: string; url: string; body: string | null }[] = [];
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), body: r.postData() }));

  expect((await SEARCH(page).boundingBox())?.height ?? 0, "the button is touch-sized at desktop width too").toBeGreaterThanOrEqual(44);
  await SEARCH(page).focus();
  await page.keyboard.press("Enter");
  await expect(DIALOG(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search pages, guides and pricing questions" }), "focus is in the box").toBeFocused();

  await page.keyboard.type("setup fee");
  const first = DIALOG(page).locator("[data-search-result]").first();
  await expect(first).toContainText("Is there a setup fee?");
  await expect(page.getByRole("status")).toHaveText(/\d results?/);

  await page.keyboard.press("ArrowDown");
  await expect(first, "Arrow Down reaches the first result").toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("textbox", { name: "Search pages, guides and pricing questions" }), "Arrow Up returns to the box").toBeFocused();

  // Escape first: closes, and the button has focus again.
  await page.keyboard.press("Escape");
  await expect(DIALOG(page)).toHaveCount(0);
  await expect(SEARCH(page)).toBeFocused();

  // Then follow a result with Enter in the box.
  await page.keyboard.press("Enter");
  await page.keyboard.type("setup fee");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/pricing#faq$/);
  await expect(DIALOG(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Is there a setup fee?" })).toBeVisible();

  // Nothing carried the query: not the URL, not a request URL, not a request body.
  expect(page.url()).not.toMatch(/setup/i);
  for (const r of requests) {
    expect(r.url, `request ${r.url}`).not.toMatch(/setup(%20|\+| )fee/i);
    expect(r.body ?? "", `body of ${r.method} ${r.url}`).not.toMatch(/setup/i);
  }
  expect(await page.evaluate(() => ({ l: localStorage.length, s: sessionStorage.length })), "nothing stored").toEqual({ l: 0, s: 0 });
});

test("390 px: the button is beside Menu, the dialog fits, rows are touch-sized, no match says so, nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/resources");
  await expect(SEARCH(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
  expect((await SEARCH(page).boundingBox())?.height ?? 0, "button is touch-sized").toBeGreaterThanOrEqual(44);

  await SEARCH(page).click();
  await expect(DIALOG(page)).toBeVisible();
  const rows = DIALOG(page).locator("[data-search-result]");
  await expect(rows.first(), "with nothing typed the box offers the pages").toBeVisible();
  await page.getByRole("textbox", { name: "Search pages, guides and pricing questions" }).fill("paper");
  await expect(rows.first()).toContainText("Moving an electrolysis practice from paper");
  expect((await rows.first().boundingBox())?.height ?? 0, "a touch-sized row").toBeGreaterThanOrEqual(44);
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, "no horizontal scroll").toBeLessThanOrEqual(w.c);

  await page.getByRole("textbox", { name: "Search pages, guides and pricing questions" }).fill("zzzzqx");
  await expect(page.getByRole("status")).toContainText("No matches");
  await expect(rows).toHaveCount(0);

  await page.getByRole("textbox", { name: "Search pages, guides and pricing questions" }).fill("paper");
  await rows.first().click();
  await expect(page).toHaveURL(/\/resources\/moving-an-electrolysis-practice-from-paper-records$/);
  await expect(DIALOG(page)).toHaveCount(0);
});
