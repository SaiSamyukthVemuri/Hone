import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, getStudioWeeklyDefaults, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// HON-62 — the weekly-hours "Opens"/"Closes" fields on Settings >
// Availability (the onboarding "Configure availability" step lands here) were
// a custom button-and-list picker: no typing, a 256px nested scroller that
// opened at 6:00 AM, and no way to choose a time outside 06:00–22:00. They are
// now native <input type="time">. This spec is the mounted half of the
// regression proof; tests/app/settings/availability-hours-editor.test.ts is
// the unit half.
//
// What this spec cannot prove: on a touch device the native control opens
// the OS wheel picker, which is not in the DOM and which Playwright cannot
// scroll. The touch case below proves the input takes a tap and focus with
// nothing intercepting it; real-device acceptance on iPad Safari is manual.
//
// SAFETY: a fresh synthetic studio on the LOCAL stack, flag OFF.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;

type Row = Awaited<ReturnType<typeof getStudioWeeklyDefaults>>[number];

function hours(rows: Row[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const r of rows) {
    if (r.practitioner_id !== null) continue;
    out[r.day_of_week] = r.is_open
      ? `${String(r.open_time).slice(0, 5)}-${String(r.close_time).slice(0, 5)}`
      : "closed";
  }
  return out;
}

async function openDay(page: Page, day: string) {
  await page.getByRole("button", { name: `Edit ${day}` }).click();
  await expect(page.getByLabel(`${day} opens`)).toBeVisible();
}

test.beforeAll(async () => {
  expect(E2E_APP_ORIGIN).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);
  seed = await seedE2eStudio();
});

test("an owner types Monday's hours with the keyboard, saves, and they survive a reload", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  await openDay(page, "Monday");

  const opens = page.getByLabel("Monday opens");
  const closes = page.getByLabel("Monday closes");
  await expect(opens).toHaveAttribute("type", "time");

  // Keyboard only: focus the field and type into its segments (en-US hh mm
  // AM/PM in both Chromium and WebKit).
  await opens.focus();
  await page.keyboard.type("0830AM");
  await closes.focus();
  await page.keyboard.type("0445PM");
  await expect(opens).toHaveValue("08:30");
  await expect(closes).toHaveValue("16:45");

  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect
    .poll(async () => hours(await getStudioWeeklyDefaults(seed.studioId))[1])
    .toBe("08:30-16:45");

  await page.reload();
  await openDay(page, "Monday");
  await expect(page.getByLabel("Monday opens")).toHaveValue("08:30");
  await expect(page.getByLabel("Monday closes")).toHaveValue("16:45");
});

test("re-saving an existing day without an edit leaves the stored week unchanged", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  await page.getByRole("button", { name: /Weekdays 10/ }).click();
  await page.getByRole("button", { name: /^Replace$/ }).click();
  await expect
    .poll(async () => hours(await getStudioWeeklyDefaults(seed.studioId))[2])
    .toBe("10:00-18:00");
  const before = hours(await getStudioWeeklyDefaults(seed.studioId));

  await openDay(page, "Tuesday");
  await expect(page.getByLabel("Tuesday opens")).toHaveValue("10:00");
  await expect(page.getByLabel("Tuesday closes")).toHaveValue("18:00");
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByLabel("Tuesday opens")).toBeHidden();

  expect(hours(await getStudioWeeklyDefaults(seed.studioId))).toEqual(before);
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 834, height: 1194 } });

  test("a tap reaches the hour field and focuses it; nothing overlays it", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/settings/availability");
    await page.getByRole("button", { name: "Edit Wednesday" }).tap();
    const opens = page.getByLabel("Wednesday opens");
    // tap() fails its actionability check if another element would receive
    // the touch at the field's centre.
    await opens.tap();
    await expect(opens).toBeFocused();
    await expect(opens).toHaveAttribute("type", "time");
  });
});
