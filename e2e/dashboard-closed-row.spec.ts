import { test, expect } from "@playwright/test";
import {
  seedE2eDashboardMemoryClient,
  seedE2eIntake,
  seedE2eStudio,
  seedPinnedNote,
  sql,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { ensureLastVisitDetailsOpen } from "./helpers/last-visit-details";

const T = 15_000;
const NOTE_A = "CLOSEDPINONE prefers the 2pm slot";
const NOTE_B = "CLOSEDPINTWO park at the rear entrance and bring the shorter cable for the second appointment";
const CAUTION = "Avoid the jawline CLOSEDCAUTION and keep the energy low on the upper lip";
const PLAN = "Lower the energy one step CLOSEDPLAN";

test("closed row: pinned notes in full, allergy flag, caution line and intake pill are visible; the previous settings open in one step", async ({
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

  await loginByMagicLink(page, seed.ownerEmail);
  await page.goto("/dashboard");

  const row = page.getByTestId("today-row-body").filter({ hasText: "Memory Client" }).locator("xpath=ancestor::li[1]");
  const toggle = row.getByRole("button", { name: /^Last visit details for / });
  await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: T }); // open by default (Chloe, 26 Nov)

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

  await test.step("HON-65 (Chloe): the Last treatment line is visible on the closed row, not behind Visit details", async () => {
    await expect(page.getByTestId("dashboard-memory-compact").first()).toBeVisible({ timeout: T });
    await expect(page.getByTestId("dashboard-memory-compact").first()).toContainText("Last treatment:");
  });

  await test.step("the note applies to this visit and the primary actions are immediately available", async () => {
    await expect(row.getByTestId("dashboard-prep-remember")).toContainText(PLAN);
    await expect(row.getByText(PLAN, { exact: false }).last()).toBeVisible();
    await expect(row.getByTestId("dashboard-memory-full")).toHaveCount(0);
    await expect(row.getByTestId("today-consultation-notes")).toBeVisible();
    await expect(row.getByTestId("today-review-intake")).toBeVisible();
    await expect(row.getByRole("button", { name: "Checkout", exact: true })).toBeVisible();
    await expect(row.getByRole("link", { name: "Rebook", exact: true })).toBeVisible();
    await expect(row.getByRole("link", { name: "Chart", exact: true })).toBeVisible();
  });

  await test.step("one click reveals the settings without repeating the visit reminder", async () => {
    await ensureLastVisitDetailsOpen(toggle);
    await expect(row.getByTestId("dashboard-memory-full")).toContainText("27.12 MHz");
    await expect(row.getByTestId("dashboard-memory-full")).toContainText("Synchro");
    await expect(row.getByTestId("dashboard-memory-full")).not.toContainText(PLAN);
    await expect(row.getByTestId("dashboard-prep-remember")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/dashboard");
  });
});
