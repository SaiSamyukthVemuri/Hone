import { test, expect } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-124 item 19. A settings save the server refuses explains the next step, keeps what was typed, and never shows raw error text. This
// runs against the PRODUCTION build (the lane's webServer), where Next would redact a THROWN message to "An error occurred in the Server
// Components render...": the postcare action now RETURNS its sentence. At 390x844, keyboard-driven. Synthetic fixture studio only.
// ("ftp://..." and "a@b" are accepted by the browser's own url/email validation but refused by the server, so the request really goes out.)

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;
const RAW = /omitted in production|Server Components render|Failed to update|42501|PGRST|duplicate key/i;

test("postcare: a refused review link and contact email explain the fix, keep the typed values, then save once corrected", async ({ page }) => {
  const seed = await seedE2eStudio();
  await loginAsOwner(page, seed);
  await page.goto("/settings/forms/postcare");
  const link = page.getByLabel("Review link (optional)");
  const email = page.getByLabel("Postcare contact email");
  await expect(link).toBeVisible({ timeout: T });
  const save = page.getByRole("button", { name: "Save postcare settings" });

  await link.fill("ftp://example.com/review");
  await link.focus();
  await page.keyboard.press("Enter"); // submit from the keyboard
  const alert = page.getByRole("alert").filter({ hasText: "https://" });
  await expect(alert).toBeVisible({ timeout: T });
  await expect(alert).toContainText("clear the field"); // names the next action
  expect(await alert.innerText()).not.toMatch(RAW);
  await expect(link).toHaveValue("ftp://example.com/review"); // typed value kept
  expect((await sql<{ postcare_review_url: string | null }>(`select postcare_review_url from public.studios where id=$1`, [seed.studioId]))[0]!.postcare_review_url).toBeNull();

  await link.fill("https://example.com/review");
  await email.fill("a@b");
  await save.click();
  const mailAlert = page.getByRole("alert").filter({ hasText: "name@example.com" });
  await expect(mailAlert).toBeVisible({ timeout: T });
  expect(await mailAlert.innerText()).not.toMatch(RAW);
  await expect(link).toHaveValue("https://example.com/review");
  await expect(email).toHaveValue("a@b");

  await email.fill("front@example.com");
  await save.click();
  await expect.poll(async () => (await sql<{ postcare_review_url: string | null }>(`select postcare_review_url from public.studios where id=$1`, [seed.studioId]))[0]!.postcare_review_url, { timeout: T }).toBe("https://example.com/review");
  await expect(page.getByRole("alert").filter({ hasText: /https:\/\/|name@example\.com|did not go through|Could not/ })).toHaveCount(0); // no error left on screen
});
