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
  getTimedBlocksByNote,
  getAppointmentInterval,
  getSourceReservationKeys,
  getRecurringRuleScopes,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { randomUUID } from "node:crypto";

// PR B 3E-8 / §8 / §14, the Studio B multi-practitioner block + recurring-break
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
// The next Saturday (>= 1 day out). A whole-day block placed here never collides
// with any MON-FRI recurring rule's fan-out, so no explicit DB cleanup is needed
// (the e2e lane relies on a disposable local database, never `delete from`).
const nextSaturday = () => {
  const d = today();
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
};

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
  // Pin UTC so block/break local wall-clock == UTC, the conflict test can seed
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

  // A Saturday, so this whole-day block never collides with the MON-FRI
  // recurring rule created later (no explicit cleanup needed).
  await s.getByLabel("Date").fill(nextSaturday());
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
    .toEqual([memberB.practitionerId]); // B's whole day only, A + owner untouched
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
  // Still scoped to A after re-enable, the mandatory scope-preservation invariant.
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
  // Still disabled in the DB, the guard held.
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

test("resource-aware conflict is non-vacuous: A's appointment blocks an A-only block (safe, format-aware msg) but not a B-only one", async ({
  page,
}) => {
  const d = futureDate(21);
  const apptId = await seedConfirmedAppointment(
    seed.studioId,
    memberA.practitionerId,
    clientId,
    `${d}T18:00:00Z`,
    `${d}T19:00:00Z`,
  );
  const before = await getAppointmentInterval(apptId);
  // Unique markers so each assertion targets the EXACT new row, never a block
  // from another test or a prior retry.
  const noteB = `cx-B-${randomUUID().slice(0, 8)}`;
  const noteA = `cx-A-${randomUUID().slice(0, 8)}`;

  const fillBlock = async (s: ReturnType<typeof section>, who: string, note: string) => {
    await s.getByLabel("Date").fill(d);
    await s.getByLabel("Start", { exact: true }).fill("18:00"); // studio tz = UTC
    await s.getByLabel("End", { exact: true }).fill("19:00");
    await s.getByLabel(/Private note/).fill(note);
    await s.getByLabel("Applies to").selectOption({ label: `Only ${who}` });
    await s.getByRole("button", { name: "Add block" }).click();
  };

  // --- B-only block at A's exact window: NO conflict. ---
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const sB = section(page, "Block time");
  await fillBlock(sB, memberB.displayName, noteB);
  // No inline error; exactly ONE new row; keyed to B; A's appointment intact.
  await expect(sB.getByText(/overlaps|Could not/i)).toHaveCount(0);
  await expect
    .poll(async () => (await getTimedBlocksByNote(seed.studioId, noteB)).length)
    .toBe(1);
  const [rowB] = await getTimedBlocksByNote(seed.studioId, noteB);
  expect(rowB.practitioner_id).toBe(memberB.practitionerId);
  expect(await getSourceReservationKeys("timed_block", rowB.id)).toEqual([memberB.practitionerId]);
  expect(await getAppointmentInterval(apptId)).toEqual(before); // appointment unchanged

  // --- A-only block at A's exact window: rejected, format-aware safe message. ---
  await setStudioTimeFormat(seed.studioId, "12h");
  await page.goto("/settings/availability");
  const sA = section(page, "Block time");
  await fillBlock(sA, memberA.displayName, noteA);
  // Scope the format check to the conflict MESSAGE element (not the section) so
  // it can never pass because a block row elsewhere shows the same time.
  const msgA = sA.getByText(/overlaps an appointment/i);
  await expect(msgA).toBeVisible();
  await expect(msgA).toContainText(/6:00\s*PM/); // the message itself is 12h
  // NO new row was created (the write rolled back); no PII / raw DB text.
  expect((await getTimedBlocksByNote(seed.studioId, noteA)).length).toBe(0);
  await expect(sA.getByText(seed.clientName)).toHaveCount(0);
  await expect(sA.getByText(/studio_calendar_reservations|constraint|sqlstate|23P01/i)).toHaveCount(0);
  expect(await getAppointmentInterval(apptId)).toEqual(before); // still unchanged

  // 24h studio renders the same conflict in 24h.
  await setStudioTimeFormat(seed.studioId, "24h");
  await page.goto("/settings/availability");
  const sA24 = section(page, "Block time");
  await fillBlock(sA24, memberA.displayName, `${noteA}-24`);
  const msgA24 = sA24.getByText(/overlaps an appointment/i);
  await expect(msgA24).toBeVisible();
  await expect(msgA24).toContainText(/18:00/); // the message itself is 24h
  expect((await getTimedBlocksByNote(seed.studioId, `${noteA}-24`)).length).toBe(0);
  await setStudioTimeFormat(seed.studioId, "12h"); // restore
});

