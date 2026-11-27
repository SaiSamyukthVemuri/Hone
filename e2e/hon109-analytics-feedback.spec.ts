import { test, expect, type Page } from "@playwright/test";

import { seedE2eStudio } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-109: every server-backed Analytics control acknowledges a press inside the 100 ms budget.
// Measured from the INPUT EVENT's own timestamp to the first frame that shows the control's pending signal, in the page (so Playwright and CDP latency
// are not in the number), on a WARM run, with the destination held for 1.5 s so the pending state is the only thing that can have changed.
const BUDGET_MS = 100;
const HOLD_MS = 1500;

async function armProbe(page: Page, signal: string) {
  await page.evaluate((sel) => {
    const w = window as unknown as { __ack: number | null };
    w.__ack = null;
    let t0: number | null = null;
    const down = (e: Event) => { if (t0 === null) t0 = e.timeStamp; };
    for (const t of ["pointerup", "click", "keydown", "submit"]) document.addEventListener(t, down, { capture: true, once: false });
    const mo = new MutationObserver(() => {
      if (w.__ack === null && t0 !== null && document.querySelector(sel)) {
        requestAnimationFrame(() => requestAnimationFrame(() => { if (w.__ack === null) w.__ack = performance.now() - t0!; }));
      }
    });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }, signal);
}

async function holdDestination(page: Page) {
  await page.route(/\/financials\/analytics(\/|\?|$)/, async (route) => {
    const req = route.request();
    // Only the navigation / RSC fetch of a DIFFERENT url than the one on screen is held.
    if (req.url() === page.url()) return route.continue();
    await new Promise((r) => setTimeout(r, HOLD_MS));
    return route.continue();
  });
}

test.describe("HON-109 Analytics controls acknowledge a press", () => {
  test("the section tab and the period Show button are acknowledged within the budget on a warm run", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/financials/analytics");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await holdDestination(page);

    // 1. a section tab (PendingLink): the pending live region speaks
    await armProbe(page, '[role="status"]:not(:empty)');
    await page.locator('main a[href*="/financials/analytics/clients"]').first().click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ack: number | null }).__ack), { timeout: 5000 }).not.toBeNull();
    const tab = await page.evaluate(() => (window as unknown as { __ack: number }).__ack);
    expect(tab, "tab acknowledgement (ms)").toBeLessThan(BUDGET_MS);
    await expect(page).toHaveURL(/\/financials\/analytics\/clients/, { timeout: 15_000 });

    // 2. the period form's Show button (PendingGetForm + PendingSubmit): aria-busy on the submit
    await page.goto("/financials/analytics");
    await armProbe(page, 'button[type="submit"][aria-busy="true"]');
    await page.getByLabel("Period").selectOption("last_30_days").catch(() => undefined);
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ack: number | null }).__ack), { timeout: 5000 }).not.toBeNull();
    const show = await page.evaluate(() => (window as unknown as { __ack: number }).__ack);
    expect(show, "period Show acknowledgement (ms)").toBeLessThan(BUDGET_MS);
  });
});
