import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2eStudio, sql } from "./helpers/seed";

// HON-114 — a staff change must not hide openings that are genuinely free, SEEN in a real browser on the public booking page.
//
// rematerialize_studio_reservations (0137) stored each appointment's reservation end as the real end PLUS the buffer, and every reader adds the buffer again, so after a
// practitioner was added the first opening after each existing visit disappeared from the public page until the visit was touched. 0384 stores the real end.
// The database and engine proofs are tests/db/rematerialize-actual-end.db.test.ts; this is the part only a browser can show: the slot is actually ON THE PAGE.
//
// A studio with a 20-minute buffer, per-practitioner capacity ON, and an existing 10:00-11:00 appointment. A SECOND practitioner is then added (the refan) and the
// appointment is NOT re-saved. The first opening exactly one buffer after the visit (11:20) must be listed; nothing inside the gap (11:00 to 11:19) may be.

const T = 60_000;

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function openBookingForm(page: Page, slug: string) {
  await page.goto(`/book/${slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await expect(page.locator("select").first()).toBeVisible({ timeout: T });
}

test.describe("HON-114: the public booking page after a staff change", () => {
  test.setTimeout(T * 3);

  test("the opening one buffer after an existing visit is listed, and the gap is not", async ({ page }) => {
    const seed = await seedE2eStudio();
    const tz = (await sql<{ timezone: string }>(`select timezone from public.studios where id = $1`, [seed.studioId]))[0]!.timezone;
    const today = (await sql<{ d: string }>(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d`, [tz]))[0]!.d;
    const day = addDays(today, 2);

    await sql(`update public.studios set buffer_minutes = 20, practitioner_capacity_enabled = true where id = $1`, [seed.studioId]);
    const owner = (await sql<{ id: string }>(`select id from public.practitioners where studio_id = $1 and role = 'owner'`, [seed.studioId]))[0]!.id;
    const service = (await sql<{ id: string }>(`select id from public.services where studio_id = $1 limit 1`, [seed.studioId]))[0]!.id;
    const clientId = randomUUID();
    await sql(`insert into public.clients (id, studio_id, name) values ($1,$2,'Existing visit')`, [clientId, seed.studioId]);
    await sql(
      `insert into public.appointments (id, studio_id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, status)
       values ($1,$2,$3,$4,$5, (($6::date + time '10:00') at time zone $7), (($6::date + time '11:00') at time zone $7), 60, 'confirmed')`,
      [randomUUID(), seed.studioId, clientId, owner, service, day, tz],
    );

    // THE STAFF CHANGE: add a practitioner. The appointment is not touched afterwards.
    const userId = randomUUID();
    const email = `hon114-${userId.slice(0, 8)}@harness.local`;
    await sql(`insert into auth.users (id, email) values ($1,$2)`, [userId, email]);
    await sql(`insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values ($1,$2,$3,'Second',$4,'practitioner',true)`, [
      randomUUID(),
      seed.studioId,
      userId,
      email,
    ]);

    // POSITIVE CONTROL on the database side: the reservation still holds the REAL end (11:00 local), so the page below is reading correct data.
    const held = await sql<{ ok: boolean }>(
      `select (r.ends_at = a.ends_at) as ok from public.studio_calendar_reservations r join public.appointments a on a.id = r.source_id
        where r.studio_id = $1 and r.source_kind = 'appointment'`,
      [seed.studioId],
    );
    expect(held.length).toBe(1);
    expect(held[0]!.ok, "the reservation must end at the appointment's real end after the staff change").toBe(true);

    await openBookingForm(page, seed.slug);
    const dateInput = page.locator('input[type="date"]').first();
    await expect(dateInput).toBeVisible({ timeout: T });
    await dateInput.fill(day);

    // A slot button is listed at all (the page loaded the day) ...
    const anySlot = page.getByRole("button", { name: /\d{1,2}:\d{2}\s*(AM|PM)/i }).first();
    await expect(anySlot).toBeVisible({ timeout: 30_000 });
    // ... the first opening exactly 20 minutes after the visit ends is on the page ...
    await expect(page.getByRole("button", { name: /^\s*11:20\s*AM\s*$/i })).toBeVisible({ timeout: 30_000 });
    // ... and nothing inside the buffer gap (11:00 to 11:19) is offered.
    await expect(page.getByRole("button", { name: /^\s*11:(0\d|1\d)\s*AM\s*$/i })).toHaveCount(0);
  });
});