test("timed-block lifecycle: studio-wide create → scope A → B → studio-wide, edit interval + category, all-day edit, delete", async ({
  page,
}) => {
  const note = `life-${randomUUID().slice(0, 8)}`;
  const d = futureDate(28);
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const s = () => section(page, "Block time");
  const li = () => s().getByRole("listitem").filter({ hasText: note });
  const scopeOf = async () => (await getTimedBlocksByNote(seed.studioId, note))[0]?.practitioner_id ?? null;
  const rowId = async () => (await getTimedBlocksByNote(seed.studioId, note))[0]!.id;

  // Early-morning windows that never overlap the earlier tests' recurring
  // occurrences (12:00-12:30, 13:30-14:00 on Mondays), so a studio-wide fan-out
  // never 23P01s regardless of which weekday the run lands on.
  await test.step("create STUDIO-WIDE (fans out to all practitioners)", async () => {
    await s().getByLabel("Date").fill(d);
    await s().getByLabel("Start", { exact: true }).fill("07:00");
    await s().getByLabel("End", { exact: true }).fill("08:00");
    await s().getByLabel(/Private note/).fill(note);
    await s().getByLabel("Applies to").selectOption("");
    await s().getByRole("button", { name: "Add block" }).click();
    await expect.poll(async () => (await getTimedBlocksByNote(seed.studioId, note)).length).toBe(1);
    expect(await scopeOf()).toBeNull();
    expect((await getSourceReservationKeys("timed_block", await rowId())).length).toBe(3); // owner + A + B
  });

  await test.step("scope studio-wide → A → B → studio-wide via edit; reservations re-key each time", async () => {
    const id = await rowId();
    for (const [who, expected] of [
      [`Only ${memberA.displayName}`, memberA.practitionerId],
      [`Only ${memberB.displayName}`, memberB.practitionerId],
      ["All practitioners", null],
    ] as const) {
      await li().getByRole("button", { name: "Edit" }).click();
      await s().getByLabel("Applies to").selectOption({ label: who });
      await s().getByRole("button", { name: "Save changes" }).click();
      await expect.poll(scopeOf).toBe(expected);
      const keys = await getSourceReservationKeys("timed_block", id);
      expect(expected === null ? keys.length : keys).toEqual(expected === null ? 3 : [expected]);
    }
  });

  await test.step("edit the interval", async () => {
    await li().getByRole("button", { name: "Edit" }).click();
    await s().getByLabel("Start", { exact: true }).fill("06:00");
    await s().getByLabel("End", { exact: true }).fill("06:30");
    await s().getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(async () => (await getTimedBlocksByNote(seed.studioId, note))[0].starts_at)
      .toContain("06:00:00");
  });

  await test.step("edit the category (interval preserved)", async () => {
    await li().getByRole("button", { name: "Edit" }).click();
    await s().getByLabel("Category").selectOption("lunch");
    await s().getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(async () => (await getTimedBlocksByNote(seed.studioId, note))[0].category)
      .toBe("lunch");
    expect((await getTimedBlocksByNote(seed.studioId, note))[0].starts_at).toContain("06:00:00");
  });

  await test.step("convert to ALL-DAY via edit; edit stays all-day; convert back", async () => {
    // Scope to B (who has no recurring occurrences) before making it all-day, so
    // the whole-day block never collides with A's occurrences on a Monday run.
    await li().getByRole("button", { name: "Edit" }).click();
    await s().getByLabel("Applies to").selectOption({ label: `Only ${memberB.displayName}` });
    await s().getByLabel(/All day/).check();
    await s().getByRole("button", { name: "Save changes" }).click();
    // Local midnight → next local midnight (UTC studio).
    await expect
      .poll(async () => (await getTimedBlocksByNote(seed.studioId, note))[0].starts_at)
      .toContain("00:00:00");
    // Re-edit the category: all-day must be PRESERVED (not reshaped to timed).
    await li().getByRole("button", { name: "Edit" }).click();
    await expect(s().getByLabel(/All day/)).toBeChecked(); // detected from the stored boundaries
    await s().getByLabel("Category").selectOption("break");
    await s().getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(async () => (await getTimedBlocksByNote(seed.studioId, note))[0].category)
      .toBe("break");
    const row = (await getTimedBlocksByNote(seed.studioId, note))[0];
    expect(row.starts_at).toContain("00:00:00"); // STILL all-day
    expect(row.ends_at).toContain("00:00:00");
  });

  await test.step("delete", async () => {
    await li().getByRole("button", { name: "Delete" }).click();
    await expect.poll(async () => (await getTimedBlocksByNote(seed.studioId, note)).length).toBe(0);
  });
});

