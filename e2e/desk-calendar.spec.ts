import { test, expect } from "@playwright/test";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { markResendLedger, readResendLedger } from "./helpers/resend-ledger";
import {
  createLocalAuthUser, getE2eServiceId, getOwnerPractitionerId, seedE2eClient,
  seedE2eMember, seedE2eStudio, sql,
} from "./helpers/seed";

test("reception sees client names, opens contact details, and books an afternoon visit from the studio calendar", async ({ page }) => {
  const studio = await seedE2eStudio();
  const member = await seedE2eMember(studio);
  const ownerId = await getOwnerPractitionerId(studio.studioId);
  const serviceId = await getE2eServiceId(studio.studioId);
  const { clientId } = await seedE2eClient(studio);
  const clientName = "Ari Rowan";
  const phone = "+14165550188";
  const { clientId: returningId } = await seedE2eClient(studio);
  const returningName = "Morgan Vale";
  const returningEmail = `returning-${studio.runId}@harness.local`;
  await sql("update public.clients set name=$2, preferred_name=null, email=$3 where id=$1", [returningId, returningName, returningEmail]);
  await sql("update public.clients set name = 'Ari Account', preferred_name = $2, email = $3, phone = $4 where id = $1",
    [clientId, clientName, studio.clientEmail, phone]);
  const [{ local_day: date }] = await sql<{ local_day: string }>(`
    with slot as (
      select ((now() at time zone timezone)::date + 1 + time '13:00') at time zone timezone as starts, timezone
      from public.studios where id = $1
    ), booked as (
      insert into public.appointments (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        blocked_ends_at, duration_minutes, buffer_minutes_snapshot, status)
      select $1, $2, $3, $4, starts, starts + interval '30 minutes', starts + interval '30 minutes', 30, 0, 'confirmed' from slot
      returning starts_at
    )
    select to_char(booked.starts_at at time zone slot.timezone, 'YYYY-MM-DD') as local_day from booked, slot
  `, [studio.studioId, ownerId, clientId, serviceId]);

  const deskEmail = `desk-${studio.runId}@harness.local`;
  const user = await createLocalAuthUser(deskEmail);
  await sql("insert into public.studio_receptionists (studio_id,user_id,display_name,active) values ($1,$2,'Front desk',true)", [studio.studioId, user]);
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(deskEmail);
  const seen = await listMessageIds(deskEmail);
  await page.getByRole("button", { name: /send magic link/i }).click();
  await page.goto(await waitForMagicLink(deskEmail, E2E_APP_ORIGIN, { excludeIds: seen }));
  await page.getByRole("link", { name: "Open the front desk" }).click();
  await page.waitForURL(/\/desk(?:\?|$)/);

  await page.goto(`/desk?view=month&date=${date}`);
  const visit = page.getByRole("button", { name: /Ari Rowan/ });
  await expect(visit).toBeVisible();
  await expect(page.getByText("Ari Account")).toHaveCount(0);
  await expect(page.getByText(studio.clientEmail)).toHaveCount(0);
  await visit.click();
  const details = page.getByRole("dialog", { name: "Appointment details" });
  await expect(details).toContainText(clientName);
  await expect(details).toContainText(studio.serviceName);
  await expect(details).toContainText(studio.clientEmail);
  await expect(details).toContainText(phone);
  await details.getByRole("button", { name: "Close" }).click();

  // Tomorrow has one owner visit and zero for the member. Filtering the owner
  // out must clear that visit; the empty practitioner's calendar remains usable.
  const owner = page.getByRole("checkbox", { name: /E2E Owner/ });
  await owner.uncheck();
  await expect(visit).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: member.displayName })).toBeChecked();
  await owner.check();

  for (const mode of ["Week", "Day", "Month"]) {
    await page.getByRole("link", { name: mode, exact: true }).click();
    // Wait for the navigation itself: the visit is already visible on the old view, and a late commit would reset an open booking panel.
    await expect(page).toHaveURL(new RegExp(`view=${mode.toLowerCase()}`));
    await expect(visit.first()).toBeVisible();
  }
  await page.getByRole("button", { name: "Find an opening", exact: true }).first().click();
  const book = page.getByRole("region", { name: "Desk booking" });
  await expect(book.getByLabel("From", { exact: true })).toHaveValue(date);
  await book.getByRole("combobox", { name: "Service", exact: true }).selectOption(serviceId);
  await book.getByRole("combobox", { name: "Time of day", exact: true }).selectOption({ label: "Noon onward" });
  await book.getByRole("button", { name: "Search availability" }).click();
  await expect(book.getByRole("heading", { name: "First opening per practitioner" })).toBeVisible();
  await book.getByRole("button", { name: new RegExp(member.displayName) }).filter({ hasText: /PM/i }).first().click();
  await book.getByRole("textbox", { name: "Find an existing client" }).fill("Vale");
  await book.getByRole("button", { name: "Find client", exact: true }).click();
  await book.getByRole("button", { name: /^Morgan Vale/ }).click();

  const writes = () => sql<{ id: string }>(
    "select id from public.appointments where studio_id=$1 and client_id=$2 and practitioner_id=$3 and created_by_receptionist_id is not null",
    [studio.studioId, returningId, member.practitionerId],
  );
  expect(await writes()).toHaveLength(0);
  const mail = markResendLedger();
  await page.getByRole("button", { name: "Book appointment for Morgan Vale" }).click();
  await expect.poll(async () => (await writes()).length).toBe(1);
  await expect(visit).toBeVisible();
  const added = page.getByRole("button", { name: /Morgan Vale/ });
  await expect(added).toBeVisible();
  await added.click();
  await expect(details).toContainText(returningName);
  await expect(details).toContainText(returningEmail);
  expect(readResendLedger(mail).filter(message => message.to === returningEmail)).toEqual([]);
});
