import { test, expect, type Locator, type Page } from "@playwright/test";

import {
  getOwnerPractitionerId,
  seedConfirmedAppointment,
  seedE2eStudio,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-58 shared UI lesson, proved as ONE real click journey on /clients:
// search > filter > sort > page > open overview > book > back > close > Escape > clear.
//
// What it pins (not screenshots, not types): no anchor or field jump (scroll offset
// and the opened row's own position are unchanged), the overview opens FOCUSED and
// inside its row, closing restores focus to that row and the search, filters, sort
// and page exactly, every control is visible without a dropdown and is a 44px
// target at phone width, and an active filter reads as active (checked, in the URL
// and in words). Synthetic data on the owned local stack.

const T = 20_000;
const PAGE_SIZE = 25;

async function seedDirectory(): Promise<E2eSeed> {
  const seed = await seedE2eStudio();
  // 60 clients, so a filtered set still spans three pages (25 + 25 + the rest).
  await sql(
    `insert into public.clients (id, studio_id, name, email)
     select gen_random_uuid(), $1, 'Journey ' || lpad(n::text, 2, '0'), 'journey-' || $2 || '-' || n || '@harness.local'
       from generate_series(1, 60) n`,
    [seed.studioId, seed.runId],
  );
  // Four of them have an upcoming appointment, so "No upcoming appointment" removes exactly four.
  const practitionerId = await getOwnerPractitionerId(seed.studioId);
  const names = ["Journey 01", "Journey 02", "Journey 03", "Journey 04"];
  const ids = await sql<{ id: string; name: string }>(
    `select id, name from public.clients where studio_id = $1 and name = any($2::text[]) order by name`,
    [seed.studioId, names],
  );
  for (const [i, c] of ids.entries()) {
    const day = 2 + i;
    const start = new Date(Date.now() + day * 86_400_000);
    start.setUTCMinutes(0, 0, 0);
    await seedConfirmedAppointment(
      seed.studioId,
      practitionerId,
      c.id,
      start.toISOString(),
      new Date(start.getTime() + 3_600_000).toISOString(),
    );
  }
  return seed;
}

const search = (page: Page) => page.getByRole("searchbox", { name: "Search clients" });
const filter = (page: Page, name: string) => page.getByRole("checkbox", { name });
const sortOption = (page: Page, name: string) => page.getByRole("radio", { name });
const rowLinks = (page: Page) => page.locator('a[id^="client-open-"]');
const pageOf = (page: Page) => page.getByText(/^Page \d+ of \d+$/);

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!.y;
}

/** The label that wraps a visually-hidden radio or checkbox: this is the control a person taps. */
function chip(page: Page, control: Locator): Locator {
  return page.locator("label", { has: control });
}

