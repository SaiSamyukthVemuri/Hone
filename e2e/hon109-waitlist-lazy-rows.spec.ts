import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-109 (option e): a Waitlist row's body is hydrated only when the row is reached (components/waitlist/lazy-details.tsx). The cost of that choice
// is the person who gets there WITHOUT a mouse, or who presses in the same breath as the hover. Both must still do exactly what the row says, once.
// Each case records one availability on its own synthetic entry and asserts the SERVER effect (one stored preference) and that the page made exactly
// one POST to /waitlist for it: no lost press, no double submit. Runs on Chromium in CI. WebKit (the engine behind Safari) is local evidence only,
// run with an untracked config that adds a webkit project; the command is in the PR text.

const T = 30_000;

async function ownerUserId(seed: E2eSeed) {
  const r = await sql<{ user_id: string }>(`select user_id from public.practitioners where studio_id = $1 and role = 'owner' and user_id is not null limit 1`, [seed.studioId]);
  return r[0]!.user_id;
}

async function seedWaiting(seed: E2eSeed, count: number) {
  const owner = await ownerUserId(seed);
  await sql(`select * from public.open_new_client_waitlist_admission_round($1,$2,50)`, [seed.studioId, owner]);
  const ids: { id: string; name: string }[] = [];
  for (let i = 0; i < count; i++) {
    const name = `Lazy Row ${i} ${seed.runId}`;
    await sql(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [seed.studioId, owner, name, `lazy-${i}-${seed.runId}@harness.local`]);
    const r = await sql<{ id: string }>(`select id from public.new_client_waitlist_entries where studio_id = $1 and name = $2`, [seed.studioId, name]);
    ids.push({ id: r[0]!.id, name });
  }
  return ids;
}

async function stored(entryId: string): Promise<number> {
  const r = await sql<{ n: number }>(`select count(*)::int n from public.new_client_waitlist_entry_preferences where entry_id = $1`, [entryId]);
  return r[0]!.n;
}

function countPosts(page: Page) {
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/waitlist")) posts.push(r.url()); });
  return posts;
}

const hydrated = (page: Page, entryId: string) =>
  page.evaluate((id) => {
    const e = document.querySelector(`li[data-entry-id="${id}"] select[name="preference"]`);
    return !!e && Object.keys(e).some((k) => k.startsWith("__reactProps"));
  }, entryId);

async function activeIs(page: Page, selector: string) {
  return page.evaluate((s) => !!document.activeElement && document.activeElement.matches(s), selector);
}

test.describe("HON-109 Waitlist rows that hydrate when reached", () => {
  test("keyboard: Tab to a row, Enter opens it, Tab into the form, Enter records exactly once", async ({ page }) => {
    test.setTimeout(120_000);
    const seed = await seedE2eStudio();
    const entries = await seedWaiting(seed, 4);
    const target = entries[2]!;
    await loginAsOwner(page, seed);
    await page.goto("/waitlist");
    const posts = countPosts(page);
    const row = `li[data-entry-id="${target.id}"]`;
    await expect(page.locator(row)).toBeVisible({ timeout: T });
    expect(await hydrated(page, target.id), "the row body has not been hydrated before anyone reaches it").toBe(false);
    expect(await stored(target.id)).toBe(0);

    // Tab (a real key press) from the previous row's summary until the target row's summary has focus.
    await page.locator(`li[data-entry-id="${entries[1]!.id}"] summary`).first().focus();
    let tabs = 0;
    while (!(await activeIs(page, `${row} summary`)) && tabs < 8) { await page.keyboard.press("Tab"); tabs++; }
    expect(await activeIs(page, `${row} summary`), `Tab reached the row summary (${tabs} presses)`).toBe(true);

    await page.keyboard.press("Enter");
    await expect(page.locator(`${row} details`).first()).toHaveAttribute("open", "", { timeout: T });
    // Tab into the form: the availability select is the next control on the row.
    tabs = 0;
    while (!(await activeIs(page, `${row} select[name="preference"]`)) && tabs < 10) { await page.keyboard.press("Tab"); tabs++; }
    expect(await activeIs(page, `${row} select[name="preference"]`), `Tab reached the availability select (${tabs} presses)`).toBe(true);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(`${row} select[name="preference"]`)).not.toHaveValue("");
    await page.keyboard.press("Tab");
    expect(await activeIs(page, `${row} button[type="submit"]`), "Tab reached the Record button").toBe(true);
    await page.keyboard.press("Enter");

    await expect.poll(() => stored(target.id), { timeout: T }).toBe(1);
    await page.waitForTimeout(2000);
    expect(await stored(target.id), "exactly one stored preference").toBe(1);
    expect(posts.length, "exactly one POST to /waitlist").toBe(1);
  });

  test("pointer: hover and press in the same breath records exactly once", async ({ page }) => {
    test.setTimeout(120_000);
    const seed = await seedE2eStudio();
    const entries = await seedWaiting(seed, 4);
    const target = entries[3]!;
    await loginAsOwner(page, seed);
    await page.goto("/waitlist");
    const posts = countPosts(page);
    const row = `li[data-entry-id="${target.id}"]`;
    await expect(page.locator(row)).toBeVisible({ timeout: T });
    expect(await stored(target.id)).toBe(0);

    const summary = page.locator(`${row} summary`).first();
    await summary.scrollIntoViewIfNeeded();
    const box = (await summary.boundingBox())!;
    // A real pointer: move onto the summary, then press immediately, then press Record immediately.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.up();
    const select = page.locator(`${row} select[name="preference"]`);
    await expect(select).toBeVisible({ timeout: T });
    await select.selectOption({ index: 1 });
    await page.locator(`${row} button[type="submit"]`).first().click();

    await expect.poll(() => stored(target.id), { timeout: T }).toBe(1);
    await page.waitForTimeout(2000);
    expect(await stored(target.id), "exactly one stored preference").toBe(1);
    expect(posts.length, "exactly one POST to /waitlist").toBe(1);
  });
});
