import { test, expect } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-124 item 4. A plain submit button used to give no sign of work and could be pressed twice. The availability "Remove" (blockout) now goes
// through PendingButton: at 390x844, with the server action held open, the control shows aria-busy and is disabled (the double-submit guard),
// a second activation by KEYBOARD does not send a second request, and the row goes once the action settles. Synthetic fixture studio only.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const T = 20_000;

test("availability: Remove a blockout shows activity, ignores a second press, and removes it once", async ({ page }) => {
  const seed = await seedE2eStudio();
  await sql(`insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason) values ($1, current_date + 40, current_date + 41, 'pending-state spec')`, [seed.studioId]);
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const row = page.locator("li", { hasText: "pending-state spec" });
  const remove = row.getByRole("button", { name: /^Remove/ });
  await expect(remove).toBeVisible({ timeout: T });
  const box = (await remove.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(43.5); // the touch floor, as the shared Button primitive guarantees

  let posts = 0;
  await page.route(
    (u) => u.pathname === "/settings/availability",
    async (route, request) => {
      if (request.method() === "POST") {
        posts += 1;
        await new Promise((r) => setTimeout(r, 2500));
      }
      await route.continue();
    },
  );
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(remove).toHaveAttribute("aria-busy", "true", { timeout: T });
  await expect(remove).toBeDisabled();
  await page.keyboard.press("Enter"); // a second activation while busy
  await page.keyboard.press("Space");
  await expect(page.locator("li", { hasText: "pending-state spec" })).toHaveCount(0, { timeout: 30_000 });
  expect(posts).toBe(1);
  expect((await sql(`select 1 from public.studio_blockouts where studio_id=$1`, [seed.studioId])).length).toBe(0);
});

test("reduced motion: while Remove is busy the spinner does not animate", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const seed = await seedE2eStudio();
  await sql(`insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason) values ($1, current_date + 50, current_date + 51, 'reduced-motion spec')`, [seed.studioId]);
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const remove = page.locator("li", { hasText: "reduced-motion spec" }).getByRole("button", { name: /^Remove/ });
  await expect(remove).toBeVisible({ timeout: T });
  await page.route(
    (u) => u.pathname === "/settings/availability",
    async (route, request) => {
      if (request.method() === "POST") await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    },
  );
  await remove.click();
  await expect(remove).toHaveAttribute("aria-busy", "true", { timeout: T });
  // the busy control has a spinner, and its computed animation is none under prefers-reduced-motion
  const anim = await remove.evaluate((el) => {
    const ring = Array.from(el.querySelectorAll("span, svg, div")).find((n) => /animate-spin/.test((n as HTMLElement).className?.toString() ?? ""));
    return ring ? getComputedStyle(ring as HTMLElement).animationName : "no-spinner";
  });
  expect(anim).toBe("none");
  await expect(page.locator("li", { hasText: "reduced-motion spec" })).toHaveCount(0, { timeout: 30_000 });
});
