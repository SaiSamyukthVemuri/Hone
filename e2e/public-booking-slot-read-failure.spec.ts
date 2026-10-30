import { test, expect } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";

// SCH-002. A slot-loader READ failure on the public booking page must read as a
// failure, never as "No availability". The server side is real: the studio's
// slug carries the fault marker (lib/booking/e2e-slot-read-fault.ts), so
// fetchPublicSlotsAction raises the same availability_read_failed error a broken
// read does and returns its sanitized refusal. A control studio on the same
// server shows slots, so the failure copy is caused by the fault, not the page.

const T = 60_000;

async function reachSlots(page: import("@playwright/test").Page, slug: string) {
  await page.goto(`/book/${slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await expect(page.locator("select").first()).toBeVisible({ timeout: T });
}

test("a failed slot read shows a could-not-load state, never No availability", async ({ page }) => {
  const seed = await seedE2eStudio();
  const faultSlug = `e2e-slot-fault-${seed.runId}`;
  await sql(`update public.studios set slug = $1 where id = $2`, [faultSlug, seed.studioId]);

  await reachSlots(page, faultSlug);

  const failed = page.getByTestId("slots-load-failed");
  await expect(failed).toBeVisible({ timeout: T });
  await expect(failed).toContainText(/could not be loaded/i);
  await expect(page.getByText(/No availability on/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /next available/i })).toHaveCount(0);

  // Try again re-runs the read; the fault is deterministic, so it fails again
  // and the state stays honest rather than collapsing to an empty day.
  await failed.getByRole("button", { name: /try again/i }).click();
  await expect(failed).toBeVisible({ timeout: T });
  await expect(page.getByText(/No availability on/i)).toHaveCount(0);
});

test("control: an unmarked studio on the same server loads times", async ({ page }) => {
  const seed = await seedE2eStudio();
  await reachSlots(page, seed.slug);
  await expect(page.getByTestId("slots-load-failed")).toHaveCount(0);
  await expect(page.getByText(/Available times for/i)).toBeVisible({ timeout: T });
  await expect(page.getByText(/Loading slots/i)).toHaveCount(0, { timeout: T });
});
