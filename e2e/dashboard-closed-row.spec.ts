import { test, expect } from "@playwright/test";
import {
  seedE2eDashboardMemoryClient,
  seedE2eIntake,
  seedE2eStudio,
  seedPinnedNote,
  sql,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// ===========================================================================
// Insurance PEER-1308 D-4: the CLOSED-state roster row, proved WITHOUT the
// helper that opens the row details.
// ===========================================================================
// Every other dashboard spec logs in with `openTodayRowDetailsOnLoad` so it can read what lives
// inside the row's <details>. This one deliberately does not: it proves that what must be visible
// on the compact row is visible with the details CLOSED, and that the rest really is collapsed.
// Not run locally (no stack here); Photos / CI own the run.

const T = 15_000;
const NOTE_A = "CLOSEDPINONE prefers the 2pm slot";
const NOTE_B = "CLOSEDPINTWO park at the rear entrance and bring the shorter cable for the second appointment";
const CAUTION = "Avoid the jawline CLOSEDCAUTION and keep the energy low on the upper lip";
const PLAN = "Lower the energy one step CLOSEDPLAN";

test("closed row: pinned notes in full, allergy flag, caution line and intake pill are visible; the rest is collapsed", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eDashboardMemoryClient(seed, {
    cautionNote: CAUTION,
    nextVisitNote: PLAN,
  });
  await sql(`update public.clients set allergies = $1 where id = $2`, ["Latex CLOSEDALLERGY", clientId]);
  await seedPinnedNote(seed.studioId, clientId, NOTE_A);
  await seedPinnedNote(seed.studioId, clientId, NOTE_B);
  await seedE2eIntake(seed.studioId, clientId, "submitted");

  // NO openTodayRowDetailsOnLoad.
  await loginByMagicLink(page, seed.ownerEmail, { openRowDetails: false });
  await page.goto("/dashboard");

  const details = page.locator('details[data-testid="today-row-details"]').first();
  await expect(details).toBeAttached({ timeout: T });
  await expect(details).not.toHaveAttribute("open", "");

  await test.step("both pinned notes are visible in FULL (not truncated)", async () => {
    await expect(page.getByText(NOTE_A, { exact: true })).toBeVisible({ timeout: T });
    await expect(page.getByText(NOTE_B, { exact: true })).toBeVisible();
  });

  await test.step("the allergy flag is visible", async () => {
    await expect(page.getByText("Allergies", { exact: true }).first()).toBeVisible();
  });

  await test.step("the caution/watch line is visible with its full text", async () => {
    await expect(page.getByTestId("today-row-caution").first()).toContainText(CAUTION);
  });

  await test.step("the intake status pill is visible", async () => {
    await expect(page.getByText("Intake awaiting review").first()).toBeVisible();
  });

  await test.step("a plan note shows as a cue, with the note itself inside the closed details", async () => {
    await expect(page.getByTestId("today-row-plan-cue").first()).toHaveText(/Plan note on record/);
    await expect(page.getByText(PLAN)).toBeHidden();
    await expect(page.getByText(/^Latest setup:/)).toBeHidden();
  });

  await test.step("opening the details reveals what was collapsed", async () => {
    await details.locator("summary").click();
    await expect(page.getByText(PLAN).first()).toBeVisible();
    await expect(page.getByText(/^Latest setup:/).first()).toBeVisible();
  });
});
