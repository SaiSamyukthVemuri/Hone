import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// The counterpart of client-groups.spec.ts. That spec needs the client-groups tables and skips when
// they are absent. This one needs them ABSENT and skips when they are present. Between them the
// client pages are covered on a database with the tables and on one without them (the state of a
// deployment that has not applied the tables yet). The spec never installs or removes schema.
const UNAVAILABLE = "Client groups are unavailable. Reload to try again.";

// Every response the page itself triggered, plus uncaught page errors. A 5xx or a thrown error on
// any request of the visit fails the test, not only a wrong status on the final document.
function watch(page: Page) {
  const serverErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 500) serverErrors.push(`${res.status()} ${new URL(res.url()).pathname}`);
  });
  page.on("pageerror", (err) => pageErrors.push(err.name));
  return { serverErrors, pageErrors };
}

async function visit(page: Page, path: string) {
  const res = await page.goto(path);
  expect(res?.status(), `${path} answers 200`).toBe(200);
}

test("client pages work without the client-groups tables: owner sees 'unavailable', staff sees no group UI", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const schema = await sql<{ present: boolean }>(
    "select to_regclass('public.client_groups') is not null or to_regclass('public.client_group_memberships') is not null as present",
  );
  test.skip(schema[0]?.present, "The client-groups tables are installed on this stack; the unavailable fallback can only be proved where they are absent.");

  const seed = await seedE2eStudio();
  await sql("insert into public.clients(studio_id,name) select $1,'Absent '||lpad(n::text,2,'0') from generate_series(1,3) n", [seed.studioId]);
  const clients = await sql<{ id: string }>("select id from public.clients where studio_id=$1 and name like 'Absent %' order by name", [seed.studioId]);
  expect(clients).toHaveLength(3);

  const seen = watch(page);
  await loginAsOwner(page, seed);

  // The directory lists the clients, and the group control says it is unavailable.
  await visit(page, "/clients");
  for (const name of ["Absent 01", "Absent 02", "Absent 03"]) await expect(page.getByText(name).first()).toBeVisible();
  await expect(page.getByText(UNAVAILABLE).first()).toBeVisible();

  // A group id that does not exist: the directory answers safely, with no crash.
  await visit(page, `/clients?group=${randomUUID()}`);
  await expect(page.getByRole("alert").filter({ hasText: "We couldn't apply that client group" })).toBeVisible();
  await page.getByRole("link", { name: "remove the group filter" }).click();
  await expect(page).not.toHaveURL(/group=/);
  await expect(page.getByText("Absent 01").first()).toBeVisible();

  // The profile renders, and its Client groups card says unavailable.
  await visit(page, `/clients/${clients[0].id}`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Client groups", exact: true }) });
  await expect(card.getByText(UNAVAILABLE)).toBeVisible();
  await expect(card.getByRole("button", { name: "Add group", exact: true })).toHaveCount(0);

  // The groups page says so, and points back to the directory.
  await visit(page, "/clients/groups");
  await expect(page.getByRole("status").filter({ hasText: "Your clients are still available in the directory." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create group", exact: true })).toHaveCount(0);

  // A practitioner who is not the owner: the pages render and no group control exists at all.
  const member = await seedE2eMember(seed);
  const context = await browser.newContext();
  const staff = await context.newPage();
  const staffSeen = watch(staff);
  try {
    await loginByMagicLink(staff, member.email);
    await visit(staff, "/clients");
    await expect(staff.getByText("Absent 01").first()).toBeVisible();
    await expect(staff.getByRole("combobox", { name: "Client group", exact: true })).toHaveCount(0);
    await expect(staff.getByText(UNAVAILABLE)).toHaveCount(0);
    await visit(staff, `/clients/${clients[0].id}`);
    await expect(staff.getByRole("heading", { name: "Client groups", exact: true })).toHaveCount(0);
    await expect(staff.getByText(UNAVAILABLE)).toHaveCount(0);
  } finally {
    await context.close();
  }

  expect(seen.serverErrors, "no 5xx on any owner request").toEqual([]);
  expect(seen.pageErrors, "no uncaught page error for the owner").toEqual([]);
  expect(staffSeen.serverErrors, "no 5xx on any staff request").toEqual([]);
  expect(staffSeen.pageErrors, "no uncaught page error for staff").toEqual([]);
});
