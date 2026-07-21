import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  setStudioCapacityEnabled,
  setStudioTimeFormat,
  setStudioTimezone,
  setPractitionerActive,
  seedStudioWideDefault,
  seedActiveScopedRule,
  seedConfirmedAppointment,
  getTimedBlockScopes,
  getSourceReservationKeys,
  getRecurringRuleScopes,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { randomUUID } from "node:crypto";

// PR B 3E-8 / §8 / §14 — the Studio B multi-practitioner block + recurring-break
// owner contract, driven through the REAL browser and verified against the DB.
// Covers: scope-selector a11y, practitioner-scoped one-off + ALL-DAY blocks,
// recurring toggle scope-preservation, the inactive-practitioner re-enable
// block, Legacy hide + reactivation, 12h/24h display, resource-aware conflict
// precision with no cross-practitioner false positive and no raw DB / PII text.
//
// SAFETY: a fresh synthetic studio on the LOCAL stack. Never Willow.

test.describe.configure({ mode: "serial" });

const MON = 1;
const today = () => new Date();
const futureDate = (days: number) =>
  new Date(today().getTime() + days * 86_400_000).toISOString().slice(0, 10);

let seed: E2eSeed;
let clientId: string;
let memberA: { email: string; displayName: string; practitionerId: string };
let memberB: { email: string; displayName: string; practitionerId: string };

// The nearest <section> ancestor of a section heading (Block time / Repeating
// breaks), so the two identical "Applies to" controls never collide.
const section = (page: Page, heading: string) =>
  page.getByRole("heading", { name: heading }).locator("xpath=ancestor::section[1]");

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  ({ clientId } = await seedE2eClient(seed));
  memberA = await seedE2eMember(seed);
  memberB = await seedE2eMember(seed);
  await setStudioCapacityEnabled(seed.studioId, true);
  // Pin UTC so block/break local wall-clock == UTC — the conflict test can seed
  // an appointment at a UTC instant that lines up with the local block times.
  await setStudioTimezone(seed.studioId, "UTC");
  await seedStudioWideDefault(seed.studioId, MON, true, "09:00", "17:00");
});

test("Studio-default: the 'Applies to' scope control is accessible and lists active practitioners", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");

  const blockScope = section(page, "Block time").getByLabel("Applies to");
  await expect(blockScope).toBeVisible(); // accessible name via aria-label + wrapped <span>
  await expect(blockScope.locator("option", { hasText: "All practitioners" })).toHaveCount(1);
  await expect(
    blockScope.locator("option", { hasText: `Only ${memberA.displayName}` }),
  ).toHaveCount(1);
  // Keyboard-selectable (not colour-only): select by label, value updates.
  await blockScope.selectOption({ label: `Only ${memberB.displayName}` });
  await expect(blockScope).toHaveValue(memberB.practitionerId);
});

test("owner creates a practitioner-scoped one-off block; only that practitioner's day is reserved", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const s = section(page, "Block time");

  await s.getByLabel("Date").fill(futureDate(7));
  await s.getByLabel("Start", { exact: true }).fill("13:00");
  await s.getByLabel("End", { exact: true }).fill("14:00");
  await s.getByLabel("Applies to").selectOption({ label: `Only ${memberA.displayName}` });
  await s.getByRole("button", { name: "Add block" }).click();

  // DB: a block scoped to A appears, and it reserves ONLY A (never B/C). Uses
  // `some`/`find` (not an exact count) so a CI retry into the shared studio is safe.
  await expect
    .poll(async () =>
      (await getTimedBlockScopes(seed.studioId)).some((b) => b.practitioner_id === memberA.practitionerId),
    )
    .toBe(true);
  const block = (await getTimedBlockScopes(seed.studioId)).find(
    (b) => b.practitioner_id === memberA.practitionerId,
  )!;
  expect(await getSourceReservationKeys("timed_block", block.id)).toEqual([
    memberA.practitionerId,
  ]);
  // The list ROW is labelled with its scope (scope the match to the <li> so it
  // never resolves to the hidden "Only <name>" <option>s in the scope dropdown).
  await expect(
    s.getByRole("listitem").filter({ hasText: `Only ${memberA.displayName}` }),
  ).toBeVisible();
});

test("a practitioner-scoped ALL-DAY block still scopes to one practitioner (selector stays usable)", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const s = section(page, "Block time");

  await s.getByLabel("Date").fill(futureDate(9));
  await s.getByLabel(/All day/).check();
  // The scope selector is NOT disabled by All day; pick B.
  const scope = s.getByLabel("Applies to");
  await expect(scope).toBeEnabled();
  await scope.selectOption({ label: `Only ${memberB.displayName}` });
  await s.getByRole("button", { name: "Add block" }).click();

  await expect
    .poll(async () => {
      const blocks = await getTimedBlockScopes(seed.studioId);
      const allDay = blocks.find((b) => b.practitioner_id === memberB.practitionerId);
      return allDay ? await getSourceReservationKeys("timed_block", allDay.id) : null;
    })
    .toEqual([memberB.practitionerId]); // B's whole day only — A + owner untouched
});

