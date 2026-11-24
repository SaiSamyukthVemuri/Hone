import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// Custom client groups were removed, and their tables were never applied. This spec proves the standard directory
// works on a database WITHOUT those tables, for an owner and for a practitioner, and that no group control, link,
// warning or old route survives. It never installs or removes schema.
const GONE = [/Client groups?/i, /Manage groups/i, /All groups/i, /Reload to try again/i, /Groups unavailable/i];

async function noGroupUi(page: Page, who: string) {
  const body = page.locator("body");
  for (const text of GONE) await expect(body.getByText(text), `${who}: ${text}`).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /group/i }), `${who}: no group select`).toHaveCount(0);
  await expect(page.locator('a[href^="/clients/groups"]'), `${who}: no group link`).toHaveCount(0);
}

async function standardDirectory(page: Page, who: string) {
  const serverErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("response", (res) => { if (res.status() >= 500) serverErrors.push(`${res.status()} ${new URL(res.url()).pathname}`); });
  page.on("pageerror", (err) => pageErrors.push(err.name));

  expect((await page.goto("/clients"))?.status(), `${who}: /clients`).toBe(200);
  for (const n of ["Gx 01", "Gx 02", "Gx 03"]) await expect(page.getByText(n).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Active clients" })).toHaveAttribute("aria-current", "page");
  await noGroupUi(page, who);

  // Search
  const search = page.getByRole("searchbox", { name: "Search clients" });
  await search.fill("Gx 02");
  await search.press("Enter");
  await expect(page).toHaveURL(/[?&]q=Gx(\+|%20)02/);
  await expect(page.getByText("Gx 02").first()).toBeVisible();
  await expect(page.getByText("Gx 01")).toHaveCount(0);
  await noGroupUi(page, who);

  // Standard filter and sort, then clear
  // The quick-filter checkbox is visually hidden inside its label.
  await page.locator("label", { has: page.getByRole("checkbox", { name: "No upcoming appointment" }) }).click();
  await expect(page.getByRole("checkbox", { name: "No upcoming appointment" })).toBeChecked();
  await expect(page).toHaveURL(/filter=no_upcoming/);
  await page.getByRole("combobox", { name: "Sort by" }).selectOption("next");
  await expect(page).toHaveURL(/sort=next/);
  await page.getByRole("search").getByRole("link", { name: "Clear search and filters" }).click();
  await expect(page).not.toHaveURL(/[?&](q|filter|sort)=/);
  await expect(page.getByText("Gx 01").first()).toBeVisible();

  // Archived view
  await page.getByRole("link", { name: "Archived clients" }).click();
  await expect(page).toHaveURL(/view=archived/);
  await expect(page.getByRole("link", { name: "Archived clients" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Gx Archived").first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Sort by" }).getByRole("option")).toHaveText(["Recently archived", "Name A–Z"]);
  await expect(page.getByRole("combobox", { name: "Last visit" })).toHaveCount(0);
  await noGroupUi(page, who);

  // Old links land on the standard directory (a group parameter keeps only the standard ones)
  await page.goto("/clients/groups");
  await expect(page).toHaveURL(/\/clients$/);
  await page.goto("/clients?group=3f2c0000-0000-4000-8000-000000000000&q=Gx");
  await expect(page).toHaveURL(/\/clients\?q=Gx$/);
  await expect(page.getByText("Gx 01").first()).toBeVisible();
  await noGroupUi(page, who);

  // A client profile has no groups card
  await page.goto("/clients");
  await page.getByRole("link", { name: /^Open Gx 01|Gx 01/ }).first().click();
  await noGroupUi(page, who);

  expect(serverErrors, `${who}: no 5xx`).toEqual([]);
  expect(pageErrors, `${who}: no uncaught page error`).toEqual([]);
}

for (const view of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test.describe(view.name, () => {
    test.use({ viewport: { width: view.width, height: view.height } });
  test("the standard client directory works without client groups, for an owner and a practitioner", async ({ page, browser }) => {
    test.setTimeout(240_000);
    const schema = await sql<{ present: boolean }>(
      "select to_regclass('public.client_groups') is not null or to_regclass('public.client_group_memberships') is not null as present",
    );
    test.skip(schema[0]?.present, "A client-groups table exists on this stack; this spec proves the directory on a database without them.");

    const seed = await seedE2eStudio();
    await sql("insert into public.clients(studio_id,name) select $1,'Gx '||lpad(n::text,2,'0') from generate_series(1,3) n", [seed.studioId]);
    await sql("insert into public.clients(studio_id,name,archived_at) values ($1,'Gx Archived',now())", [seed.studioId]);

    await loginAsOwner(page, seed);
    await standardDirectory(page, "owner");

    const member = await seedE2eMember(seed);
    const context = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const staff = await context.newPage();
    try {
      await loginByMagicLink(staff, member.email);
      await standardDirectory(staff, "practitioner");
    } finally {
      await context.close();
    }
  });
  });
}
