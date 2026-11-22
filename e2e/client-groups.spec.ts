import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// Qualification on an owned disposable local stack with the reviewed proposal
// already applied by its operator. This spec never installs schema. Ordinary CI
// on the old DB records an explicit skip, not a passing workflow claim.
test("custom client groups: catalogue, memberships, directory, archive and role boundary", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const schema = await sql<{ ready: boolean }>("select to_regclass('public.client_groups') is not null and to_regclass('public.client_group_memberships') is not null as ready");
  test.skip(!schema[0]?.ready, "Client groups proposal is not installed on this owned local stack; run proposal DB qualification first.");
  const seed = await seedE2eStudio();
  await sql("insert into public.clients(studio_id,name) select $1,'Grouped '||lpad(n::text,2,'0') from generate_series(1,30) n", [seed.studioId]);
  const clients = await sql<{ id: string }>("select id from public.clients where studio_id=$1 order by name", [seed.studioId]);
  await loginAsOwner(page, seed);
  await page.goto("/clients/groups");
  await page.getByLabel("New group name").fill("Follow up");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(page.getByText("Group created.", { exact: true })).toBeVisible();
  await page.getByLabel("New group name").fill("Paused");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(page.getByLabel("Group name: Paused", { exact: true })).toBeVisible();
  const rename = page.locator("form").filter({ has: page.getByLabel("Group name: Follow up", { exact: true }) });
  await rename.getByRole("textbox").fill("Review"); await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByLabel("Group name: Review", { exact: true })).toBeVisible();
  await page.goto(`/clients/${clients[0].id}`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Client groups", exact: true }) });
  for (const name of ["Review", "Paused"]) {
    await card.getByLabel("Add to group").selectOption({ label: name }); await card.getByRole("button", { name: "Add group", exact: true }).click();
    await expect(card.getByRole("button", { name: `Remove ${name}`, exact: true })).toBeVisible();
  }
  const [group] = await sql<{ id: string }>("select id from public.client_groups where studio_id=$1 and name='Review'", [seed.studioId]);
  // Exact-id synthetic memberships exercise real filtering/pagination beyond one page.
  await sql("insert into public.client_group_memberships(studio_id,client_id,group_id) select $1,id,$2 from public.clients where studio_id=$1 on conflict do nothing", [seed.studioId,group.id]);
  await page.goto(`/clients?group=${group.id}`);
  await page.getByRole("searchbox", { name: "Search clients" }).fill("Grouped");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("30 matches · showing 1–25", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Next", exact: true }).click();
  await expect(page.getByText("30 matches · showing 26–30", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("group")).toBe(group.id);
  await sql("update public.clients set archived_at=now() where id=$1 and studio_id=$2", [clients[0].id,seed.studioId]);
  await page.goto(`/clients?view=archived&group=${group.id}`);
  await expect(page.getByText("1 match · showing 1–1", { exact: true })).toBeVisible();
  await sql("update public.clients set archived_at=null where id=$1 and studio_id=$2", [clients[0].id,seed.studioId]);
  await page.goto(`/clients/${clients[0].id}`);
  await expect(card.getByRole("button", { name: "Remove Paused", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Remove Paused", exact: true }).click();
  await expect(card.getByRole("button", { name: "Remove Paused", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Remove Review", exact: true })).toBeVisible();
  const member = await seedE2eMember(seed);
  const context = await browser.newContext(); const staff = await context.newPage();
  try {
    await loginByMagicLink(staff, member.email); await staff.goto("/clients");
    await expect(staff.getByRole("combobox", { name: "Client group", exact: true })).toHaveCount(0);
    await staff.goto(`/clients/${clients[0].id}`);
    await expect(staff.getByRole("heading", { name: "Client groups", exact: true })).toHaveCount(0);
    await staff.goto("/clients/groups"); await expect(staff.getByRole("button", { name: "Create group", exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});
