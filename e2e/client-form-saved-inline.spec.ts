import { test, expect, type Page } from "@playwright/test";

import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-109 (client-form Save): the edit form shows "Saved." the moment the SERVER has said ok, then soft-navigates to the profile.
//   1. "Saved." is not shown while the save is still in flight, and is shown once the server has answered;
//   2. a rapid double activation sends ONE save;
//   3. a refusal (duplicate email) renders its error and never shows "Saved.", writing nothing.
// The conflict (stale version) and failed paths stay covered by e2e/client-profile-save.spec.ts. Synthetic data, owned local stack.

const T = 20_000;

async function clientOf(seed: E2eSeed): Promise<string> {
  const rows = await sql<{ id: string }>(
    `insert into public.clients (id, studio_id, name, email, phone) values (gen_random_uuid(), $1, $2, $3, '604-555-0111') returning id`,
    [seed.studioId, seed.clientName, seed.clientEmail],
  );
  return rows[0].id;
}

async function openEdit(page: Page, seed: E2eSeed, id: string) {
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${id}/edit`);
  await expect(page.getByRole("heading", { name: "Edit client" })).toBeVisible({ timeout: T });
  await page.waitForLoadState("networkidle");
}

const allergies = (page: Page) => page.locator("main textarea").first(); // the Allergies box is the first textarea on the form

test.describe("client form soft save", () => {
  test("Saved appears only after the server answered, then the profile opens", async ({ page }) => {
    test.setTimeout(120_000);
    const seed = await seedE2eStudio();
    const id = await clientOf(seed);
    await openEdit(page, seed, id);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = 0;
    await page.route(`**/clients/${id}/edit`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      held += 1;
      await gate;
      await route.continue();
    });

    await allergies(page).fill("latex (synthetic)");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(() => held, { timeout: T }).toBe(1);
    await page.waitForTimeout(400);
    await expect(page.getByTestId("client-saved"), "no Saved while the server has not answered").toHaveCount(0);
    await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();

    release();
    await expect(page).toHaveURL(new RegExp(`/clients/${id}$`), { timeout: T });
    const [row] = await sql<{ n: string }>(`select count(*)::text as n from public.clients c where c.id = $1 and to_jsonb(c)::text like '%latex (synthetic)%'`, [id]);
    expect(row.n, "the typed value is in the stored client").toBe("1");
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("a rapid double activation sends exactly one save", async ({ page }) => {
    test.setTimeout(120_000);
    const seed = await seedE2eStudio();
    const id = await clientOf(seed);
    await openEdit(page, seed, id);
    let posts = 0;
    page.on("request", (r) => { if (r.method() === "POST" && r.url().includes(`/clients/${id}/edit`)) posts += 1; });
    await allergies(page).fill("aloe (synthetic)");
    // The label becomes "Saving…" at once, so pin the control by position (the client form's submit is the first on the page), not by its name.
    const save = page.locator("main button[type=submit]").first();
    await save.click({ noWaitAfter: true });
    await save.click({ noWaitAfter: true, force: true, timeout: 2000 }).catch(() => undefined);
    await save.click({ noWaitAfter: true, force: true, timeout: 2000 }).catch(() => undefined);
    await expect(page).toHaveURL(new RegExp(`/clients/${id}$`), { timeout: T });
    expect(posts, "one save request, not two").toBe(1);
  });

  test("a refusal (an email another client already has) shows its error, never Saved, and writes nothing", async ({ page }) => {
    test.setTimeout(120_000);
    const seed = await seedE2eStudio();
    const id = await clientOf(seed);
    await sql(`insert into public.clients (id, studio_id, name, email) values (gen_random_uuid(), $1, 'Synthetic Other', 'other.synthetic@example.test')`, [seed.studioId]);
    await openEdit(page, seed, id);
    await page.locator("main input[type=email]").first().fill("other.synthetic@example.test");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: T });
    await expect(page.getByTestId("client-saved")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/clients/${id}/edit$`));
    const [row] = await sql<{ email: string | null }>(`select email from public.clients where id = $1`, [id]);
    expect(row.email).not.toBe("other.synthetic@example.test");
  });

  // P3-b: the inline path no longer revalidates, so prove the router does not hand back a STALE edit form after Back: the form shows the value just
  // saved, and saving the SAME field again succeeds with no false version conflict and stores the second value.
  test("save, Back to the edit page, change the same field, save again: no false conflict, second value stored", async ({ page }) => {
    test.setTimeout(120_000);
    const seed = await seedE2eStudio();
    const id = await clientOf(seed);
    await openEdit(page, seed, id);
    const first = `first synthetic ${Date.now()}`;
    const second = `second synthetic ${Date.now()}`;
    await allergies(page).fill(first);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/${id}$`), { timeout: T });
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: T });

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/clients/${id}/edit$`), { timeout: T });
    await expect(page.getByRole("heading", { name: "Edit client" })).toBeVisible({ timeout: T });
    await page.waitForLoadState("networkidle");
    await expect(allergies(page), "Back must not restore the form as it was BEFORE the first save").toHaveValue(first, { timeout: T });

    await allergies(page).fill(second);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/${id}$`), { timeout: T });
    // (The page always carries one EMPTY role=alert, the route announcer; a conflict or failure would put TEXT on the page.)
    await expect(page.getByText(/changed by someone else|Couldn't save|could not save|try again/i)).toHaveCount(0);
    const [row] = await sql<{ n: string; stale: string }>(
      `select count(*) filter (where to_jsonb(c)::text like '%' || $2 || '%')::text as n, count(*) filter (where to_jsonb(c)::text like '%' || $3 || '%')::text as stale from public.clients c where c.id = $1`,
      [id, second, first],
    );
    expect(row.n, "the second value is stored").toBe("1");
    expect(row.stale, "and replaced the first").toBe("0");
  });

  // P3-c: no revalidatePath on the inline path, so a renamed client must still appear in the directory on the next visit (soft navigation, no reload).
  test("after an inline save the clients list shows the new name on the next visit", async ({ page }) => {
    test.setTimeout(120_000);
    const seed = await seedE2eStudio();
    const id = await clientOf(seed);
    await openEdit(page, seed, id);
    // Warm the directory in the router first, so a stale cached copy would be the thing that fails this test.
    await page.goto("/clients");
    await expect(page.getByText(seed.clientName).first()).toBeVisible({ timeout: T });
    await page.goto(`/clients/${id}/edit`);
    await page.waitForLoadState("networkidle");
    const renamed = `Renamed Synthetic ${Date.now() % 100000}`;
    await page.getByRole("textbox", { name: "Name*", exact: true }).fill(renamed);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/${id}$`), { timeout: T });
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: T });
    // Soft navigation to the directory (no document load).
    await page.locator('a[href="/clients"]').first().click();
    await expect(page).toHaveURL(/\/clients(\?.*)?$/, { timeout: T });
    await expect(page.getByText(renamed).first()).toBeVisible({ timeout: T });
    await expect(page.getByText(seed.clientName), "the old name is gone from the list").toHaveCount(0);
  });
});
