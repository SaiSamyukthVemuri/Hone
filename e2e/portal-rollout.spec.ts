import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { loginAsOwner } from "./helpers/flows";
import { markResendLedger, readResendLedger } from "./helpers/resend-ledger";
import {
  getAppointmentsForClient, getCancellationToken, seedE2eActiveCardOnFile,
  seedE2eDashboardClient, seedE2eStudio, seedE2eTodayAppointment, sql,
  type E2eSeed,
} from "./helpers/seed";

async function portalLink(seed: E2eSeed, clientId: string, expired = false) {
  // Start at the email boundary: only the hash exists in the local database.
  // From the original URL onward the app performs its real GET / POST exchange.
  const raw = randomBytes(32).toString("base64url");
  const stored = await sql(
    `insert into public.client_portal_magic_links
       (studio_id, client_id, email_normalized, token_hash, expires_at)
     select studio_id, id, normalized_email, $3,
            now() + ($4::integer * interval '1 hour')
       from public.clients where studio_id = $1 and id = $2 returning id`,
    [seed.studioId, clientId, createHash("sha256").update(raw).digest("hex"), expired ? -1 : 1],
  );
  expect(stored).toHaveLength(1);
  return `/portal/verify/${raw}`;
}

async function enterPortal(page: Page, link: string) {
  await page.goto(link);
  await page.getByRole("button", { name: /continue to portal/i }).click();
  await expect(page).toHaveURL(/\/portal$/);
}

async function checkActiveSession(page: Page, previousToken?: string) {
  const cookie = (await page.context().cookies()).find((entry) => entry.name === "hone_portal_session");
  expect(Boolean(cookie?.value), "Client is still signed in").toBe(true);
  // Compare without echoing the session token to the browser test report.
  if (previousToken) expect(cookie!.value === previousToken, "Original session was preserved").toBe(true);
  return cookie!.value;
}

