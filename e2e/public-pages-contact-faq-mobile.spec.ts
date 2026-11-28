import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio } from "./helpers/seed";
import { PAGE_REVISIONS } from "@/lib/marketing/page-revisions";

// HON-124 items 3, 12 and 15 on the public pages, at iPhone width (390x844), by touch emulation AND keyboard.
//   * pricing FAQ: the new booking answers are plain text on the page; a real "Last updated" date from the pinned constant;
//   * a feature page shows its pinned date;
//   * the booking page keeps "contact your studio" and "Hone support" as two separate lines, and the support link is reachable by keyboard.
// Synthetic fixture studio only; nothing is submitted.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const T = 20_000;
async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

test("pricing: booking FAQ answers are plain text and the revision date is the pinned constant", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Can my clients book online?" })).toBeVisible({ timeout: T });
  await expect(page.getByText("Each studio has its own public booking link on hone.care.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Can clients change or cancel their own appointment?" })).toBeVisible();
  // plain text in the document, not behind a script: present in the server HTML too
  const html = await (await page.request.get("/pricing")).text();
  expect(html).toContain("Can my clients book online?");
  const rev = page.getByTestId("page-revision").locator("time");
  await expect(rev).toHaveAttribute("datetime", PAGE_REVISIONS["/pricing"]);
  await expect(rev).toBeVisible();
  await noHorizontalScroll(page);
});

test("a feature page shows its pinned revision date", async ({ page }) => {
  await page.goto("/features/booking-calendar");
  const rev = page.getByTestId("page-revision").locator("time");
  await expect(rev).toHaveAttribute("datetime", PAGE_REVISIONS["/features/booking-calendar"], { timeout: T });
  await noHorizontalScroll(page);
});

test("booking page: the studio and Hone support are two separate lines, and the support link works by keyboard", async ({ page }) => {
  const seed = await seedE2eStudio();
  await page.goto(`/book/${seed.slug}`);
  const box = page.getByTestId("contact-paths");
  await expect(box).toBeVisible({ timeout: T });
  const lines = box.locator("p");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText("About your appointment or treatment: contact your studio directly.");
  await expect(lines.nth(1)).toContainText("Hone support, for problems with this website:");
  await expect(lines.nth(1).locator("a")).toHaveAttribute("href", "mailto:hello@hone.care");
  await expect(lines.nth(0).locator("a")).toHaveCount(0); // the studio line never carries a Hone address
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => (document.activeElement as HTMLAnchorElement | null)?.href === "mailto:hello@hone.care");
  }
  expect(reached, "Tab reaches the Hone support link").toBe(true);
  await expect(lines.nth(1).locator("a")).toBeInViewport();
  await noHorizontalScroll(page);
});