function params(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

async function applyFilter(page: Page, name: string) {
  const before = await scrollY(page);
  await chip(page, filter(page, name)).click();
  await expect(filter(page, name)).toBeChecked();
  expect(await scrollY(page)).toBe(before);
}

test.describe("clients directory: one real click journey (HON-58)", () => {
  test("desktop: search > filter > sort > page > open > book > back > close > Escape > clear", async ({ page }) => {
    test.setTimeout(120_000);
    const seed = await seedDirectory();
    await loginAsOwner(page, seed);
    await page.goto("/clients");
    await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible({ timeout: T });
    await expect(page.getByText("60 clients · showing 1–25")).toBeVisible({ timeout: T });
    // Reference fidelity (HON-58, 1 Nov): the five visible headings, and Intake in its own cell.
    const headings = page.getByTestId("directory-headings");
    for (const h of ["Client", "Last visit", "Next appointment", "Intake", "Actions"]) {
      await expect(headings.getByText(h, { exact: true })).toBeVisible();
    }
    const firstRow = page.locator("ul > li[id^='client-']").first();
    await expect(firstRow.getByText("Intake:", { exact: false })).toBeAttached();
    await expect(firstRow.getByText("Last visit:", { exact: false })).toBeAttached();
    await expect(firstRow.getByText("Next appointment:", { exact: false })).toBeAttached();

    // SEARCH: Enter submits, the text stays, the URL carries it, nothing jumps.
    await search(page).fill("journey");
    await search(page).press("Enter");
    await expect(page).toHaveURL(/[?&]q=journey/, { timeout: T });
    await expect(page.getByText("60 matches · showing 1–25")).toBeVisible({ timeout: T });
    await expect(search(page)).toHaveValue("journey");
    expect(new URL(page.url()).hash).toBe("");

    // FILTER: applies on change, keeps focus on the chip and the typed text, reads as active.
    await applyFilter(page, "No upcoming appointment");
    await expect(page).toHaveURL(/filter=no_upcoming/, { timeout: T });
    await expect(page.getByText("56 matches · showing 1–25")).toBeVisible({ timeout: T });
    await expect(filter(page, "No upcoming appointment")).toBeFocused();
    await expect(search(page)).toHaveValue("journey");
    await expect(page.getByText("Showing:")).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear search and filters" })).toBeVisible();

    // SORT: applies on change, the chosen option reads as selected, filters and search persist.
    await chip(page, sortOption(page, "Next appointment")).click();
    await expect(page).toHaveURL(/sort=next/, { timeout: T });
    await expect(sortOption(page, "Next appointment")).toBeChecked();
    await expect(filter(page, "No upcoming appointment")).toBeChecked();
    await expect(search(page)).toHaveValue("journey");

    // PAGE: the whole state travels with the page link.
    await page.getByRole("link", { name: "Next", exact: true }).click();
    await expect(page).toHaveURL(/page=2/, { timeout: T });
    await expect(pageOf(page)).toHaveText("Page 2 of 3");
    await expect(page.getByText("56 matches · showing 26–50")).toBeVisible();
    const list = params(page);
    expect([list.get("q"), list.get("filter"), list.get("sort")]).toEqual(["journey", "no_upcoming", "next"]);

    // OPEN OVERVIEW: in place under its row, focused, nothing moved, no fragment.
    const row = rowLinks(page).nth(3);
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const rowId = (await row.getAttribute("id"))!;
    const clientId = rowId.replace("client-open-", "");
    const rowTop = await top(row);
    const yBefore = await scrollY(page);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`client=${clientId}`), { timeout: T });
    const overview = page.getByRole("complementary", { name: /Journey \d+/ });
    await expect(overview).toBeVisible({ timeout: T });
    await expect(overview.getByRole("heading", { level: 2 })).toBeFocused();
    await expect(page.locator(`li#client-${clientId}`).getByRole("complementary")).toBeVisible();
    expect(await top(row)).toBeCloseTo(rowTop, 0);
    expect(await scrollY(page)).toBe(yBefore);
    expect(new URL(page.url()).hash).toBe("");
    const open = params(page);
    expect([open.get("q"), open.get("filter"), open.get("sort"), open.get("page")]).toEqual([
      "journey",
      "no_upcoming",
      "next",
      "2",
    ]);

    // BOOK: the link goes to the profile's booking; going Back restores the directory exactly.
    const openUrl = page.url();
    const book = overview.getByRole("link", { name: "Book appointment" });
    await expect(book).toHaveAttribute("href", `/clients/${clientId}?book=1`);
    await book.click();
    await expect(page).toHaveURL(new RegExp(`/clients/${clientId}(\\?|$)`), { timeout: T });
    await page.goBack();
    await expect(page).toHaveURL(openUrl, { timeout: T });
    await expect(overview).toBeVisible({ timeout: T });
    await expect(search(page)).toHaveValue("journey");
    await expect(filter(page, "No upcoming appointment")).toBeChecked();
    await expect(sortOption(page, "Next appointment")).toBeChecked();
    await expect(pageOf(page)).toHaveText("Page 2 of 3");

    // CLOSE: same list, focus back on the row that opened it, row and scroll where they were.
    const closeRowTop = await top(row);
    const closeY = await scrollY(page);
    await overview.getByRole("link", { name: /^Close overview/ }).click();
    await expect(overview).toHaveCount(0, { timeout: T });
    await expect(page).not.toHaveURL(/client=/);
    expect(new URL(page.url()).hash).toBe("");
    await expect(row).toBeFocused();
    expect(await top(row)).toBeCloseTo(closeRowTop, 0);
    expect(await scrollY(page)).toBe(closeY);
    const closed = params(page);
    expect([closed.get("q"), closed.get("filter"), closed.get("sort"), closed.get("page")]).toEqual([
      "journey",
      "no_upcoming",
      "next",
      "2",
    ]);
    await expect(search(page)).toHaveValue("journey");
    await expect(filter(page, "No upcoming appointment")).toBeChecked();
    await expect(sortOption(page, "Next appointment")).toBeChecked();
    await expect(pageOf(page)).toHaveText("Page 2 of 3");

    // ESCAPE: closes from the keyboard and returns focus to the same row.
    await row.click();
    await expect(overview).toBeVisible({ timeout: T });
    await expect(overview.getByRole("heading", { level: 2 })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(overview).toHaveCount(0, { timeout: T });
    await expect(row).toBeFocused();

    // CLEAR: one control resets the text, the filter and the sort together.
    await page.getByRole("button", { name: "Clear search and filters" }).click();
    await expect(page).toHaveURL(/\/clients$/, { timeout: T });
    await expect(search(page)).toHaveValue("");
    await expect(filter(page, "No upcoming appointment")).not.toBeChecked();
    await expect(sortOption(page, "Name")).toBeChecked();
    await expect(page.getByText("60 clients · showing 1–25")).toBeVisible({ timeout: T });
    expect(PAGE_SIZE).toBe(25);
  });

  test.describe("phone width", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("every control is on screen, 44px, nothing overflows, and the overview opens and closes in place", async ({ page }) => {
      test.setTimeout(90_000);
      const seed = await seedDirectory();
      await loginAsOwner(page, seed);
      await page.goto("/clients");
      await expect(page.getByText("60 clients · showing 1–25")).toBeVisible({ timeout: T });
      // Phone cards carry explicit inline labels instead of relying on column position.
      const card = page.locator("ul > li[id^='client-']").first();
      await expect(page.getByTestId("directory-headings")).toBeHidden();
      for (const l of ["Last visit:", "Next appointment:", "Intake:"]) {
        await expect(card.getByText(l, { exact: false }).first()).toBeVisible();
      }

      // Reachable without a menu: search, both sort options and both filters are all there.
      for (const control of [
        search(page),
        page.getByRole("button", { name: "Search", exact: true }),
        chip(page, sortOption(page, "Name")),
        chip(page, sortOption(page, "Next appointment")),
        chip(page, filter(page, "Intake needs review")),
        chip(page, filter(page, "No upcoming appointment")),
      ]) {
        await expect(control).toBeVisible();
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      }
      expect(await page.locator("select").count()).toBe(0);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);

      // Filter on a phone: applies, stays focused, scroll untouched.
      await applyFilter(page, "No upcoming appointment");
      await expect(page).toHaveURL(/filter=no_upcoming/, { timeout: T });
      await expect(page.getByText("56 matches")).toBeVisible({ timeout: T });

      // Overview in place, focused; close returns to the row; state intact.
      const row = rowLinks(page).nth(2);
      await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const rowTop = await top(row);
      await row.click();
      const overview = page.getByRole("complementary", { name: /Journey \d+/ });
      await expect(overview).toBeVisible({ timeout: T });
      await expect(overview.getByRole("heading", { level: 2 })).toBeFocused();
      expect(await top(row)).toBeCloseTo(rowTop, 0);
      for (const name of [/^Close overview/, /Open full profile/, /Book appointment/]) {
        expect((await overview.getByRole("link", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      }
      const overflowOpen = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflowOpen).toBeLessThanOrEqual(1);
      await overview.getByRole("link", { name: /^Close overview/ }).click();
      await expect(overview).toHaveCount(0, { timeout: T });
      await expect(row).toBeFocused();
      expect(await top(row)).toBeCloseTo(rowTop, 0);
      await expect(filter(page, "No upcoming appointment")).toBeChecked();
    });
  });
});