async function reschedule(page: Page, studioId: string, originalId: string) {
  const token = await getCancellationToken(studioId, originalId);
  expect(Boolean(token), "Fixture appointment has a management link").toBe(true);
  await page.goto(`/reschedule/${token}`);
  const input = page.getByLabel("Pick a new date");
  const day = new Date(`${await input.inputValue()}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 9);
  await input.fill(day.toISOString().slice(0, 10));
  await page.getByRole("button", { name: /^\d{1,2}:\d{2} (AM|PM)$/ }).first().click();
  const acknowledge = page.getByRole("checkbox");
  if (await acknowledge.isVisible()) await acknowledge.check();
  await page.getByRole("button", { name: /confirm new time/i }).click();
  await expect(page.getByText(/You.re rescheduled\./i)).toBeVisible();
}

async function assertAppointment(page: Page, appointment: { id: string; starts_at: string }) {
  const item = page.locator(`[data-portal-appointment-id="${appointment.id}"]`);
  await expect(item).toHaveCount(1);
  await expect(item).toBeVisible();
  const time = item.locator("time[datetime]").first();
  await expect(time).toBeVisible();
  expect(new Date((await time.getAttribute("datetime"))!).getTime()).toBe(new Date(appointment.starts_at).getTime());
}

test("original link shows the rescheduled visit once across an owner publish and rollback", async ({
  page, context, browser, baseURL,
}, info) => {
  test.setTimeout(180_000);
  const pilotStudioId = process.env.HONE_E2E_PORTAL_PILOT_STUDIOS?.split(",")[info.retry];
  if (!pilotStudioId) throw new Error("The portal pilot fixture must be registered on the local app server.");
  const studio = await seedE2eStudio(pilotStudioId);
  const { clientId, name } = await seedE2eDashboardClient(studio, { label: "Returning client" });
  const { appointmentId } = await seedE2eTodayAppointment(studio, {
    clientId, startsMinutesFromNow: 7 * 1440, endsMinutesFromNow: 7 * 1440 + 30, withService: true,
  });
  const title = `Treatment consent ${studio.runId}`;
  await sql(
    `insert into public.consent_form_templates (studio_id, title, body, form_type, version, status, is_live)
     values ($1,$2,'Synthetic consent text for the original client.','treatment_consent',1,'active',true)`,
    [studio.studioId, title],
  );
  const message = `A note from your studio ${studio.runId}`;
  await sql(
    `insert into public.client_portal_messages
       (studio_id, client_id, created_by_practitioner_id, subject, body)
     select studio_id, $2, id, $3, 'Your appointment details are available.'
       from public.practitioners where studio_id = $1 and role = 'owner'`,
    [studio.studioId, clientId, message],
  );
  await seedE2eActiveCardOnFile(studio, clientId);
  const originalLink = await portalLink(studio, clientId);
  await enterPortal(page, originalLink);
  const originalSession = await checkActiveSession(page);
  await expect(page.getByTestId("studio-portal")).toHaveCount(0);
  await assertAppointment(page, (await getAppointmentsForClient(studio.studioId, clientId))[0]);

  // A pre-rollout signature must survive both layouts with the same version and signature.
  await page.locator("li").filter({ hasText: title }).getByRole("button", { name: "Review and sign" }).click();
  await page.getByLabel("Type your full name to sign").fill(name);
  await page.getByRole("checkbox", { name: "I have read and agree to this form." }).check();
  await page.getByRole("button", { name: "Sign form" }).click();
  const signature = () => sql<{ id: string; template_version: number }>(
    "select id, template_version from public.client_consent_signatures where studio_id = $1 and client_id = $2",
    [studio.studioId, clientId],
  );
  await expect.poll(async () => (await signature()).length).toBe(1);
  const [signed] = await signature();

  const owner = await browser.newContext({ baseURL });
  const otherStudio = await browser.newContext({ baseURL });
  const firstTime = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const ownerPage = await owner.newPage();
    await loginAsOwner(ownerPage, studio);
    await ownerPage.goto("/settings/studio/client-portal");
    const welcome = `Your visit at ${studio.studioName}`;
    await ownerPage.getByLabel("Welcome heading").fill(welcome);
    await ownerPage.getByRole("button", { name: "Save draft" }).click();
    await expect(ownerPage.getByText("Draft saved.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("studio-portal")).toHaveCount(0);
    await ownerPage.getByRole("button", { name: "Preview as client" }).click();
    await expect(ownerPage.getByRole("heading", { name: welcome })).toBeVisible();
    await ownerPage.getByRole("button", { name: "Publish portal" }).click();
    await expect(ownerPage.getByText("Portal published.", { exact: true })).toBeVisible();

    await page.goto(originalLink);
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByTestId("studio-portal")).toBeVisible();
    await expect(page.getByRole("heading", { name: welcome })).toBeVisible();
    await checkActiveSession(page, originalSession);

    // The reschedule form writes a cancelled original and a confirmed successor.
    const managePage = await context.newPage();
    await reschedule(managePage, studio.studioId, appointmentId);
    const visits = await getAppointmentsForClient(studio.studioId, clientId);
    expect(visits).toHaveLength(2);
    expect(visits.find((appointment) => appointment.id === appointmentId)?.status).toBe("cancelled");
    const confirmed = visits.filter((appointment) => appointment.status === "confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].id).not.toBe(appointmentId);
    expect(new Date(confirmed[0].starts_at).getTime()).not.toBe(
      new Date(visits.find((appointment) => appointment.id === appointmentId)!.starts_at).getTime(),
    );
    await page.goto(originalLink);
    await expect(page).toHaveURL(/\/portal$/);
    await assertAppointment(page, confirmed[0]);
    await expect(page.locator(`[data-portal-appointment-id="${appointmentId}"]`)).toHaveCount(0);
    await page.goto("/portal?view=records");
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByText(/visa ending in 4242/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Replace card" })).toBeVisible();

    const newClient = await seedE2eDashboardClient(studio, { label: "First visit" });
    const firstPage = await firstTime.newPage();
    await enterPortal(firstPage, await portalLink(studio, newClient.clientId));
    await expect(firstPage.getByTestId("studio-portal")).toBeVisible();
    await firstPage.getByRole("link", { name: "Review forms" }).click();
    await expect(firstPage).toHaveURL(/view=records#portal-tasks$/);
    await expect(firstPage.getByRole("button", { name: "Review and sign" })).toBeVisible();
    await expect(firstPage.getByText(message, { exact: true })).toHaveCount(0);
    await expect(firstPage.getByText(/visa ending in 4242/i)).toHaveCount(0);

    const control = await seedE2eStudio();
    const controlClient = await seedE2eDashboardClient(control, { label: "Other studio" });
    await sql(
      `update public.clients set email = (select email from public.clients where studio_id=$1 and id=$2)
       where studio_id=$3 and id=$4`,
      [studio.studioId, clientId, control.studioId, controlClient.clientId],
    );
    const other = await otherStudio.newPage();
    await enterPortal(other, await portalLink(control, controlClient.clientId));
    await expect(other.getByTestId("studio-portal")).toHaveCount(0);
    await expect(other.getByText(control.studioName, { exact: true }).first()).toBeVisible();
    await expect(other.getByText(welcome, { exact: true })).toHaveCount(0);
    await expect(other.getByText(message, { exact: true })).toHaveCount(0);

    // Same registered mailbox, different tenant and session: an old A link
    // opened in B must not expose either portal or silently switch tenants.
    await other.goto(originalLink);
    await expect(other.getByRole("button", { name: "Email me a new link" })).toBeVisible();
    await expect(other.getByTestId("studio-portal")).toHaveCount(0);
    await other.goto("/portal");
    await expect(other.getByText(control.studioName, { exact: true }).first()).toBeVisible();

    await ownerPage.getByRole("button", { name: "Switch to classic" }).click();
    await expect(ownerPage.getByText("Classic portal restored. Your draft is saved.", { exact: true })).toBeVisible();
    await page.goto(originalLink);
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByTestId("studio-portal")).toHaveCount(0);
    await checkActiveSession(page, originalSession);
    await assertAppointment(page, confirmed[0]);
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByText(/visa ending in 4242/i)).toBeVisible();
    expect(await signature()).toEqual([signed]);
    const [unread] = await sql<{ client_reviewed_at: Date | null }>(
      "select client_reviewed_at from public.client_portal_messages where studio_id=$1 and client_id=$2",
      [studio.studioId, clientId],
    );
    expect(unread.client_reviewed_at).toBeNull();
  } finally {
    await Promise.all([owner.close(), firstTime.close(), otherStudio.close()]);
  }
});

test("an expired link sends one fresh link to the registered address and never signs in the browser", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eDashboardClient(seed, { label: "Returning" });
  // Only this synthetic recipient opts into success on the in-process fake provider.
  const email = `success+${clientId}@harness.local`;
  await sql("update public.clients set email = $1 where id = $2", [email, clientId]);
  const expired = await portalLink(seed, clientId, true);
  const mark = markResendLedger();
  await page.goto(expired);
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
  expect(readResendLedger(mark).filter((mail) => mail.to === email)).toHaveLength(0);
  await page.getByRole("button", { name: "Email me a new link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect.poll(() => readResendLedger(mark).filter((mail) => mail.to === email && mail.mode === "success").length).toBe(1);
  const links = await sql(
    `select id from public.client_portal_magic_links
      where client_id = $1 and studio_id = $2 and expires_at > now() and consumed_at is null`,
    [clientId, seed.studioId],
  );
  expect(links).toHaveLength(1);
  expect((await page.context().cookies()).some((cookie) => cookie.name === "hone_portal_session")).toBe(false);
  await page.goto("/portal");
  await expect(page).toHaveURL(/\/portal\/login/);
});
