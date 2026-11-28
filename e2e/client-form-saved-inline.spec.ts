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
});
