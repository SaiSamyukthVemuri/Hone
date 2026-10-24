import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  seedPractitionerDefault,
  seedServiceEligibility,
  getE2eServiceId,
  seedConfirmedAppointment,
  getOwnerPractitionerId,
  setStudioTimezone,
  sql,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// The practitioner working calendar runs SUNDAY → SATURDAY, and the same
// Sunday boundary drives the DATA RANGE, not just the headers.
//
// THE FAILURE THIS EXISTS TO CATCH is not a mis-ordered header — that is
// obvious the moment anyone looks. It is the silent one: a grid that starts
// Sunday while the query still starts Monday. The header reads correctly, the
// page looks perfect, and the practitioner's Sunday appointment is simply
// GONE. Nothing on screen says anything is wrong.
//
// So every assertion below binds a rendered COLUMN to the local DATE it
// claims to be (data-date), and then asserts what is inside that exact
// column. A cosmetic reorder cannot satisfy it.

const T = 20_000;

// Seeded calendar selection only, not public booking or physical-device UAT.
// Managed page fixtures retain the normal CI failure trace and screenshot.
for (const mode of [
  { name: "dense mouse week", width: 1280, coarse: false },
  { name: "coarse tablet week", width: 768, coarse: true },
  { name: "coarse phone day", width: 390, coarse: true },
]) {
  test.describe("five coincident practitioner cards — " + mode.name, () => {
    test.use({ viewport: { width: mode.width, height: 900 }, hasTouch: mode.coarse });

    test("normal selection opens each own client and practitioner without creating a session", async ({ page }) => {
      const seed = await seedE2eStudio();
      const tz = "America/Los_Angeles";
      await setStudioTimezone(seed.studioId, tz);
      await setStudioCapacityEnabled(seed.studioId, true);
      await setStudioCapacityBookingEnabled(seed.studioId, true);
      const ids = [await getOwnerPractitionerId(seed.studioId)];
      for (let i = 0; i < 4; i++) ids.push((await seedE2eMember(seed)).practitionerId);
      const roster = await sql<{ id: string; display_name: string; role: string; active: boolean }>(
        "select id,display_name,role,active from public.practitioners where studio_id=$1 and id=any($2::uuid[])",
        [seed.studioId, ids],
      );
      expect(roster).toHaveLength(5);
      expect(roster.filter(p => p.role === "owner")).toHaveLength(1);
      expect(roster.filter(p => p.role === "practitioner")).toHaveLength(4);
      expect(roster.every(p => p.active)).toBe(true);
      const [{ day, dow }] = await sql<{ day: string; dow: number }>(
        "select ((now() at time zone $1)::date+7)::text as day, extract(dow from ((now() at time zone $1)::date+7))::int as dow",
        [tz],
      );
      const serviceId = await getE2eServiceId(seed.studioId);
      const [service] = await sql<{ minutes: number }>(
        "select default_duration_minutes as minutes from public.services where studio_id=$1 and id=$2 and active",
        [seed.studioId, serviceId],
      );
      expect(service.minutes).toBe(30); // The existing synthetic consultation.
      const bookings: Array<{ id: string; clientId: string; clientName: string; practitionerName: string }> = [];
      for (const id of ids) {
        await seedPractitionerDefault(seed.studioId, id, dow, true, "06:00", "22:00");
        await seedServiceEligibility(seed.studioId, serviceId, id);
        const { clientId } = await seedE2eClient(seed);
        const [client] = await sql<{ name: string }>(
          "select name from public.clients where studio_id=$1 and id=$2", [seed.studioId, clientId],
        );
        // Future LA interval, actual service duration, distinct eligible
        // practitioners/clients. Existing DB guards remain enabled.
        const [appointment] = await sql<{ id: string }>(
          "insert into public.appointments " +
          "(id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at," +
          "duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
          "select gen_random_uuid(),$1,$2,$3,$4,start_at,start_at+make_interval(mins=>$7),$7,0," +
          "start_at+make_interval(mins=>$7),'confirmed' " +
          "from (select ($5::date+time '10:00') at time zone $6 as start_at) t returning id",
          [seed.studioId, clientId, id, serviceId, day, tz, service.minutes],
        );
        bookings.push({ id: appointment.id, clientId, clientName: client.name,
          practitionerName: roster.find(p => p.id === id)!.display_name });
      }
      const clientIds = bookings.map(b => b.clientId);
      const readAppointments = () => sql(
        "select id,client_id,practitioner_id,status,starts_at::text,ends_at::text,service_id,duration_minutes " +
        "from public.appointments where studio_id=$1 and client_id=any($2::uuid[]) order by id",
        [seed.studioId, clientIds],
      );
      const readSessions = () => sql(
        "select id,client_id,appointment_id from public.sessions where studio_id=$1 and client_id=any($2::uuid[]) order by id",
        [seed.studioId, clientIds],
      );
      const before = await readAppointments();
      expect(before).toHaveLength(5);
      expect(new Set(before.map(a => a.practitioner_id)).size).toBe(5);
      expect(new Set(before.map(a => a.starts_at)).size).toBe(1);
      expect(new Set(before.map(a => a.ends_at)).size).toBe(1);
      for (const row of before) expect(row).toMatchObject({ status: "confirmed", service_id: serviceId, duration_minutes: 30 });
      expect(await readSessions()).toEqual([]);
      await loginAsOwner(page, seed);
      const activate = (target: Locator) => mode.coarse
        ? target.tap({ timeout: 10_000 }) : target.click({ timeout: 10_000 });
      const assertOwnHref = async (link: Locator, id: string) => {
        const href = await link.getAttribute("href");
        expect(href).not.toBeNull();
        const target = new URL(href!, page.url());
        expect(target.origin).toBe(new URL(page.url()).origin);
        expect(target.pathname).toBe("/calendar/" + id);
      };
      for (const [index, booking] of bookings.entries()) {
        await page.goto("/calendar?view=week&day=" + day);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(mode.coarse);
        expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(!mode.coarse);
        const surface = page.locator('[data-testid="' +
          (mode.width >= 768 ? "week-day-column" : "mobile-day-timeline") + '"][data-date="' + day + '"]');
        await expect(surface).toBeVisible();
        if (mode.width >= 768) await expect(page.getByTestId("week-day-column")).toHaveCount(7);
        expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(mode.coarse);
        if (mode.width >= 768) {
          // The existing max-w-5xl seven-day grid cannot provide five 44px
          // lanes after their 8px insets; mouse must get the same chooser.
          const available = await surface.evaluate(el => el.clientWidth / 5 - 8);
          expect(available).toBeLessThan(44);
        }
        const group = surface.getByRole("button", { name: "Choose from 5 appointments", exact: true });
        await expect(group).toHaveCount(1);
        for (const expected of bookings) await expect(surface.getByRole("button").filter({ hasText: expected.clientName })).toHaveCount(0);
        await group.scrollIntoViewIfNeeded();
        const bounds = await group.boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        if (index === 0) await group.focus();
        await activate(group);
        const chooser = page.getByRole("dialog", { name: "Choose an appointment", exact: true });
        await expect(chooser).toBeVisible();
        if (index === 0) {
          await page.keyboard.press("Escape");
          await expect(chooser).toHaveCount(0);
          await expect(group).toBeFocused();
          await activate(group);
          await activate(chooser.getByRole("button", { name: "Close", exact: true }));
          await expect(chooser).toHaveCount(0);
          await activate(group);
        }
        for (const expected of bookings) {
          const choice = chooser.getByRole(mode.width >= 768 ? "button" : "link").filter({ hasText: expected.clientName });
          await expect(choice).toHaveCount(1);
          await expect(choice.getByText(expected.practitionerName, { exact: true })).toBeVisible();
          const box = await choice.boundingBox();
          expect(box!.width).toBeGreaterThanOrEqual(44);
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        const choice = chooser.getByRole(mode.width >= 768 ? "button" : "link").filter({ hasText: booking.clientName });
        if (mode.width < 768) await assertOwnHref(choice, booking.id);
        await activate(choice);
        await expect(page.getByRole("dialog", { name: "New appointment", exact: true })).toHaveCount(0);
        if (mode.width >= 768) {
          const preview = page.getByRole("dialog", { name: /appointment preview/i });
          await expect(preview.getByRole("heading", { name: booking.clientName, exact: true })).toBeVisible();
          const details = preview.getByRole("link", { name: /open full details/i });
          await assertOwnHref(details, booking.id);
          await activate(details);
        }
        await expect.poll(() => new URL(page.url()).pathname).toBe("/calendar/" + booking.id);
        const header = page.locator("main header").first();
        await expect(header.getByText(booking.practitionerName, { exact: false })).toBeVisible();
        await expect(header.getByText(/unassigned/i)).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      expect(await readAppointments()).toEqual(before);
      expect(await readSessions()).toEqual([]);
    });

    test("adjacent short appointment and timed block remain selectable by normal input", async ({ page }) => {
      const seed = await seedE2eStudio();
      const tz = "America/Los_Angeles";
      await setStudioTimezone(seed.studioId, tz);
      // The 0135 guard refuses a practitioner-scoped weekday unless capacity
      // is on; same studio shape as the five-card test above.
      await setStudioCapacityEnabled(seed.studioId, true);
      await setStudioCapacityBookingEnabled(seed.studioId, true);
      const practitionerId = await getOwnerPractitionerId(seed.studioId);
      const { clientId } = await seedE2eClient(seed);
      const [{ day, dow }] = await sql<{ day: string; dow: number }>(
        "select ((now() at time zone $1)::date+7)::text as day, extract(dow from ((now() at time zone $1)::date+7))::int as dow", [tz],
      );
      await seedPractitionerDefault(seed.studioId, practitionerId, dow, true, "06:00", "22:00");
      const serviceId = await getE2eServiceId(seed.studioId);
      // This fresh run owns this synthetic service. Its actual duration must
      // match the appointment, rather than bypassing a 30-minute service guard.
      await sql("update public.services set default_duration_minutes=15 where id=$1 and studio_id=$2", [serviceId, seed.studioId]);
      await seedServiceEligibility(seed.studioId, serviceId, practitionerId);
      const [{ minutes }] = await sql<{ minutes: number }>(
        "select default_duration_minutes as minutes from public.services where id=$1 and studio_id=$2 and active", [serviceId, seed.studioId],
      );
      expect(minutes).toBe(15);
      const [{ name: clientName }] = await sql<{ name: string }>("select name from public.clients where id=$1 and studio_id=$2", [clientId, seed.studioId]);
      const [{ display_name: practitionerName }] = await sql<{ display_name: string }>(
        "select display_name from public.practitioners where id=$1 and studio_id=$2 and active", [practitionerId, seed.studioId],
      );
      const [appointment] = await sql<{ id: string }>(
        "insert into public.appointments " +
        "(id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
        "select gen_random_uuid(),$1,$2,$3,$4,start_at,start_at+interval '15 minutes',15,0,start_at+interval '15 minutes','confirmed' " +
        "from (select ($5::date+time '10:00') at time zone $6 as start_at) t returning id",
        [seed.studioId, clientId, practitionerId, serviceId, day, tz],
      );
      const marker = "adjacent-short-block-" + seed.runId;
      const [block] = await sql<{ id: string }>(
        "insert into public.studio_timed_blocks (studio_id,practitioner_id,created_by,starts_at,ends_at,category,private_note) " +
        "select $1,$2,$2,start_at,start_at+interval '15 minutes','break',$3 " +
        "from (select ($4::date+time '10:15') at time zone $5 as start_at) t returning id",
        [seed.studioId, practitionerId, marker, day, tz],
      );
      const [{ disjoint, appointment_minutes, service_minutes }] = await sql<{
        disjoint: boolean; appointment_minutes: number; service_minutes: number;
      }>(
        "select a.ends_at=b.starts_at and a.blocked_ends_at<=b.starts_at as disjoint, " +
        "(extract(epoch from (a.ends_at-a.starts_at))/60)::int as appointment_minutes, s.default_duration_minutes as service_minutes " +
        "from public.appointments a join public.services s on s.id=a.service_id and s.studio_id=a.studio_id " +
        "join public.studio_timed_blocks b on b.studio_id=a.studio_id where a.id=$1 and b.id=$2", [appointment.id, block.id],
      );
      expect({ disjoint, appointment_minutes, service_minutes }).toEqual({ disjoint: true, appointment_minutes: 15, service_minutes: 15 });
      // Nonoverlapping DB intervals still collide as rendered targets: the
      // appointment's 44px floor reaches past the adjacent block at +15px.
      const readAppointment = () => sql(
        "select id,client_id,practitioner_id,service_id,duration_minutes,status,starts_at::text,ends_at::text,blocked_ends_at::text " +
        "from public.appointments where studio_id=$1 and id=$2", [seed.studioId, appointment.id],
      );
      const readBlock = () => sql(
        "select id,practitioner_id,created_by,starts_at::text,ends_at::text,category,private_note,updated_at::text " +
        "from public.studio_timed_blocks where studio_id=$1 and id=$2", [seed.studioId, block.id],
      );
      const readSessions = () => sql("select id,appointment_id from public.sessions where studio_id=$1 and client_id=$2 order by id", [seed.studioId, clientId]);
      const beforeAppointment = await readAppointment();
      const beforeBlock = await readBlock();
      expect(beforeAppointment).toHaveLength(1);
      expect(beforeBlock).toHaveLength(1);
      expect(await readSessions()).toEqual([]);
      await loginAsOwner(page, seed);
      await page.goto("/calendar?view=week&day=" + day);
      expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(!mode.coarse);
      expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(mode.coarse);
      const activate = (target: Locator) => mode.coarse ? target.tap({ timeout: 10_000 }) : target.click({ timeout: 10_000 });
      const surface = page.locator('[data-testid="' + (mode.width >= 768 ? "week-day-column" : "mobile-day-timeline") + '"][data-date="' + day + '"]');
      await expect(surface).toBeVisible();
      const group = surface.getByRole("button", { name: "Choose from 2 calendar items", exact: true });
      await expect(group).toHaveCount(1);
      await group.scrollIntoViewIfNeeded();
      const groupBox = await group.boundingBox();
      expect(groupBox).not.toBeNull();
      expect(groupBox!.width).toBeGreaterThanOrEqual(44);
      expect(groupBox!.height).toBeGreaterThanOrEqual(44);
      await activate(group);
      const chooser = page.getByRole("dialog", { name: "Choose a calendar item", exact: true });
      await expect(chooser).toBeVisible();
      const blockChoice = chooser.locator(`[data-timed-block-id="${block.id}"]`);
      await expect(blockChoice).toHaveCount(1);
      await expect(blockChoice.getByText("Break", { exact: true })).toBeVisible();
      const blockBox = await blockChoice.boundingBox();
      expect(blockBox).not.toBeNull();
      expect(blockBox!.width).toBeGreaterThanOrEqual(44);
      expect(blockBox!.height).toBeGreaterThanOrEqual(44);
      await activate(blockChoice);
      await expect(chooser).toHaveCount(0);
      const edit = page.getByRole("dialog", { name: "Blocked time", exact: true });
      await expect(edit).toBeVisible();
      // Not exact: each control sits inside its <label>, so the label's text also
      // carries the textarea's content and every <option>. The values prove it.
      await expect(edit.getByLabel("Private note (optional)")).toHaveValue(marker);
      await expect(edit.getByLabel("Category")).toHaveValue("break");
      await expect(edit.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      await expect(page.getByRole("dialog", { name: "New appointment", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(edit).toHaveCount(0);
      await activate(group);
      await expect(chooser).toBeVisible();
      const choice = chooser.getByRole(mode.width >= 768 ? "button" : "link").filter({ hasText: clientName });
      await expect(choice).toHaveCount(1);
      await expect(choice.getByText(practitionerName, { exact: true })).toBeVisible();
      const choiceBox = await choice.boundingBox();
      expect(choiceBox).not.toBeNull();
      expect(choiceBox!.width).toBeGreaterThanOrEqual(44);
      expect(choiceBox!.height).toBeGreaterThanOrEqual(44);
      const assertOwnHref = async (link: Locator) => {
        const href = await link.getAttribute("href");
        expect(href).not.toBeNull();
        const target = new URL(href!, page.url());
        expect(target.origin).toBe(new URL(page.url()).origin);
        expect(target.pathname).toBe("/calendar/" + appointment.id);
      };
      if (mode.width < 768) await assertOwnHref(choice);
      await activate(choice);
      if (mode.width >= 768) {
        const preview = page.getByRole("dialog", { name: /appointment preview/i });
        await expect(preview.getByRole("heading", { name: clientName, exact: true })).toBeVisible();
        const details = preview.getByRole("link", { name: /open full details/i });
        await assertOwnHref(details);
        await activate(details);
      }
      await expect.poll(() => new URL(page.url()).pathname).toBe("/calendar/" + appointment.id);
      await expect(page.locator(`main a[href="/clients/${clientId}"]`).filter({ hasText: clientName }).first()).toBeVisible();
      await expect(page.locator("main header").first().getByText(practitionerName, { exact: false })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await readAppointment()).toEqual(beforeAppointment);
      expect(await readBlock()).toEqual(beforeBlock);
      expect(await readSessions()).toEqual([]);
    });
  });
}

// A fixed timezone and a fixed week, so this spec does not drift with the
// calendar date of the run. America/Toronto is the repo's established DST
// fixture zone (lib/booking/tz.ts's two-pass correction was written for it).
// 2026-08-09 is a Sunday; the whole week is EDT (UTC-4), so local→UTC is a
// flat +4h and the seeded instants stay readable.
const TZ = "America/Toronto";
const SUNDAY = "2026-08-09";
const MONDAY = "2026-08-10";
const SATURDAY = "2026-08-15";
const NEXT_SUNDAY = "2026-08-16";
// Opened with a MIDWEEK date on purpose: the page must resolve Wed → its
// Sunday, rather than starting the grid on whatever day was clicked.
const MIDWEEK = "2026-08-12";

// EDT is UTC-4 for this entire week.
function edt(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(`${date}T${String(h + 4).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`).toISOString();
}

async function seedWeek(seed: Awaited<ReturnType<typeof seedE2eStudio>>) {
  await setStudioTimezone(seed.studioId, TZ);
  const practitionerId = await getOwnerPractitionerId(seed.studioId);
  // seedE2eStudio does NOT create a client row (its clientName/clientEmail are
  // the values the public booking flow would use), so seed one here.
  const clientId = (
    await sql<{ id: string }>(
      `insert into public.clients (id, studio_id, name, email)
       values (gen_random_uuid(), $1, $2, $3) returning id`,
      [seed.studioId, seed.clientName, seed.clientEmail],
    )
  )[0].id;

  const mk = async (date: string, hhmm: string) =>
    seedConfirmedAppointment(
      seed.studioId,
      practitionerId,
      clientId,
      edt(date, hhmm),
      edt(date, `${String(Number(hhmm.split(":")[0]) + 1).padStart(2, "0")}:00`),
    );

  return {
    clientId,
    // First column of the week under test.
    sundayAppt: await mk(SUNDAY, "09:00"),
    // Second column.
    mondayAppt: await mk(MONDAY, "10:00"),
    // EXCLUSION CONTROL: belongs to the NEXT week. If the range were
    // inclusive of the following Sunday, this would leak in.
    nextSundayAppt: await mk(NEXT_SUNDAY, "11:00"),
  };
}

async function openWeek(page: Page, anchor: string) {
  await page.goto(`/calendar?view=week&week=${anchor}`);
  await expect(page.getByTestId("week-day-header").first()).toBeVisible({
    timeout: T,
  });
}

// The dates of the seven rendered columns, in visual order.
async function headerDates(page: Page): Promise<string[]> {
  return page
    .getByTestId("week-day-header")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-date") ?? ""));
}

async function headerWeekdayLabels(page: Page): Promise<string[]> {
  return page
    .getByTestId("week-day-header")
    .evaluateAll((els) =>
      els.map((e) => (e.firstElementChild?.textContent ?? "").trim()),
    );
}

// Independent weekday naming — never ask the code under test what "Sunday" is.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function weekdayOf(dateStr: string): string {
  return DOW[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
}

test.describe("practitioner calendar — week starts Sunday", () => {
  test("a midweek date opens the Sunday→Saturday week, with the data range to match", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const seeded = await seedWeek(seed);
    await loginAsOwner(page, seed);
    await openWeek(page, MIDWEEK);

    await test.step("the seven columns run Sunday → Saturday", async () => {
      const dates = await headerDates(page);
      expect(dates).toHaveLength(7);
      // The selected date was a WEDNESDAY; the grid still begins on its Sunday.
      expect(dates[0]).toBe(SUNDAY);
      expect(dates[6]).toBe(SATURDAY);
      expect(dates.map(weekdayOf)).toEqual(DOW);
      // ...and the printed labels agree with the real weekday of each date,
      // which is what a cosmetic-only reorder would break.
      expect(await headerWeekdayLabels(page)).toEqual(DOW);
    });

    await test.step("the SUNDAY appointment is in the FIRST column", async () => {
      // This is the anti-cosmetic assertion. If the fetch range still began
      // Monday, this column would render empty while the header still said
      // "Sun".
      const sundayCol = page.locator(
        `[data-testid="week-day-column"][data-date="${SUNDAY}"]`,
      );
      await expect(sundayCol).toHaveCount(1);
      await expect(sundayCol.getByText(seed.clientName).first()).toBeVisible({
        timeout: T,
      });
    });

    await test.step("the MONDAY appointment is in the SECOND column, not the first", async () => {
      const cols = page.getByTestId("week-day-column");
      expect(
        await cols.evaluateAll((els) =>
          els.map((e) => e.getAttribute("data-date")),
        ),
      ).toEqual([SUNDAY, MONDAY, "2026-08-11", MIDWEEK, "2026-08-13", "2026-08-14", SATURDAY]);
      await expect(
        page
          .locator(`[data-testid="week-day-column"][data-date="${MONDAY}"]`)
          .getByText(seed.clientName)
          .first(),
      ).toBeVisible();
    });

    await test.step("the FOLLOWING Sunday is NOT in this week's grid", async () => {
      // Half-open range: [Sunday, next Sunday). The exclusion control must not
      // appear as a column at all.
      expect(await headerDates(page)).not.toContain(NEXT_SUNDAY);
      await expect(
        page.locator(
          `[data-testid="week-day-column"][data-date="${NEXT_SUNDAY}"]`,
        ),
      ).toHaveCount(0);
      expect(seeded.nextSundayAppt.length).toBeGreaterThan(0);
    });
  });

  test("Next week advances to the FOLLOWING Sunday and picks up its appointment", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await seedWeek(seed);
    await loginAsOwner(page, seed);
    await openWeek(page, MIDWEEK);

    expect((await headerDates(page))[0]).toBe(SUNDAY);

    await page.getByRole("link", { name: "Next", exact: true }).first().click();
    await page.waitForURL(`**/calendar?week=${NEXT_SUNDAY}`, { timeout: T });
    await expect(page.getByTestId("week-day-header").first()).toBeVisible({
      timeout: T,
    });

    const dates = await headerDates(page);
    expect(dates[0]).toBe(NEXT_SUNDAY);
    expect(dates.map(weekdayOf)).toEqual(DOW);
    // The appointment excluded from the previous week now appears — proving the
    // boundary MOVED the appointment rather than dropping it.
    await expect(
      page
        .locator(`[data-testid="week-day-column"][data-date="${NEXT_SUNDAY}"]`)
        .getByText(seed.clientName)
        .first(),
    ).toBeVisible({ timeout: T });
    // ...and the previous week's Sunday is gone from this grid.
    expect(dates).not.toContain(SUNDAY);

    await test.step("Previous week returns to the original Sunday, without drift", async () => {
      await page
        .getByRole("link", { name: "Previous", exact: true })
        .first()
        .click();
      await page.waitForURL(`**/calendar?week=${SUNDAY}`, { timeout: T });
      await expect(page.getByTestId("week-day-header").first()).toBeVisible({
        timeout: T,
      });
      expect((await headerDates(page))[0]).toBe(SUNDAY);
    });
  });
});
