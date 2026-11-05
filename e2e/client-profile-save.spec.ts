import { test, expect, type Page } from "@playwright/test";

import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// #1328 + 0281: the three client-save paths in a real browser, at desktop (1280) and phone (390) width.
//   1. profile edit: the change is saved, and the database records the name revision and the audit row (0281 live);
//   2. stale-conflict refusal: a colleague changes the phone after this page loaded; the save is refused, shows what is
//      stored now, and writes nothing;
//   3. legal identity: the legal name saves; and a colleague's change underneath is refused with "Saved now:".
// Synthetic data only, on the owned local stack.

const T = 20_000;
const VIEWPORTS = [
  { label: "desktop 1280", width: 1280, height: 900 },
  { label: "phone 390", width: 390, height: 844 },
] as const;

/** The seed names a client but does not insert one; this creates it (synthetic, with a phone to edit). */
async function clientIdOf(seed: E2eSeed): Promise<string> {
  const rows = await sql<{ id: string }>(
    `insert into public.clients (id, studio_id, name, email, phone)
     values (gen_random_uuid(), $1, $2, $3, '604-555-0111') returning id`,
    [seed.studioId, seed.clientName, seed.clientEmail],
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

async function openEdit(page: Page, seed: E2eSeed): Promise<string> {
  const id = await clientIdOf(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${id}/edit`);
  await expect(page.getByRole("heading", { name: "Edit client" })).toBeVisible({ timeout: T });
  return id;
}

// The emergency contact has its own "Name" and "Phone", so the client's own fields are picked by their exact
// accessible names ("Name*" for the required one) and by DOM order (the client's phone comes first).
const primaryName = (page: Page) => page.getByRole("textbox", { name: "Name*", exact: true });
const primaryPhone = (page: Page) => page.getByRole("textbox", { name: "Phone", exact: true }).first();

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const vp of VIEWPORTS) {
  test.describe(`client save paths, ${vp.label}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("profile edit saves and records the name revision and audit row", async ({ page }) => {
      test.setTimeout(120_000);
      const seed = await seedE2eStudio();
      const id = await openEdit(page, seed);
      await noHorizontalScroll(page);

      await primaryName(page).fill("Synthetic Renamed");
      await primaryPhone(page).fill("604-555-0142");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(new RegExp(`/clients/${id}$`), { timeout: T });

      const [row] = await sql<{ name: string; phone: string; name_revision: number }>(
        `select name, phone, name_revision from public.clients where id = $1`,
        [id],
      );
      expect(row.name).toBe("Synthetic Renamed");
      expect(row.phone).toContain("555-0142");
      expect(row.name_revision).toBe(2);
      const audit = await sql<{ concept: string; revision: number }>(
        `select concept, revision from public.client_identity_audit where client_id = $1 order by revision`,
        [id],
      );
      expect(audit).toEqual([{ concept: "name", revision: 2 }]);
    });

    test("a colleague's change after the page loaded refuses the save and writes nothing", async ({ page }) => {
      test.setTimeout(120_000);
      const seed = await seedE2eStudio();
      const id = await openEdit(page, seed);

      // The colleague saves a phone number while this tab is open.
      await sql(`update public.clients set phone = '604-555-0100' where id = $1`, [id]);

      await primaryPhone(page).fill("604-555-0199");
      await page.getByRole("button", { name: "Save changes" }).click();

      const panel = page.getByTestId("client-save-conflict");
      await expect(panel).toBeVisible({ timeout: T });
      await expect(panel).toContainText("Someone else changed this client after you opened this page");
      await expect(panel).toContainText("555-0100");
      await expect(panel).toContainText("555-0199");
      await noHorizontalScroll(page);

      const [row] = await sql<{ phone: string }>(`select phone from public.clients where id = $1`, [id]);
      expect(row.phone).toContain("555-0100"); // the colleague's value is untouched

      // Keep what is saved now: the field adopts the stored value and the panel closes.
      await panel.getByRole("button", { name: "Keep what is saved now" }).click();
      await expect(panel).toBeHidden({ timeout: T });
      await expect(primaryPhone(page)).toHaveValue(/555-0100/);
    });

    test("legal name saves, and a colleague's change underneath is refused with the saved value", async ({ page }) => {
      test.setTimeout(120_000);
      const seed = await seedE2eStudio();
      const id = await openEdit(page, seed);

      await page.getByLabel("Given name").fill("Dana");
      await page.getByLabel("Family name").fill("Okafor");
      await page.getByRole("button", { name: "Save legal name" }).click();
      await expect
        .poll(
          async () =>
            (
              await sql<{ legal_given_name: string; legal_family_name: string; revision: number }>(
                `select legal_given_name, legal_family_name, revision from public.client_legal_identities where client_id = $1`,
                [id],
              )
            )[0],
          { timeout: T },
        )
        .toMatchObject({ legal_given_name: "Dana", legal_family_name: "Okafor", revision: 1 });
      await expect(page.getByTestId("legal-name-unsaved")).toBeHidden({ timeout: T });

      // A colleague changes the legal family name; this tab still holds the old one.
      await sql(`update public.client_legal_identities set legal_family_name = 'Okonkwo' where client_id = $1`, [id]);
      await page.getByLabel("Family name").fill("Okafor-Smith");
      await page.getByRole("button", { name: "Save legal name" }).click();

      const conflict = page.getByTestId("legal-name-conflict");
      await expect(conflict).toBeVisible({ timeout: T });
      await expect(conflict).toContainText("Saved now:");
      await expect(conflict).toContainText("Okonkwo");
      await noHorizontalScroll(page);

      const [row] = await sql<{ legal_family_name: string }>(
        `select legal_family_name from public.client_legal_identities where client_id = $1`,
        [id],
      );
      expect(row.legal_family_name).toBe("Okonkwo");
    });
  });
}
