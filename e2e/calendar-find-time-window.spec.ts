import { expect, test, type Locator, type Page } from "@playwright/test";
import { addDays } from "../lib/booking/tz";
import { loginAsOwner } from "./helpers/flows";
import { getE2eServiceId, seedE2eDashboardClient, seedE2eMember, seedE2eStudio, seedE2eTodayAppointment, sql } from "./helpers/seed";

// HON-131. Calendar > Find time searches at most seven days at a time (the form and find-time-actions.ts agree). An iPad user who left From at today and set
// Through to Dec 15 got only the browser's own bubble ("Value must be less than or equal to 2026-12-03"), which named a date and offered no way forward.
//   1. The window is stated beside the fields: "Search up to 7 days at a time."
//   2. Through past the window: the form says so beside Through, names the latest date for this From and what to do, sends nothing, focuses the field, and
//      never rewrites what was typed. No native bubble: the form does not use the browser's validation.
//   3. Moving From so that Through would fall outside the window moves Through too and SAYS so in a polite live region.
//   4. A week starting anywhere in weeks two to six (7..41 days out), with Through up to From + 6, is searchable.
//   5. Through all of it the client being rebooked, the service and the practitioner are kept.
//   6. A search creates nothing: the appointment rows (every column), the SMS outbox and the calendar sync outbox are identical afterwards.
// Synthetic data. The search is read-only; nothing is booked.
const T = 30_000;

async function setUp(page: Page) {
  const studio = await seedE2eStudio();
  const member = await seedE2eMember(studio);
  const client = await seedE2eDashboardClient(studio, { label: "Window client" });
  const { appointmentId } = await seedE2eTodayAppointment(studio, { clientId: client.clientId, startsMinutesFromNow: -30, endsMinutesFromNow: 0, withService: true });
  const serviceId = await getE2eServiceId(studio.studioId);
  await loginAsOwner(page, studio);
  await page.goto(`/calendar?view=week&rebook=${appointmentId}`);
  const find = page.getByRole("region", { name: "Find time" });
  await expect(find).toBeVisible({ timeout: T });
  return { studio, member, client, serviceId, find };
}

type Written = { appointments: string[]; sms: number; outbox: number };
const written = async (studioId: string): Promise<Written> => ({
  appointments: (await sql<{ j: string }>("select to_jsonb(a)::text as j from public.appointments a where studio_id = $1 order by id", [studioId])).map((r) => r.j),
  sms: (await sql<{ n: number }>("select count(*)::int n from public.sms_outbound_messages where studio_id = $1", [studioId]))[0]!.n,
  outbox: (await sql<{ n: number }>("select count(*)::int n from public.calendar_sync_outbox where studio_id = $1", [studioId]))[0]!.n,
});

async function selections(page: Page, find: Locator, clientName: string) {
  return {
    rebookFor: await page.getByText(`Rebook for ${clientName}`).count(),
    service: await find.getByLabel("Service").inputValue(),
    practitioner: await find.getByLabel("Practitioner").inputValue(),
  };
}

test("Find time: the 7-day window is stated and checked beside the field, weeks two to six are searchable, selections are kept and nothing is booked", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const { studio, member, client, serviceId, find } = await setUp(page);
  const before = await written(studio.studioId);
  expect(before.appointments, "the one seeded visit").toHaveLength(1);

  // The person's own choice, so a kept selection is proven against something that is not the default.
  await find.getByLabel("Practitioner").selectOption(member.practitionerId);
  const chosen = await selections(page, find, client.name);
  expect(chosen.service).toBe(serviceId);
  expect(chosen.practitioner).toBe(member.practitionerId);
  expect(chosen.rebookFor, "the client being rebooked is shown").toBeGreaterThan(0);

  const from = find.getByLabel("From");
  const through = find.getByLabel("Through");
  const search = find.getByRole("button", { name: "Search availability" });

  // 1. the window is stated
  await expect(find.getByText("Search up to 7 days at a time.")).toBeVisible();
  await expect(find.locator("form")).toHaveAttribute("novalidate", "");

  // 2. Through alone, past the window: what was typed stays, the message names the latest date and the way forward, nothing is searched
  const start = await from.inputValue();
  const farThrough = addDays(start, 18);
  await through.fill(farThrough);
  const error = find.locator("#find-time-through-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("You can search up to 7 days at a time.");
  await expect(error).toContainText("The latest Through date for this From is");
  await expect(error).toContainText("move From later");
  await expect(through).toHaveAttribute("aria-invalid", "true");
  await search.click();
  await expect(through).toBeFocused();
  await expect(find.getByRole("region", { name: "Available times" })).toHaveCount(0);
  await expect(through).toHaveValue(farThrough);
  expect(await selections(page, find, client.name)).toEqual(chosen);

  // 3a. From moves so that the typed Through is now INSIDE the window: nothing is rewritten, nothing is announced, and the message goes away
  const week3 = addDays(start, 14);
  await from.fill(week3);
  await expect(through).toHaveValue(farThrough);
  await expect(error).toHaveCount(0);
  const notice = find.getByTestId("find-time-notice");
  await expect(notice).toHaveAttribute("aria-live", "polite");
  await expect(notice).toHaveText("");
  expect(await selections(page, find, client.name)).toEqual(chosen);
  // 3b. From moves so far that Through would be stranded: Through moves with it, and the polite note says so
  const week5 = addDays(start, 30);
  await from.fill(week5);
  await expect(through).toHaveValue(addDays(week5, 2));
  await expect(notice).toContainText("Through moved to");
  await expect(notice).toContainText("so the search stays within 7 days of");
  await expect(error).toHaveCount(0);
  expect(await selections(page, find, client.name)).toEqual(chosen);

  // 4. a week starting in each of weeks two to six, up to the full seven days
  for (const offset of [7, 14, 21, 28, 35, 41]) {
    const first = addDays(start, offset);
    await from.fill(first);
    await through.fill(addDays(first, 6));
    await expect(find.locator('[role="alert"]'), `from +${offset}: no message`).toHaveCount(0);
    await search.click();
    await expect(find.getByRole("region", { name: "Available times" }), `from +${offset}: the search ran`).toBeVisible({ timeout: T });
    await expect(through).toHaveValue(addDays(first, 6));
    expect(await selections(page, find, client.name), `from +${offset}: selections kept`).toEqual(chosen);
  }
  // the eighth day is still refused, beside the field
  await through.fill(addDays(addDays(start, 41), 7));
  await expect(error).toContainText("The latest Through date for this From is");

  // 6. nothing was written
  expect(await written(studio.studioId), "a search creates nothing").toEqual(before);
});
