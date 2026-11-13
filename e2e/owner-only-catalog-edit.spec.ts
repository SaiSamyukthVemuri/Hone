import { test, expect } from "@playwright/test";
import { getE2eServiceId, seedE2eMember, seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// 0339 (HON-44 H1/H2): services and consent wording are owner-only in the database as well as in the app.
// Real browser, real local stack, DB rows as ground truth: the owner's edits still land through the shipped
// actions, and a non-owner practitioner is shown no edit control on either settings page.

const T = 20_000;

let seed: E2eSeed;
let serviceId: string;
let templateId: string;

test.beforeEach(async () => {
  seed = await seedE2eStudio();
  serviceId = await getE2eServiceId(seed.studioId);
  const rows = await sql<{ id: string }>(
    `insert into public.consent_form_templates (studio_id, title, body, form_type, status, is_live)
     values ($1, 'E2E Consent', 'Original wording', 'general', 'draft', false) returning id`,
    [seed.studioId],
  );
  templateId = rows[0]!.id;
});

test("the owner edits a service and consent wording, and both are stored", async ({ page }) => {
  await loginAsOwner(page, seed);

  await test.step("service", async () => {
    await page.goto("/settings/services");
    await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible({ timeout: T });
    await page.getByTestId(`service-row-${serviceId}`).locator("button[aria-expanded]").first().click();
    const form = page.getByRole("form", { name: `Edit ${seed.serviceName}` });
    await form.locator('input[name="name"]').fill("Owner Renamed Service");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(async () => (await sql<{ name: string }>(`select name from public.services where id = $1`, [serviceId]))[0]?.name, { timeout: T })
      .toBe("Owner Renamed Service");
  });

  await test.step("consent wording", async () => {
    await page.goto("/settings/consent");
    await expect(page.getByText("E2E Consent")).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByPlaceholder("Paste the full consent text.", { exact: false }).fill("Owner changed wording");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(async () => (await sql<{ body: string }>(`select body from public.consent_form_templates where id = $1`, [templateId]))[0]?.body, { timeout: T })
      .toBe("Owner changed wording");
  });
});

test("a non-owner practitioner has no edit controls for services or consent wording", async ({ page }) => {
  const member = await seedE2eMember(seed);
  await loginByMagicLink(page, member.email);

  await page.goto("/settings/services");
  await expect(page.getByText("Only studio owners can manage services.")).toBeVisible({ timeout: T });
  await expect(page.locator('[data-testid^="service-row-"]')).toHaveCount(0);
  await expect(page.locator('form[aria-label^="Edit "]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /save changes|add service/i })).toHaveCount(0);

  await page.goto("/settings/consent");
  await expect(page.getByText("Only studio owners can manage consent forms.")).toBeVisible({ timeout: T });
  await expect(page.getByText("E2E Consent")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^edit$|new consent form|make live|make active|archive|save changes/i })).toHaveCount(0);

  // Nothing changed underneath.
  expect((await sql<{ name: string }>(`select name from public.services where id = $1`, [serviceId]))[0]?.name).toBe(seed.serviceName);
  expect((await sql<{ body: string }>(`select body from public.consent_form_templates where id = $1`, [templateId]))[0]?.body).toBe("Original wording");
});
