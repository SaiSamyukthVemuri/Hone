import { test, expect, type Page } from "@playwright/test";
import { seedE2eClient, setStudioBufferMinutes, sql } from "./helpers/seed";
import {
  closeTeam, clientNameOf, openDrawerForColumn, prepareBooking, reservationCount, rows, setupFiveUserTeam,
  DRAWER, SLOT, TZ, type Team, type User,
} from "./hon48-support/five-user-team";

// HON-48 five-user proof, part 2: MOVE, REASSIGN, BLOCK and BUFFER with conflicts.
//
// Opt-in: HON48_FIVE_USER_E2E=1. Same synthetic five-user studio and five sessions as part 1.
//
//   M  two users move two DIFFERENT appointments onto the SAME practitioner and the SAME slot at the same moment:
//      one appointment holds the slot, the other keeps its original time, no overlap, one reservation each
//   R  the owner reassigns an appointment from one practitioner to another: the row and its reservation follow,
//      and the old practitioner's calendar no longer holds it
//   K  a block and a booking contend for the same practitioner and window at the same moment: never both,
//      at least one commits, and the database holds no overlap
//   B  a studio buffer keeps the slots inside it off the booking drawer
//
// Evidence is the database rows, not only the toast.

test.skip(process.env.HON48_FIVE_USER_E2E !== "1", "opt-in HON-48 five-user proof; set HON48_FIVE_USER_E2E=1");
test.describe.configure({ mode: "serial" });

let t: Team;
let moveDay: string;

test.beforeAll(async ({ browser }) => {
  t = await setupFiveUserTeam(browser, 3);
  const [d] = await sql<{ day: string }>("select ((now() at time zone $1)::date+6)::text as day", [TZ]);
  moveDay = d.day;
});
test.afterAll(async () => { await closeTeam(t); });

async function seedAppointment(practitionerId: string, clientId: string, date: string, local: string, minutes = 60, bufferMinutes = 0) {
  const [row] = await sql<{ id: string }>(
    "insert into public.appointments " +
      "(id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
      "select gen_random_uuid(),$1,$2,$3,$4,s,s+make_interval(mins=>$8),$8,$9,s+make_interval(mins=>$8+$9),'confirmed' " +
      "from (select ($5::date + $6::time) at time zone $7 as s) t returning id",
    [t.seed.studioId, clientId, practitionerId, t.serviceId, date, local, TZ, minutes, bufferMinutes],
  );
  return row.id;
}