test("timed-block conflict rollback preserves the original interval + scope", async ({ page }) => {
  const note = `roll-${randomUUID().slice(0, 8)}`;
  const d = futureDate(33);
  // A owns 14:00-15:00 that day; the block starts safely at 09:00-10:00 scoped A.
  await seedConfirmedAppointment(seed.studioId, memberA.practitionerId, clientId, `${d}T14:00:00Z`, `${d}T15:00:00Z`);
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const s = () => section(page, "Block time");
  const li = () => s().getByRole("listitem").filter({ hasText: note });

  await s().getByLabel("Date").fill(d);
  await s().getByLabel("Start", { exact: true }).fill("09:00");
  await s().getByLabel("End", { exact: true }).fill("10:00");
  await s().getByLabel(/Private note/).fill(note);
  await s().getByLabel("Applies to").selectOption({ label: `Only ${memberA.displayName}` });
  await s().getByRole("button", { name: "Add block" }).click();
  await expect.poll(async () => (await getTimedBlocksByNote(seed.studioId, note)).length).toBe(1);

  // Try to move it onto A's appointment window → conflict; original row unchanged.
  await li().getByRole("button", { name: "Edit" }).click();
  await s().getByLabel("Start", { exact: true }).fill("14:00");
  await s().getByLabel("End", { exact: true }).fill("15:00");
  await s().getByRole("button", { name: "Save changes" }).click();
  await expect(s().getByText(/overlaps an appointment/i)).toBeVisible();
  const row = (await getTimedBlocksByNote(seed.studioId, note))[0];
  expect(row.starts_at).toContain("09:00:00"); // interval preserved
  expect(row.practitioner_id).toBe(memberA.practitionerId); // scope preserved
});

test("Cancel while editing restores the current page's default scope", async ({ page }) => {
  const note = `cxl-${randomUUID().slice(0, 8)}`;
  await loginAsOwner(page, seed);
  // Create a studio-wide block in the Studio-default view.
  await page.goto("/settings/availability");
  let s = section(page, "Block time");
  await s.getByLabel("Date").fill(futureDate(40));
  await s.getByLabel("Start", { exact: true }).fill("08:00");
  await s.getByLabel("End", { exact: true }).fill("08:30");
  await s.getByLabel(/Private note/).fill(note);
  await s.getByLabel("Applies to").selectOption("");
  await s.getByRole("button", { name: "Add block" }).click();
  await expect.poll(async () => (await getTimedBlocksByNote(seed.studioId, note)).length).toBe(1);

  // In A's practitioner view the create-form scope defaults to A.
  await page.goto(`/settings/availability?practitioner=${memberA.practitionerId}`);
  s = section(page, "Block time");
  await expect(s.getByLabel("Applies to")).toHaveValue(memberA.practitionerId);
  // Editing the studio-wide block populates the form with ITS scope (studio-wide)...
  await s.getByRole("listitem").filter({ hasText: note }).getByRole("button", { name: "Edit" }).click();
  await expect(s.getByLabel("Applies to")).toHaveValue("");
  // ...and Cancel resets the form back to the page default (A), not the edited item.
  await s.getByRole("button", { name: "Cancel" }).click();
  await expect(s.getByLabel("Applies to")).toHaveValue(memberA.practitionerId);
});

test("recurring lifecycle: create → edit → scope studio-wide → A → B → studio-wide → delete, all via UI", async ({
  page,
}) => {
  const label = `Rlife-${randomUUID().slice(0, 6)}`;
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  const s = () => section(page, "Repeating breaks");
  const li = () => s().getByRole("listitem").filter({ hasText: label });
  const ruleScope = async () =>
    (await getRecurringRuleScopes(seed.studioId)).find((r) => r.label === label)?.practitioner_id;

  await test.step("create studio-wide via UI", async () => {
    await s().getByLabel("Label").fill(label);
    // 10:00-10:30 never overlaps the other tests' occurrences (12:00/13:30/16:00).
    await s().getByLabel("Start", { exact: true }).fill("10:00");
    await s().getByLabel("End", { exact: true }).fill("10:30");
    await s().getByLabel("Applies to").selectOption("");
    await s().getByRole("button", { name: "Add repeating break" }).click();
    await expect
      .poll(async () => (await getRecurringRuleScopes(seed.studioId)).some((r) => r.label === label))
      .toBe(true);
    expect(await ruleScope()).toBeNull();
  });

  await test.step("scope studio-wide → A → B → studio-wide via edit", async () => {
    for (const [who, expected] of [
      [`Only ${memberA.displayName}`, memberA.practitionerId],
      [`Only ${memberB.displayName}`, memberB.practitionerId],
      ["All practitioners", null],
    ] as const) {
      await li().getByRole("button", { name: "Edit" }).click();
      await s().getByLabel("Applies to").selectOption({ label: who });
      await s().getByRole("button", { name: "Save changes" }).click();
      await expect.poll(ruleScope).toBe(expected);
    }
  });

  await test.step("delete via UI", async () => {
    await li().getByRole("button", { name: "Delete" }).click();
    await expect
      .poll(async () => (await getRecurringRuleScopes(seed.studioId)).some((r) => r.label === label))
      .toBe(false);
  });
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
