import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { loginByMagicLink } from "./helpers/flows";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import {
  getOwnerPractitionerId,
  seedE2eMember,
  seedE2eStudio,
  seedOperatorAuthUser,
  sql,
  type E2eSeed,
} from "./helpers/seed";

// ===========================================================================
// DELIVERY-VISIBILITY-02 — the owner's "Message delivery" card and the
// platform support queue, in a real browser against a real stack.
//
//   * The OWNER sees each open incident once, with a count, what it means and
//     the next step, and no client name or address.
//   * A practitioner of the same studio gets no card; another studio's owner
//     sees only their own studio (permission denial and studio isolation, as
//     the database enforces them).
//   * An owner whose read FAILS sees "unavailable / unknown", never "no
//     problems".
//   * Support resolves an incident from /admin/delivery; the resolution is
//     audited; an owner cannot open the queue.
//
// Incidents are made the way production makes them: failed attempts written
// through the ledger commands (0212), whose trigger opens the incident (0215).
// No provider is involved. The Sentry tunnel is fulfilled locally.
// ===========================================================================

const LAUNCH = "/settings/launch";
const CARD = () => (page: Page) => page.locator("section[aria-labelledby='owner-delivery-heading']");

async function fenceSentry(page: Page): Promise<void> {
  await page.route("**/monitoring**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

async function seedAppointment(s: E2eSeed): Promise<string> {
  const practitionerId = await getOwnerPractitionerId(s.studioId);
  const client = await sql<{ id: string }>(
    `insert into public.clients (studio_id, name, email) values ($1, $2, $3) returning id`,
    [s.studioId, s.clientName, s.clientEmail],
  );
  const appt = await sql<{ id: string }>(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at, status)
     values (gen_random_uuid(), $1, $2, $3,
             now() + interval '30 hours', now() + interval '31 hours', 60, 0,
             now() + interval '31 hours', 'confirmed')
     returning id`,
    [s.studioId, client[0]!.id, practitionerId],
  );
  return appt[0]!.id;
}

/** Three refused 24h reminders (one incident, 3 occurrences) and one bounced 2h reminder. */
async function seedIncidents(s: E2eSeed): Promise<void> {
  const appt = await seedAppointment(s);
  for (let i = 0; i < 3; i++) {
    const [row] = await sql<{ id: string }>(
      `select public.begin_appointment_email_message($1, $2, 'appointment_reminder_24h') as id`,
      [s.studioId, appt],
    );
    await sql(`select public.settle_email_message($1, 'refused', null, 'validation_error', null)`, [row!.id]);
  }
  const [bounced] = await sql<{ id: string }>(
    `select public.begin_appointment_email_message($1, $2, 'appointment_reminder_2h') as id`,
    [s.studioId, appt],
  );
  const emailId = randomUUID();
  await sql(`select public.settle_email_message($1, 'accepted', $2, null, null)`, [bounced!.id, emailId]);
  const [receipt] = await sql<{ receipt_id: string }>(
    `select * from public.record_email_provider_event($1, 'email.bounced', $2, $3, now(), 'permanent', 'no_email', null, null)`,
    [`msg_${randomUUID().replace(/-/g, "")}`, emailId, bounced!.id],
  );
  await sql(`select * from public.process_email_provider_event($1)`, [receipt!.receipt_id]);
}

test.describe("owner delivery card", () => {
  test.beforeEach(async ({ page }) => fenceSentry(page));

  test("the owner sees each problem once, with a count, its meaning and the next step, and no client details", async ({
    page,
  }) => {
    const s = await seedE2eStudio();
    await seedIncidents(s);
    await loginByMagicLink(page, s.ownerEmail);
    await page.goto(LAUNCH);

    const card = CARD()(page);
    await expect(card.getByRole("heading", { name: "Message delivery" })).toBeVisible();
    await expect(card.getByText("2 open delivery problems.", { exact: false })).toBeVisible();
    await expect(card.getByText("24-hour reminder email not delivered")).toBeVisible();
    await expect(card.getByText("3 times")).toBeVisible();
    await expect(card.getByText("2-hour reminder email not delivered")).toBeVisible();
    await expect(card.getByText("The client's mail server rejected the email.")).toBeVisible();
    await expect(card.getByText("Check the client's email address with them and update it.")).toBeVisible();
    // Truthful about what it cannot see yet (no webhook secret in this lane).
    await expect(card.getByText(/Email bounce reports are not switched on yet/)).toBeVisible();
    const text = await card.innerText();
    expect(text).not.toContain(s.clientName);
    expect(text).not.toContain(s.clientEmail);
  });

  test("a practitioner of the same studio gets no card, and another studio's owner sees only their own", async ({
    browser,
  }) => {
    const a = await seedE2eStudio();
    const b = await seedE2eStudio();
    await seedIncidents(a);
    const member = await seedE2eMember(a);

    const memberPage = await (await browser.newContext()).newPage();
    await fenceSentry(memberPage);
    await loginByMagicLink(memberPage, member.email);
    await memberPage.goto(LAUNCH);
    await expect(memberPage.getByRole("heading", { name: /ready for booking checklist/i })).toBeVisible();
    await expect(CARD()(memberPage)).toHaveCount(0);

    const ownerB = await (await browser.newContext()).newPage();
    await fenceSentry(ownerB);
    await loginByMagicLink(ownerB, b.ownerEmail);
    await ownerB.goto(LAUNCH);
    const cardB = CARD()(ownerB);
    await expect(cardB.getByText("No delivery problems reported in the last 14 days.")).toBeVisible();
    await expect(cardB.getByText(/not delivered/)).toHaveCount(0);
  });

  test("an owner whose read fails sees UNKNOWN, never 'no problems'", async ({ page }) => {
    const s = await seedE2eStudio();
    await loginByMagicLink(page, s.ownerEmail);
    await page.goto(LAUNCH);
    await expect(CARD()(page).getByText("No delivery problems reported in the last 14 days.")).toBeVisible();

    // Make the owner's read fail with something other than a permission
    // denial: the function disappears from the API for a moment.
    await sql(`alter function public.owner_delivery_incidents(uuid) rename to owner_delivery_incidents_e2e_hidden`);
    await sql(`notify pgrst, 'reload schema'`);
    try {
      await expect(async () => {
        await page.reload();
        await expect(CARD()(page).getByText(/Delivery status is unavailable right now/)).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await expect(CARD()(page).getByText(/unknown whether any messages failed/)).toBeVisible();
      await expect(CARD()(page).getByText("No delivery problems reported in the last 14 days.")).toHaveCount(0);
    } finally {
      await sql(`alter function public.owner_delivery_incidents_e2e_hidden(uuid) rename to owner_delivery_incidents`);
      await sql(`notify pgrst, 'reload schema'`);
    }
    await expect(async () => {
      await page.reload();
      await expect(CARD()(page).getByText("No delivery problems reported in the last 14 days.")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  });
});

test.describe("platform support queue", () => {
  test.beforeEach(async ({ page }) => fenceSentry(page));

  test("support sees the studio's incidents and resolves one, audited; an owner cannot open the queue", async ({
    page,
    browser,
  }) => {
    const s = await seedE2eStudio();
    await seedIncidents(s);

    const ownerPage = await (await browser.newContext()).newPage();
    await fenceSentry(ownerPage);
    await loginByMagicLink(ownerPage, s.ownerEmail);
    await ownerPage.goto("/admin/delivery");
    await ownerPage.waitForURL(/\/dashboard/, { timeout: 20_000 });

    const { email: operatorEmail } = await seedOperatorAuthUser();
    await page.goto("/login");
    await page.getByLabel("I am using my invited email address").check();
    await page.locator("#login-email").fill(operatorEmail);
    const seen = await listMessageIds(operatorEmail);
    await page.getByRole("button", { name: /send magic link/i }).click();
    await page.goto(await waitForMagicLink(operatorEmail, E2E_APP_ORIGIN, { excludeIds: seen }));

    await page.goto("/admin/delivery");
    await expect(page.getByRole("heading", { name: "Message delivery", level: 1 })).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: s.studioName }).filter({ hasText: "24-hour reminder email not delivered" });
    await expect(row).toBeVisible();
    await expect(row.getByText("3×")).toBeVisible();
    await expect(row.getByText("Hone to act")).toBeVisible();

    await row.getByLabel("Resolution").selectOption("acknowledged");
    await row.getByRole("button", { name: "Resolve" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: s.studioName }).filter({ hasText: "24-hour reminder email not delivered" })).toHaveCount(0);

    const resolved = await sql<{ resolution: string }>(
      `select resolution from public.delivery_incidents
        where studio_id = $1 and purpose = 'appointment_reminder_24h' and resolved_at is not null`,
      [s.studioId],
    );
    expect(resolved.map((r) => r.resolution)).toEqual(["acknowledged"]);
    const audit = await sql<{ outcome: string }>(
      `select outcome from public.admin_action_events
        where action = 'delivery_incident_resolved' and lower(actor_email) = lower($1)
        order by created_at desc limit 1`,
      [operatorEmail],
    );
    expect(audit[0]?.outcome).toBe("succeeded");

    // The owner's card follows: one open problem left.
    await ownerPage.goto(LAUNCH);
    await expect(CARD()(ownerPage).getByText("1 open delivery problem.", { exact: false })).toBeVisible();
  });
});

test.describe("client says they didn't receive it (DELIVERY-VISIBILITY-04)", () => {
  test.beforeEach(async ({ page }) => fenceSentry(page));

  test("the owner reports it on the appointment, support sees what the ledger said and closes it; a practitioner gets no form", async ({
    page,
    browser,
  }) => {
    const s = await seedE2eStudio();
    const appt = await seedAppointment(s);
    // The reminder was accepted by the provider and later reported delivered.
    const [row] = await sql<{ id: string }>(
      `select public.begin_appointment_email_message($1, $2, 'appointment_reminder_24h') as id`,
      [s.studioId, appt],
    );
    const emailId = randomUUID();
    await sql(`select public.settle_email_message($1, 'accepted', $2, null, null)`, [row!.id, emailId]);
    const [receipt] = await sql<{ receipt_id: string }>(
      `select * from public.record_email_provider_event($1, 'email.delivered', $2, $3, now(), null, null, null, null)`,
      [`msg_${randomUUID().replace(/-/g, "")}`, emailId, row!.id],
    );
    await sql(`select * from public.process_email_provider_event($1)`, [receipt!.receipt_id]);

    const member = await seedE2eMember(s);
    const memberPage = await (await browser.newContext()).newPage();
    await fenceSentry(memberPage);
    await loginByMagicLink(memberPage, member.email);
    await memberPage.goto(`/calendar/${appt}`);
    await expect(memberPage.getByText(/Client says they didn.t receive a message/)).toHaveCount(0);

    await loginByMagicLink(page, s.ownerEmail);
    await page.goto(`/calendar/${appt}`);
    await page.getByText(/Client says they didn.t receive a message/).click();
    await page.getByLabel("Which message?").selectOption("email:appointment_reminder_24h");
    await page.getByRole("button", { name: "Report to Hone support" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Reported." })).toContainText(
      "the provider reported it delivered to the client's mail server or carrier (not that it was seen)",
    );
    // The delivery record itself is unchanged.
    const [m] = await sql<{ status: string }>(`select status from public.email_outbound_messages where id = $1`, [row!.id]);
    expect(m!.status).toBe("delivered");

    await page.goto(LAUNCH);
    await expect(CARD()(page).getByText(/client says they did not receive it \(1 open\)/)).toBeVisible();

    const { email: operatorEmail } = await seedOperatorAuthUser();
    const support = await (await browser.newContext()).newPage();
    await fenceSentry(support);
    await support.goto("/login");
    await support.getByLabel("I am using my invited email address").check();
    await support.locator("#login-email").fill(operatorEmail);
    const seen = await listMessageIds(operatorEmail);
    await support.getByRole("button", { name: /send magic link/i }).click();
    await support.goto(await waitForMagicLink(operatorEmail, E2E_APP_ORIGIN, { excludeIds: seen }));
    await support.goto("/admin/delivery");
    const concern = support.getByRole("listitem").filter({ hasText: s.studioName }).filter({ hasText: "24-hour reminder email" }).filter({ hasText: "When reported" });
    await expect(concern).toContainText("When reported, the provider reported it delivered");
    await concern.getByLabel("Concern resolution").selectOption("explained");
    await concern.getByRole("button", { name: "Close concern" }).click();
    await expect(concern).toHaveCount(0);

    const closed = await sql<{ state: string; resolution: string }>(
      `select state, resolution from public.delivery_concerns where appointment_id = $1`,
      [appt],
    );
    expect(closed).toEqual([{ state: "closed", resolution: "explained" }]);
    const audit = await sql<{ outcome: string }>(
      `select outcome from public.admin_action_events
        where action = 'delivery_concern_closed' and lower(actor_email) = lower($1)
        order by created_at desc limit 1`,
      [operatorEmail],
    );
    expect(audit[0]?.outcome).toBe("succeeded");
  });
});