async function openMove(page: Page, appointmentId: string, date: string) {
  await page.goto(`/calendar/${appointmentId}`);
  await page.getByRole("button", { name: /^Move appointment$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Move appointment" });
  await expect(dialog).toBeVisible();
  // Wait for the dialog's FIRST load (it sets the default practitioner only then); changing the date before it
  // returns would leave the target empty and the move would ask for a reassignment.
  await expect(dialog.getByRole("button", { name: SLOT }).first()).toBeVisible({ timeout: 20_000 });
  const selector = dialog.getByLabel("Practitioner");
  if (await selector.count()) await expect(selector).not.toHaveValue("");
  await dialog.getByLabel("New date").fill(date);
  await dialog.getByText("Loading available times").waitFor({ state: "attached", timeout: 3_000 }).catch(() => {});
  await expect(dialog.getByText("Loading available times")).toHaveCount(0, { timeout: 20_000 });
  await expect(dialog.getByRole("button", { name: SLOT }).first()).toBeVisible({ timeout: 20_000 });
  return dialog;
}

const startOf = async (id: string) =>
  (await sql<{ s: string }>("select starts_at::text as s from public.appointments where id=$1", [id]))[0].s;

test("M: two users move different appointments onto the same practitioner and slot: one holds it", async () => {
  const bo = t.users[1];
  const cy = t.users[2];
  const ed = t.users[4];
  const { clientId: c1 } = await seedE2eClient(t.seed);
  const { clientId: c2 } = await seedE2eClient(t.seed);
  // Both appointments belong to Bo's column; they are moved onto the same later slot of Bo's day by two users.
  const a1 = await seedAppointment(bo.practitionerId, c1, t.day, "08:00");
  const a2 = await seedAppointment(bo.practitionerId, c2, t.day, "10:00");
  const orig1 = await startOf(a1);
  const orig2 = await startOf(a2);
  void cy; void ed;

  const owner = t.contexts[0].page;
  const boPage = t.contexts[1].page;
  const d1 = await openMove(owner, a1, moveDay);
  const d2 = await openMove(boPage, a2, moveDay);
  await d1.getByRole("button", { name: SLOT }).last().click();
  await d2.getByRole("button", { name: SLOT }).last().click();
  const confirm = (d: typeof d1) => d.getByRole("button", { name: /^Move appointment$/ });
  await expect(confirm(d1)).toBeEnabled();
  await expect(confirm(d2)).toBeEnabled();
  await Promise.all([confirm(d1).click(), confirm(d2).click()]);

  await expect
    .poll(async () => [(await startOf(a1)) !== orig1, (await startOf(a2)) !== orig2].filter(Boolean).length, { timeout: 20_000 })
    .toBe(1);
  await owner.waitForTimeout(3_000);
  const moved = [(await startOf(a1)) !== orig1, (await startOf(a2)) !== orig2].filter(Boolean).length;
  expect(moved, "exactly one appointment holds the contested slot; the other kept its original time").toBe(1);
  const [overlaps] = await sql<{ n: number }>(
    "select count(*)::int as n from public.appointments x join public.appointments y on x.id < y.id " +
      "and x.practitioner_id = y.practitioner_id and x.status='confirmed' and y.status='confirmed' " +
      "and tstzrange(x.starts_at, x.blocked_ends_at) && tstzrange(y.starts_at, y.blocked_ends_at) where x.studio_id=$1",
    [t.seed.studioId],
  );
  expect(overlaps.n, "no two confirmed appointments overlap for one practitioner").toBe(0);
  expect(await reservationCount(a1)).toBe(1);
  expect(await reservationCount(a2)).toBe(1);
});

test("R: the owner reassigns an appointment from one practitioner to another", async () => {
  const di = t.users[3];
  const ed = t.users[4];
  const { clientId } = await seedE2eClient(t.seed);
  const a = await seedAppointment(di.practitionerId, clientId, t.day, "13:00");
  const owner = t.contexts[0].page;
  const dialog = await openMove(owner, a, t.day);
  await dialog.getByLabel("Practitioner").selectOption(ed.practitionerId);
  // Keep the same time: the appointment's own slot is offered again for the new practitioner.
  const slot = dialog.getByRole("button", { name: /^1:00 PM$/ });
  await expect(slot).toBeVisible({ timeout: 20_000 });
  await slot.click();
  await dialog.getByRole("button", { name: /^(Reassign|Move and reassign|Move) appointment$/ }).click();
  await expect
    .poll(async () => (await sql<{ p: string }>("select practitioner_id::text as p from public.appointments where id=$1", [a]))[0].p, { timeout: 20_000 })
    .toBe(ed.practitionerId);
  const keys = await sql<{ resource_key: string }>(
    "select resource_key from public.studio_calendar_reservations where source_kind='appointment' and source_id=$1", [a],
  );
  expect(keys.map((k) => k.resource_key), "the reservation follows the new practitioner and the old one is released").toEqual([ed.practitionerId]);
  expect((await rows(t.seed, di.practitionerId, clientId)).length).toBe(0);
  expect((await rows(t.seed, ed.practitionerId, clientId)).length).toBe(1);
});

test("K: a block and a booking contend for the same practitioner and window: never both", async () => {
  const cy = t.users[2];
  const { clientId } = await seedE2eClient(t.seed);
  const name = await clientNameOf(t.seed, clientId);
  const cyPage = t.contexts[2].page;
  const owner = t.contexts[0].page;
  await openDrawerForColumn(cyPage, t.day, cy);
  const submit = await prepareBooking(cyPage, name, t.serviceId, cy, -1);
  // prepareBooking picked the LAST offered slot. Read that button's label, then block a window that covers it.
  const pressed = await DRAWER(cyPage).getByRole("button", { name: SLOT }).last().innerText();
  const [h12, mer] = pressed.trim().split(/\s+/);
  const [hh, mm] = h12.split(":").map(Number);
  const hour24 = (hh % 12) + (/pm/i.test(mer) ? 12 : 0);
  const startHM = `${String(hour24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const endHM = `${String(Math.min(hour24 + 1, 23)).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

  await owner.goto("/settings/availability");
  const s = owner.getByRole("heading", { name: "Block time" }).locator("xpath=ancestor::section[1]");
  await s.getByLabel("Date").fill(t.day);
  await s.getByLabel("Start", { exact: true }).fill(startHM);
  await s.getByLabel("End", { exact: true }).fill(endHM);
  await s.getByLabel("Applies to").selectOption({ label: `Only ${cy.name}` });
  const addBlock = s.getByRole("button", { name: "Add block" });

  await Promise.all([submit.click(), addBlock.click()]);
  await owner.waitForTimeout(5_000);

  const bookings = await rows(t.seed, cy.practitionerId, clientId);
  const blocks = await sql<{ id: string }>(
    "select id from public.studio_timed_blocks where studio_id=$1 and practitioner_id=$2 " +
      "and (starts_at at time zone $4)::date = $3::date",
    [t.seed.studioId, cy.practitionerId, t.day, TZ],
  );
  test.info().annotations.push({ type: "K-outcome", description: `bookings=${bookings.length} blocks=${blocks.length}` });
  expect(bookings.length + blocks.length, "at least one of the two commits").toBeGreaterThanOrEqual(1);
  expect(!(bookings.length === 1 && blocks.length >= 1), "a booking and a block never hold the same window").toBe(true);
});

test("B: a studio buffer keeps the slots inside it off the booking drawer", async () => {
  await setStudioBufferMinutes(t.seed.studioId, 30);
  const ed = t.users[4];
  const { clientId } = await seedE2eClient(t.seed);
  const name = await clientNameOf(t.seed, clientId);
  // 12:00-13:00 with a 30 minute buffer snapshot: the practitioner is held until 13:30.
  await seedAppointment(ed.practitionerId, clientId, moveDay, "12:00", 60, 30);
  const page = t.contexts[4].page;
  // Click an empty row (17:05): the default offset (12:05) lands on the appointment seeded above, and the top rows sit under the sticky headers.
  await openDrawerForColumn(page, moveDay, ed, 11 * 60 + 5);
  const d = DRAWER(page);
  await d.getByPlaceholder("Find existing client").fill(name);
  await d.getByRole("button", { name: new RegExp(name) }).first().click();
  await d.getByRole("combobox").first().selectOption(t.serviceId);
  const slots = d.getByRole("button", { name: SLOT });
  await expect(slots.first()).toBeVisible({ timeout: 20_000 });
  const labels = (await slots.allInnerTexts()).map((x) => x.trim());
  expect(labels, "the booked hour is not offered").not.toContain("12:00 PM");
  expect(labels, "the buffer after it is not offered").not.toContain("1:00 PM");
  expect(labels, "the first slot after the buffer is offered").toContain("1:30 PM");
});

test("K2: a REPEATING break and a booking contend for the same practitioner and window: never both", async () => {
  // The recurring writer is a separate path from the one-off block: it creates a rule and materializes one reservation
  // per occurrence. Same contest as K, same invariant: the window is held by the booking OR the break, never both.
  const di = t.users[3];
  const { clientId } = await seedE2eClient(t.seed);
  const name = await clientNameOf(t.seed, clientId);
  const diPage = t.contexts[3].page;
  const owner = t.contexts[0].page;
  await openDrawerForColumn(diPage, t.day, di);
  const submit = await prepareBooking(diPage, name, t.serviceId, di, 3);
  const picked = (await DRAWER(diPage).getByRole("button", { name: SLOT }).nth(3).innerText()).trim();
  const [h12, mer] = picked.split(/\s+/);
  const [hh, mm] = h12.split(":").map(Number);
  const hour24 = (hh % 12) + (/pm/i.test(mer) ? 12 : 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  const startHM = `${pad(hour24)}:${pad(mm)}`;
  const endHM = `${pad(Math.min(hour24 + 1, 23))}:${pad(mm)}`;
  const [dow] = await sql<{ dow: number }>("select extract(dow from $1::date)::int as dow", [t.day]);
  const short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow.dow];
  const label = `Break-${t.seed.runId.slice(0, 6)}`;

  await owner.goto("/settings/availability");
  const s = owner.getByRole("heading", { name: "Repeating breaks" }).locator("xpath=ancestor::section[1]");
  await s.getByLabel("Label").fill(label);
  await s.getByLabel("Start", { exact: true }).fill(startHM);
  await s.getByLabel("End", { exact: true }).fill(endHM);
  // The form opens with the working weekdays preselected, so a bare click on the target day would switch it OFF.
  // Set every weekday explicitly: only the contested day is on.
  const weekdays = s.getByRole("group", { name: "Weekdays" });
  for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    const btn = weekdays.getByRole("button", { name: d });
    const on = (await btn.getAttribute("aria-pressed")) === "true";
    if (on !== (d === short)) await btn.click();
  }
  await expect(weekdays.getByRole("button", { name: short })).toHaveAttribute("aria-pressed", "true");
  await s.getByLabel("Applies to").selectOption({ label: `Only ${di.name}` });
  const add = s.getByRole("button", { name: "Add repeating break" });

  await Promise.all([submit.click(), add.click()]);
  await owner.waitForTimeout(6_000);

  const bookings = await rows(t.seed, di.practitionerId, clientId);
  const rules = await sql<{ id: string }>(
    "select id from public.studio_recurring_break_rules where studio_id=$1 and practitioner_id=$2 and label=$3",
    [t.seed.studioId, di.practitionerId, label],
  );
  // Nothing of Di's holds an overlapping window twice: appointment and break-occurrence reservations never overlap.
  const [overlap] = await sql<{ n: number }>(
    "select count(*)::int as n from public.studio_calendar_reservations x join public.studio_calendar_reservations y " +
      "on x.id < y.id and x.studio_id = y.studio_id and x.resource_key = y.resource_key and tstzrange(x.starts_at, x.ends_at) && tstzrange(y.starts_at, y.ends_at) " +
      "where x.studio_id=$1 and x.resource_key=$2",
    [t.seed.studioId, di.practitionerId],
  );
  // Every appointment has exactly one reservation: no orphan and no duplicate.
  for (const b of bookings) expect(await reservationCount(b.id)).toBe(1);
  const [occ] = await sql<{ n: number }>(
    "select count(*)::int as n from public.studio_calendar_reservations where studio_id=$1 and resource_key::text=$2 " +
      "and source_kind='recurring_break_occurrence' and (starts_at at time zone $4)::date=$3::date",
    [t.seed.studioId, di.practitionerId, t.day, TZ],
  );
  console.log(`HON48_K2_OCC occurrence_on_contested_day=${occ.n}`);
  test.info().annotations.push({ type: "K2-outcome", description: `bookings=${bookings.length} rules=${rules.length} overlapping-reservations=${overlap.n}` });
  console.log(`HON48_K2 bookings=${bookings.length} rules=${rules.length} overlapping_reservations=${overlap.n}`);
  expect(bookings.length + rules.length, "at least one of the two commits").toBeGreaterThanOrEqual(1);
  expect(overlap.n, "the window is never held twice").toBe(0);
});