test("toggling a scoped recurring break preserves its practitioner scope (never widens to studio-wide)", async ({
  page,
}) => {
  // Unique label so a CI retry (shared studio) never yields two matching rows.
  const label = `Lunch-${randomUUID().slice(0, 6)}`;
  const ruleId = await seedActiveScopedRule(
    seed.studioId,
    memberA.practitionerId,
    label,
    [MON],
    "12:00",
    "12:30",
  );
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const s = section(page, "Repeating breaks");
  const row = s.getByRole("listitem").filter({ hasText: label });

  await row.getByRole("button", { name: "Disable" }).click();
  await expect
    .poll(async () => (await getRecurringRuleScopes(seed.studioId)).find((r) => r.id === ruleId)?.active)
    .toBe(false);
  // Scope preserved through the disable.
  expect(
    (await getRecurringRuleScopes(seed.studioId)).find((r) => r.id === ruleId)?.practitioner_id,
  ).toBe(memberA.practitionerId);

  await row.getByRole("button", { name: "Enable" }).click();
  await expect
    .poll(async () => (await getRecurringRuleScopes(seed.studioId)).find((r) => r.id === ruleId)?.active)
    .toBe(true);
  // Still scoped to A after re-enable — the mandatory scope-preservation invariant.
  expect(
    (await getRecurringRuleScopes(seed.studioId)).find((r) => r.id === ruleId)?.practitioner_id,
  ).toBe(memberA.practitionerId);
});

test("a recurring break assigned to a now-inactive practitioner cannot be re-enabled", async ({
  page,
}) => {
  const label = `Admin-${randomUUID().slice(0, 6)}`;
  const ruleId = await seedActiveScopedRule(
    seed.studioId,
    memberB.practitionerId,
    label,
    [MON],
    "16:00",
    "16:30",
  );
  await setPractitionerActive(memberB.practitionerId, false);

  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const s = section(page, "Repeating breaks");
  const row = s.getByRole("listitem").filter({ hasText: label });

  // Disabling is allowed.
  await row.getByRole("button", { name: "Disable" }).click();
  await expect
    .poll(async () => (await getRecurringRuleScopes(seed.studioId)).find((r) => r.id === ruleId)?.active)
    .toBe(false);

  // Re-enabling is blocked with a safe, actionable message (no raw DB text).
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(s.getByText(/Reassign it before enabling it/i)).toBeVisible();
  // Still disabled in the DB — the guard held.
  expect(
    (await getRecurringRuleScopes(seed.studioId)).find((r) => r.id === ruleId)?.active,
  ).toBe(false);
  await setPractitionerActive(memberB.practitionerId, true); // restore for later tests
});

test("24-hour studios render break times in 24h; 12-hour studios use AM/PM", async ({ page }) => {
  await seedActiveScopedRule(seed.studioId, memberA.practitionerId, "Dinner", [MON], "13:30", "14:00");

  await setStudioTimeFormat(seed.studioId, "24h");
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const s = section(page, "Repeating breaks");
  await expect(s.getByText("13:30").first()).toBeVisible();

  await setStudioTimeFormat(seed.studioId, "12h");
  await page.reload();
  await expect(s.getByText(/1:30\s*PM/).first()).toBeVisible();
});

test("resource-aware conflict: A's appointment does NOT block a B-only block, but DOES block an A-only one, with no PII", async ({
  page,
}) => {
  const d = futureDate(14);
  await seedConfirmedAppointment(
    seed.studioId,
    memberA.practitionerId,
    clientId,
    `${d}T18:00:00Z`,
    `${d}T19:00:00Z`,
  );
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const s = section(page, "Block time");

  // A B-only block at the SAME window as A's appointment succeeds (B is a
  // different resource, so A's appointment never collides with it).
  await s.getByLabel("Date").fill(d);
  await s.getByLabel("Start", { exact: true }).fill("18:00"); // studio tz pinned to UTC
  await s.getByLabel("End", { exact: true }).fill("19:00");
  await s.getByLabel("Applies to").selectOption({ label: `Only ${memberB.displayName}` });
  await s.getByRole("button", { name: "Add block" }).click();
  await expect
    .poll(async () =>
      (await getTimedBlockScopes(seed.studioId)).some((b) => b.practitioner_id === memberB.practitionerId),
    )
    .toBe(true); // no false conflict for B

  // An A-only block overlapping A's appointment is rejected with a safe message.
  await page.goto("/settings/availability"); // fresh form
  const s2 = section(page, "Block time");
  await s2.getByLabel("Date").fill(d);
  // Match the appointment window in studio-local time.
  await s2.getByLabel("Start", { exact: true }).fill("18:00");
  await s2.getByLabel("End", { exact: true }).fill("19:00");
  await s2.getByLabel("Applies to").selectOption({ label: `Only ${memberA.displayName}` });
  await s2.getByRole("button", { name: "Add block" }).click();

  const err = s2.getByText(/overlaps an appointment/i);
  await expect(err).toBeVisible();
  // The message never exposes the client's identity or any raw DB text.
  await expect(s2.getByText(seed.clientName)).toHaveCount(0);
  await expect(s2.getByText(/studio_calendar_reservations|constraint|sqlstate|23P01/i)).toHaveCount(0);
});

test("Legacy hides retained scoped sources; reactivation restores them", async ({ page }) => {
  // A retained scoped block exists from the earlier test (memberA). Roll back.
  await setStudioCapacityEnabled(seed.studioId, false);
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  // Flag OFF: no scope selector, and A-scoped rows are hidden (studio-wide only).
  await expect(page.getByRole("link", { name: "Studio default" })).toHaveCount(0);
  const s = section(page, "Block time");
  await expect(
    s.getByRole("listitem").filter({ hasText: `Only ${memberA.displayName}` }),
  ).toHaveCount(0);

  // Reactivate: the scoped source is retained in the DB and becomes visible again.
  await setStudioCapacityEnabled(seed.studioId, true);
  await page.reload();
  const retained = (await getTimedBlockScopes(seed.studioId)).some(
    (b) => b.practitioner_id === memberA.practitionerId,
  );
  expect(retained).toBe(true);
});
