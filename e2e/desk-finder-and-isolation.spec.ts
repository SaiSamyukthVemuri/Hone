import { test, expect, type Page } from "@playwright/test";
import type { Client } from "pg";
import { asReceptionist, seedDeskFixture, signInAsDesk, expectPathRefused, type DeskFixture } from "./helpers/desk";
import { sql } from "./helpers/seed";

// The receptionist desk, the parts the other desk specs do not assert (desk-calendar.spec.ts: names, contact dialog, one booking; receptionist-onboarding-flow.spec.ts: the
// owner-to-desk chain). Synthetic data, local stack only.
//   1. The client finder shows the name the studio approved for the desk and a MASKED contact hint; the full email, the phone and the account name are never on the page.
//   2. A booking lands on the chosen practitioner, and after a refresh exactly ONE booking shows, on that practitioner's calendar and not on another's.
//   3. Called directly as the signed-in receptionist (not through the page), every desk command refuses another studio with not_authorized (42501); after the owner removes
//      them the database refuses them on their own studio too, and the open desk is closed.

const T = 60_000;

async function openBookingForMember(page: Page, f: DeskFixture) {
  await page.goto(`/desk?view=month&date=${f.date}`);
  await expect(page.getByRole("button", { name: /Ari Rowan/ })).toBeVisible({ timeout: T });
  await page.getByRole("button", { name: "Find an opening", exact: true }).first().click();
  const book = page.getByRole("region", { name: "Desk booking" });
  await book.getByRole("combobox", { name: "Service", exact: true }).selectOption(f.serviceId);
  await book.getByRole("combobox", { name: "Time of day", exact: true }).selectOption({ label: "Noon onward" });
  await book.getByRole("button", { name: "Search availability" }).click();
  await expect(book.getByRole("heading", { name: "First opening per practitioner" })).toBeVisible({ timeout: T });
  await book.getByRole("button", { name: new RegExp(f.member.displayName) }).filter({ hasText: /PM/i }).first().click();
  return book;
}

async function findClient(book: ReturnType<Page["getByRole"]>, query: string) {
  await book.getByRole("textbox", { name: "Find an existing client" }).fill(query);
  await book.getByRole("button", { name: "Find client", exact: true }).click();
}

