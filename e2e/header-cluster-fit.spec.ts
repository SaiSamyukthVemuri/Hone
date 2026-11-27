import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// REGRESSION: at 1024 px an owner whose studio shows the Waitlist link, with a first name that fills the
// account button's 12ch cap, had a header cluster 30 px wider than the viewport: the page scrolled sideways
// and the account button was clipped. The search input now yields width first (GlobalSearch.tsx). The
// assertion is exact: the page is never wider than the viewport, and the account button ends inside it.
const WIDTHS = [1024, 1060, 1100, 1280];
const LONG_NAME = "Bartholomew-Featherstonehaugh Owner";

async function assertFits(page: Page, who: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    const m = await page.evaluate(() => {
      const acct = document.querySelector('[aria-label="Open account menu"]')!.getBoundingClientRect();
      const search = document.querySelector('input[aria-label="Search Hone"]')!.getBoundingClientRect();
      return { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, acctRight: acct.right, searchW: search.width };
    });
    expect(m.scrollW, `${who} @${width}: the page scrolls sideways`).toBe(m.clientW);
    expect(m.acctRight, `${who} @${width}: the account button is clipped`).toBeLessThanOrEqual(m.clientW);
    expect(m.searchW, `${who} @${width}: the search stays usable`).toBeGreaterThanOrEqual(112);
    expect(m.searchW, `${who} @${width}: the search never exceeds today's 192 px`).toBeLessThanOrEqual(192);
  }
}

test("desktop header cluster fits 1024-1280: owner with Waitlist and a long name, short name, practitioner", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const seed = await seedE2eStudio({ enableWaitlist: true });
  await sql("update public.practitioners set display_name=$1 where studio_id=$2 and role='owner'", [LONG_NAME, seed.studioId]);
  await loginAsOwner(page, seed);
  // The case the defect needs: the Waitlist link really is in the primary navigation.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/dashboard");
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Waitlist" })).toBeVisible();
  await assertFits(page, "owner, Waitlist, long name");

  await sql("update public.practitioners set display_name='Ann Owner' where studio_id=$1 and role='owner'", [seed.studioId]);
  await assertFits(page, "owner, Waitlist, short name");

  const member = await seedE2eMember(seed);
  await sql("update public.practitioners set display_name=$1 where studio_id=$2 and email=$3", [LONG_NAME, seed.studioId, member.email]);
  const context = await browser.newContext();
  const staff = await context.newPage();
  try {
    await loginByMagicLink(staff, member.email);
    await assertFits(staff, "practitioner, long name");
  } finally {
    await context.close();
  }
});
