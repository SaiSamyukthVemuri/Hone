import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  setStudioCapacityEnabled,
  seedStudioWideDefault,
  seedPractitionerDefault,
  getPractitionerWeekday,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import { randomUUID } from "node:crypto";

// PR B Part 2 — flag-ON owner schedule-management contract on a synthetic
// three-practitioner studio (owner + 2 members). Exercises the REAL scope
// selector + per-practitioner customize/reset actions through the browser, and
// asserts both browser-visible state AND the scoped DB rows.
//
// SAFETY: a fresh synthetic studio on the LOCAL stack. Never Willow.

test.describe.configure({ mode: "serial" });

const MON = 1; // day_of_week

let seed: E2eSeed;
let memberA: { email: string; displayName: string; practitionerId: string };
let memberB: { email: string; displayName: string; practitionerId: string };

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  memberA = await seedE2eMember(seed);
  memberB = await seedE2eMember(seed);
  await setStudioCapacityEnabled(seed.studioId, true);
  await seedStudioWideDefault(seed.studioId, MON, true, "09:00", "17:00");
});

test("non-owner practitioner cannot access schedule management", async ({ page }) => {
  expect(E2E_APP_ORIGIN).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);
  await loginByMagicLink(page, memberA.email);
  await page.goto("/settings/availability");
  await expect(page.getByText(/Only studio owners can change availability/i)).toBeVisible();
});

test("owner customizes and resets a practitioner weekday; other practitioners stay inherited", async ({
  page,
}) => {
  await loginAsOwner(page, seed);

  // Scope selector shows Studio default + both members.
  await page.goto("/settings/availability");
  await expect(page.getByRole("link", { name: "Studio default" })).toBeVisible();
  await expect(page.getByRole("link", { name: memberA.displayName })).toBeVisible();
  await expect(page.getByRole("link", { name: memberB.displayName })).toBeVisible();

  // Member A scope: Monday initially INHERITS the studio default.
  await page.goto(`/settings/availability?practitioner=${memberA.practitionerId}`);
  const mondayA = page.getByRole("listitem").filter({ hasText: "Monday" });
  await expect(mondayA.getByText("Using studio default")).toBeVisible();

  // Customize Monday for A: 11:00–15:00.
  await mondayA.getByRole("button", { name: "Customize" }).click();
  await mondayA.getByLabel("Open time for Monday").fill("11:00");
  await mondayA.getByLabel("Close time for Monday").fill("15:00");
  await mondayA.getByRole("button", { name: "Save" }).click();

  // DB: A now has a scoped Monday row with the custom hours.
  await expect
    .poll(async () => {
      const r = await getPractitionerWeekday(seed.studioId, memberA.practitionerId, MON);
      return r ? `${r.is_open}:${String(r.open_time).slice(0, 5)}-${String(r.close_time).slice(0, 5)}` : null;
    })
    .toBe("true:11:00-15:00");
  await expect(
    page.getByRole("listitem").filter({ hasText: "Monday" }).getByText("Custom hours"),
  ).toBeVisible();

  // Member B is untouched — still inherits, and has NO scoped row.
  await page.goto(`/settings/availability?practitioner=${memberB.practitionerId}`);
  await expect(
    page.getByRole("listitem").filter({ hasText: "Monday" }).getByText("Using studio default"),
  ).toBeVisible();
  expect(await getPractitionerWeekday(seed.studioId, memberB.practitionerId, MON)).toBeNull();

  // Reset A's Monday -> row deleted, UI back to inherited.
  await page.goto(`/settings/availability?practitioner=${memberA.practitionerId}`);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Monday" })
    .getByRole("button", { name: "Reset to studio default" })
    .click();
  await expect
    .poll(() => getPractitionerWeekday(seed.studioId, memberA.practitionerId, MON))
    .toBeNull();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Monday" }).getByText("Using studio default"),
  ).toBeVisible();
});

test("a tampered / unknown practitioner id falls back to Studio default scope", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  await page.goto(`/settings/availability?practitioner=${randomUUID()}`);
  // Falls back to studio scope: the per-practitioner editor is NOT shown; the
  // Studio-default scope link is the active one.
  await expect(page.getByRole("link", { name: "Studio default" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // The per-practitioner editor is NOT rendered — its full-week control (unique
  // to PractitionerWeekEditor) is absent in the studio-scope fallback.
  await expect(
    page.getByRole("button", { name: "Customize full week from studio default" }),
  ).toHaveCount(0);
});

test("rollback: with retained practitioner rows, the flag-OFF page renders studio-wide only (no crash)", async ({
  page,
}) => {
  // Give member A a retained custom Monday (flag still ON), then roll back.
  await seedPractitionerDefault(seed.studioId, memberA.practitionerId, MON, true, "11:00", "15:00");
  await setStudioCapacityEnabled(seed.studioId, false);

  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  // Renders without a mixed-rows crash; flag OFF => no scope selector.
  await expect(page.getByRole("heading", { name: /^Availability$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Studio default" })).toHaveCount(0);
  // The retained practitioner row is untouched by loading the OFF page.
  const a = await getPractitionerWeekday(seed.studioId, memberA.practitionerId, MON);
  expect(a?.open_time).toMatch(/^11:00/);
});
