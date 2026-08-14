import { test, expect } from "@playwright/test";
import { seedE2eStudio, getStudioWeeklyDefaults, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// PR B: availability-save COMPATIBILITY contract. Proves the real
// saveWeeklyDefaultsAction still persists studio-wide weekly hours through
// PostgREST AFTER migration 0135 (which re-keyed uniqueness to a
// UNIQUE NULLS NOT DISTINCT (studio_id, day_of_week, practitioner_id)). The
// regression this guards against: the action's `onConflict` no longer matched
// any constraint (42P10), silently breaking the flag-OFF owner save. The second
// preset apply is the load-bearing case, it exercises the ON CONFLICT DO
// UPDATE path against an existing row.
//
// SAFETY: a fresh synthetic studio on the LOCAL stack, flag OFF. Never Willow.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;

function weekdayHours(
  rows: Awaited<ReturnType<typeof getStudioWeeklyDefaults>>,
) {
  // Weekdays Mon–Fri (day_of_week 1..5), studio-wide rows only.
  return rows
    .filter((r) => r.practitioner_id === null && r.day_of_week >= 1 && r.day_of_week <= 5 && r.is_open)
    .map((r) => `${String(r.open_time).slice(0, 5)}-${String(r.close_time).slice(0, 5)}`);
}

test("flag-OFF owner can save AND update weekly studio hours (0135 upsert compatibility)", async ({
  page,
}) => {
  expect(E2E_APP_ORIGIN).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);
  seed = await seedE2eStudio(); // practitioner_capacity_enabled defaults false

  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  await expect(page.getByRole("heading", { name: /availability/i })).toBeVisible();

  // 1) First save (INSERT path): apply the "Weekdays 9–5" preset and confirm.
  await page.getByRole("button", { name: /Weekdays 9/ }).click();
  await page.getByRole("button", { name: /^Replace$/ }).click();
  await expect
    .poll(async () => weekdayHours(await getStudioWeeklyDefaults(seed.studioId)).sort())
    .toEqual(["09:00-17:00", "09:00-17:00", "09:00-17:00", "09:00-17:00", "09:00-17:00"]);

  // Studio-wide rows carry a NULL practitioner_id (no per-practitioner rows on OFF).
  const afterFirst = await getStudioWeeklyDefaults(seed.studioId);
  expect(afterFirst.every((r) => r.practitioner_id === null)).toBe(true);

  // 2) Second save (ON CONFLICT DO UPDATE path, the regression case): switch to
  //    "Weekdays 10–6". If the upsert conflict target were broken, this would
  //    42P10 and the hours would NOT change.
  await page.getByRole("button", { name: /Weekdays 10/ }).click();
  await page.getByRole("button", { name: /^Replace$/ }).click();
  await expect
    .poll(async () => weekdayHours(await getStudioWeeklyDefaults(seed.studioId)).sort())
    .toEqual(["10:00-18:00", "10:00-18:00", "10:00-18:00", "10:00-18:00", "10:00-18:00"]);

  // Still exactly the studio-wide rows, the update did not duplicate.
  const afterSecond = await getStudioWeeklyDefaults(seed.studioId);
  expect(afterSecond.filter((r) => r.practitioner_id === null).length).toBe(
    afterSecond.length,
  );
});
