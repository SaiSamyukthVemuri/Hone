import { test, expect } from "@playwright/test";
import {
  seedE2eDashboardMemoryClient,
  seedE2eStudio,
  seedPinnedNote,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// ===========================================================================
// CHLOE-DASH-01 — both production complaints, on the real dashboard
// ===========================================================================
//
//   "Not all the pinned notes show up on dashboard. If I pin multiple notes I
//    need to see all of them."
//
// The second half of that report — changing the row action — was reverted for a
// concurrency reason recorded in the PR, so this spec covers the notes only.
//
// THREE notes on purpose: the old roster rendered exactly one, so a two-note
// fixture would have passed against the defect roughly half the time depending
// on ordering. Three makes "only the newest" unmistakable.
// ===========================================================================

const T = 15_000;

const NOTE_OLDEST = "PINNEDONE prefers the 2pm slot";
const NOTE_MIDDLE = "PINNEDTWO park at the rear entrance";
const NOTE_NEWEST = "PINNEDTHREE bring the shorter cable";

test("every pinned note renders on the dashboard roster", async ({ page }) => {
  const seed = await seedE2eStudio();
  // This fixture ALREADY seeds a confirmed appointment today (now + 2h) and
  // returns its id. Seeding a second one for the same client collides with the
  // studio-wide no-overlap exclusion constraint, which is exactly how the first
  // run of this spec failed in CI.
  const { clientId } = await seedE2eDashboardMemoryClient(seed, {
    cautionNote: "Avoid the jawline",
    nextVisitNote: "Lower the energy one step",
  });

  // Seeded oldest-first so the roster has to sort, not merely echo insertion.
  await seedPinnedNote(seed.studioId, clientId, NOTE_OLDEST);
  await seedPinnedNote(seed.studioId, clientId, NOTE_MIDDLE);
  await seedPinnedNote(seed.studioId, clientId, NOTE_NEWEST);

  await loginAsOwner(page, seed);
  await page.goto("/dashboard");

  await test.step("ALL THREE pinned notes are visible", async () => {
    for (const text of [NOTE_NEWEST, NOTE_MIDDLE, NOTE_OLDEST]) {
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: T });
    }
  });

  await test.step("they are distinct rows, newest first", async () => {
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const iNew = body.indexOf("PINNEDTHREE");
    const iMid = body.indexOf("PINNEDTWO");
    const iOld = body.indexOf("PINNEDONE");
    expect(iNew).toBeGreaterThan(-1);
    expect(iMid).toBeGreaterThan(iNew);
    expect(iOld).toBeGreaterThan(iMid);
  });

  await test.step("Before Today preparation renders alongside the notes", async () => {
    await expect(page.getByText(/Before today/i).first()).toBeVisible({ timeout: T });
    await expect(page.getByText("Lower the energy one step").first()).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("all pinned notes still render, and the roster does not scroll sideways", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eDashboardMemoryClient(seed, { cautionNote: null });
    // Same fixture, same reason: it already owns today's appointment.

    await seedPinnedNote(seed.studioId, clientId, NOTE_OLDEST);
    await seedPinnedNote(seed.studioId, clientId, NOTE_MIDDLE);
    // A long unbroken note is the overflow case: it must wrap, not widen the page.
    await seedPinnedNote(
      seed.studioId,
      clientId,
      `PINNEDLONG ${"averylongunbrokenwordthatcannotwrapnaturally".repeat(3)}`,
    );
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");

    for (const text of ["PINNEDLONG", NOTE_MIDDLE, NOTE_OLDEST]) {
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: T });
    }

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, "dashboard scrolls horizontally on a 390px viewport").toBe(false);
  });
});