test.describe("Receptionist desk: finder, booking and isolation", () => {
  test.setTimeout(T * 4);

  test("the finder shows the approved name and masked contact hints, never the full contact or the account name", async ({ page }) => {
    const f = await seedDeskFixture();
    await signInAsDesk(page, f.studio);
    const book = await openBookingForMember(page, f);

    await findClient(book, "Vale");
    const found = book.getByRole("button", { name: /^Morgan Vale/ });
    await expect(found).toBeVisible({ timeout: T });
    const hint = (await found.innerText()).replace(/\s+/g, " ");
    expect(hint, "a masked email hint").toMatch(/•••@.{2}….{3}/);
    expect(hint, "a masked phone hint: the last four digits only").toContain("•••0188");

    const panel = await book.innerText();
    expect(panel).not.toContain(f.returningEmail);
    expect(panel).not.toContain("5550188");
    expect(panel).not.toContain("Morgan Account");
    const html = await page.content();
    expect(html).not.toContain(f.returningEmail);
    expect(html).not.toContain("Morgan Account");

    // Only the approved name, the email and the phone digits are searchable; the account name is not.
    await findClient(book, "Account");
    await expect(book.getByRole("button", { name: /^Morgan Vale/ })).toHaveCount(0);
  });

  test("a booking lands on the chosen practitioner and, after a refresh, exactly one booking shows on that practitioner's calendar", async ({ page }) => {
    const f = await seedDeskFixture();
    await signInAsDesk(page, f.studio);
    const book = await openBookingForMember(page, f);
    await findClient(book, "Vale");
    await book.getByRole("button", { name: /^Morgan Vale/ }).click();
    await page.getByRole("button", { name: "Book appointment for Morgan Vale" }).click();

    await expect
      .poll(async () => (await sql("select 1 from public.appointments where studio_id=$1 and client_id=$2", [f.studio.studioId, f.returningClientId])).length, { timeout: 30_000 })
      .toBe(1);
    const [row] = await sql<{ practitioner_id: string; created_by_receptionist_id: string | null }>(
      "select practitioner_id, created_by_receptionist_id from public.appointments where studio_id=$1 and client_id=$2",
      [f.studio.studioId, f.returningClientId],
    );
    expect(row.practitioner_id, "booked for the practitioner the receptionist chose").toBe(f.member.practitionerId);
    expect(row.created_by_receptionist_id, "attributed to the receptionist").not.toBeNull();

    // Let the booking's own update finish (the new visit renders) before refreshing, so the refresh cannot be interrupted by that navigation.
    await expect(page.getByRole("button", { name: /Morgan Vale/ })).toHaveCount(1, { timeout: T });
    for (const round of [1, 2]) {
      await page.reload();
      await expect(page.getByRole("button", { name: /Ari Rowan/ })).toBeVisible({ timeout: T });
      await expect(page.getByRole("button", { name: /Morgan Vale/ }), `exactly one booking after refresh ${round}`).toHaveCount(1);
    }
    // On the member's calendar and not the owner's: hide each practitioner in turn.
    const owner = page.getByRole("checkbox", { name: /E2E Owner/ });
    const member = page.getByRole("checkbox", { name: f.member.displayName });
    await owner.uncheck();
    await expect(page.getByRole("button", { name: /Morgan Vale/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Ari Rowan/ })).toHaveCount(0);
    await owner.check();
    await member.uncheck();
    await expect(page.getByRole("button", { name: /Morgan Vale/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Ari Rowan/ })).toHaveCount(1);
    expect((await sql("select 1 from public.appointments where studio_id=$1 and client_id=$2", [f.studio.studioId, f.returningClientId])).length, "still one row").toBe(1);
  });

  test("called directly, every desk command refuses another studio (42501); once removed, the receptionist is refused on their own studio too", async ({ page }) => {
    const f = await seedDeskFixture();
    const userId = await signInAsDesk(page, f.studio);
    const from = new Date(Date.now() + 86_400_000).toISOString();
    const to = new Date(Date.now() + 14 * 86_400_000).toISOString();

    const refused = async (label: string, run: (c: Client) => Promise<unknown>) => {
      const r = await asReceptionist(userId, run);
      expect(r.ok, `${label}: another studio is refused`).toBe(false);
      if (!r.ok) expect(r.code, `${label}: not_authorized`).toBe("42501");
    };
    await refused("calendar", (c) => c.query("select * from public.receptionist_calendar_v3($1,$2,$3)", [f.other.studioId, from, to]));
    await refused("client finder", (c) => c.query("select * from public.receptionist_booking_clients_v3($1,'Other',5)", [f.other.studioId]));
    await refused("appointment contact", (c) => c.query("select * from public.receptionist_appointment_contact($1,$2)", [f.other.studioId, f.otherAppointmentId]));
    await refused("book an opening", (c) =>
      c.query("select public.receptionist_book_opening($1,$2,$3,$4,$5,$6)", [f.other.studioId, f.otherClientId, f.otherOwnerId, f.otherServiceId, from, to]),
    );

    // Controls: the same commands work on THEIR OWN studio, so the refusals above are about the studio and not a broken harness; and another studio's appointment
    // is not reachable through their own studio id either.
    const own = await asReceptionist(userId, (c) => c.query("select * from public.receptionist_booking_clients_v3($1,'Vale',5)", [f.studio.studioId]));
    expect(own.ok, "own studio works").toBe(true);
    const crossed = await asReceptionist(userId, (c) => c.query("select * from public.receptionist_appointment_contact($1,$2)", [f.studio.studioId, f.otherAppointmentId]));
    expect(crossed.ok && (crossed.value as { rowCount: number }).rowCount, "another studio's appointment through their own studio id returns nothing").toBe(0);

    // Removed (the owner's Deactivate is exercised in receptionist-onboarding-flow.spec.ts; the database rule is asserted here).
    await sql("update public.studio_receptionists set active=false, deactivated_at=now() where studio_id=$1 and user_id=$2", [f.studio.studioId, userId]);
    const removed = await asReceptionist(userId, (c) => c.query("select * from public.receptionist_calendar_v3($1,$2,$3)", [f.studio.studioId, from, to]));
    expect(removed.ok, "a removed receptionist is refused on their own studio").toBe(false);
    await expectPathRefused(page, "/desk");
  });
});
