import { test, expect, type Browser, type Page } from "@playwright/test";
import { getAppointmentInterval, seedE2eStudio, createLocalAuthUser, getOwnerPractitionerId, seedConfirmedAppointment, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { E2E_APP_ORIGIN, E2E_WEB_SERVER_ENV } from "./helpers/local-env";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";

// The owner's Team-page front-desk flow end to end, through the REAL UI (Sam, 2 Nov): owner invites -> receptionist accepts
// -> owner removes -> the SAME cookie is refused; an OLD invitation for the removed person is refused afterwards (0279);
// a receptionist BOOKS an appointment at the desk, then loses access (OPS HON-18); a pending invitation's Revoke works; and after a move the schedule row's Move and Cancel buttons return (Privacy C3).
//
// HELD like receptionist-removal.spec.ts: the app server must run with HONE_RECEPTIONIST_DESK_ENABLED=true, which the lanes never
// set; it self-skips everywhere except a dedicated run on an OWNED isolated stack (OPS heavy slot). Synthetic data only; no real
// invitation, mailbox or account. Needs migration 0279 on that stack (it is in the tree, so a fresh local reset has it).
const DESK_ON = E2E_WEB_SERVER_ENV.HONE_RECEPTIONIST_DESK_ENABLED === "true";
test.beforeEach(() => {
  test.skip(!DESK_ON, "the desk is OFF on this server (HONE_RECEPTIONIST_DESK_ENABLED is not true)");
});

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  await page.goto(await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen }));
}

async function acceptAsReceptionist(page: Page): Promise<void> {
  await page.waitForURL(/\/accept-invitation/, { timeout: 30_000 });
  await page.getByRole("checkbox", { name: /I agree to the current Terms/ }).check();
  await page.getByRole("button", { name: /as receptionist/i }).click();
}

async function seedClient(studioId: string): Promise<{ id: string; name: string }> {
  const name = `Deskclient ${studioId.slice(0, 6)}`;
  const [c] = await sql<{ id: string }>("insert into public.clients (id, studio_id, name, email) values (gen_random_uuid(), $1, $2, $3) returning id", [studioId, name, `dc-${studioId.slice(0, 8)}@harness.local`]);
  return { id: c.id, name };
}

const rows = (studioId: string, email: string) =>
  sql<{ id: string; active: boolean }>("select id, active from public.studio_receptionists where studio_id=$1 and lower(email)=lower($2)", [studioId, email]);
const invitationStatuses = (studioId: string, email: string) =>
  sql<{ status: string }>("select status from public.pending_invitations where studio_id=$1 and lower(email)=lower($2) and role='receptionist' order by created_at", [studioId, email]);

async function ownerInvites(browser: Browser, s: Awaited<ReturnType<typeof seedE2eStudio>>, email: string, name: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAsOwner(page, s);
  await page.goto("/settings/team");
  await expect(page.getByRole("heading", { name: "Front desk" })).toBeVisible();
  const form = page.getByRole("form", { name: "Invite a receptionist" });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Display name").fill(name);
  await form.getByRole("button", { name: /invite receptionist/i }).click();
  await expect(page.getByRole("status").filter({ hasText: `Invitation created for ${email}` })).toBeVisible();
  return { ctx, page };
}

test("owner invites -> accepts -> owner removes in the UI -> same cookie refused -> an old invitation does NOT bring access back", async ({ browser }) => {
  const s = await seedE2eStudio();
  const email = `desk-${s.studioId.slice(0, 8)}@harness.local`;
  await createLocalAuthUser(email);

  const owner = await ownerInvites(browser, s, email, "Synthetic Desk");
  expect(await invitationStatuses(s.studioId, email)).toEqual([{ status: "pending" }]);
  expect(await rows(s.studioId, email)).toEqual([]); // an invitation alone grants nothing

  const deskCtx = await browser.newContext();
  const desk = await deskCtx.newPage();
  await signIn(desk, email);
  await acceptAsReceptionist(desk);
  await expect.poll(async () => (await rows(s.studioId, email)).filter((m) => m.active).length, { timeout: 30_000 }).toBe(1);
  await desk.goto("/desk");
  await expect(desk).toHaveURL(/\/desk/);
  await expect(desk.getByRole("heading", { level: 1 })).toBeVisible();

  // An older invitation for the same person is still outstanding when the owner removes them (a re-issued or forgotten one).
  await sql(`insert into public.pending_invitations (studio_id, email, role, display_name, status) values ($1,$2,'receptionist','Old invite','pending')`, [s.studioId, email]);

  // The owner removes the receptionist from the Team page; the flag is irrelevant to this control.
  await owner.page.goto("/settings/team");
  await owner.page.getByRole("button", { name: /Remove access for Synthetic Desk/ }).click();
  await expect(owner.page.getByText("No receptionist has access.")).toBeVisible();
  expect((await rows(s.studioId, email))[0].active).toBe(false);
  expect((await invitationStatuses(s.studioId, email)).every((x) => x.status !== "pending")).toBe(true);

  // The same cookie is refused.
  await desk.goto("/desk");
  await expect(desk).toHaveURL(/\/no-access|\/login/);
  await expect(desk.locator("body")).not.toContainText(s.studioName);

  // The old invitation link (= signing in with that address) offers nothing and reactivates nothing.
  const again = await browser.newContext();
  const page2 = await again.newPage();
  await signIn(page2, email);
  await page2.waitForLoadState("networkidle");
  expect(page2.url()).not.toMatch(/\/accept-invitation/);
  await page2.goto("/desk");
  await expect(page2).toHaveURL(/\/no-access|\/login/);
  expect((await rows(s.studioId, email))[0].active).toBe(false);
});

test("a pending receptionist invitation can be revoked from the Team page, and the invitee then gets nothing", async ({ browser }) => {
  const s = await seedE2eStudio();
  const email = `desk-rv-${s.studioId.slice(0, 8)}@harness.local`;
  await createLocalAuthUser(email);
  const owner = await ownerInvites(browser, s, email, "Revoked Desk");
  await owner.page.getByRole("button", { name: new RegExp(`Revoke the invitation for ${email}`) }).click();
  await expect(owner.page.getByText("No receptionist invitation is pending.")).toBeVisible();
  expect(await invitationStatuses(s.studioId, email)).toEqual([{ status: "revoked" }]);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email);
  await page.waitForLoadState("networkidle");
  expect(page.url()).not.toMatch(/\/accept-invitation/);
  expect(await rows(s.studioId, email)).toEqual([]);
});

test("after a successful move the row's Move and Cancel buttons return (Privacy C3)", async ({ browser }) => {
  const s = await seedE2eStudio();
  const email = `desk-mv-${s.studioId.slice(0, 8)}@harness.local`;
  await createLocalAuthUser(email);
  const practitionerId = await getOwnerPractitionerId(s.studioId);
  const client = await seedClient(s.studioId);
  const start = new Date(Date.now() + 26 * 3600_000);
  start.setUTCMinutes(0, 0, 0);
  const apptId = await seedConfirmedAppointment(s.studioId, practitionerId, client.id, start.toISOString(), new Date(start.getTime() + 3600_000).toISOString());
  const before = await getAppointmentInterval(apptId);
  await sql(`insert into public.pending_invitations (studio_id, email, role, display_name, status) values ($1,$2,'receptionist','Mover','pending')`, [s.studioId, email]);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email);
  await acceptAsReceptionist(page);
  await expect.poll(async () => (await rows(s.studioId, email)).filter((m) => m.active).length, { timeout: 30_000 }).toBe(1);
  await page.goto("/desk");
  const idle = page.locator("li").filter({ has: page.getByRole("button", { name: "Move", exact: true }) }).first();
  await expect(idle.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await idle.getByRole("button", { name: "Move", exact: true }).click();
  // The open form replaces the idle buttons, so the row is found again by its form.
  const row = page.locator("li").filter({ has: page.getByLabel("Start time") }).first();
  const time = row.getByLabel("Start time");
  const [h, m] = (await time.inputValue()).split(":").map(Number);
  await time.fill(`${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  await row.getByRole("button", { name: "Move appointment" }).click();
  // The move is proved in the database, not by the toast: the row is re-keyed on its new interval, so the one-line success
  // message does not survive the refresh (recorded as a finding, not a failure of the buttons).
  await expect.poll(async () => (await getAppointmentInterval(apptId))?.starts_at, { timeout: 30_000 }).not.toBe(before?.starts_at);
  expect((await getAppointmentInterval(apptId))?.status).toBe("confirmed");
  // The proof: the same appointment (still confirmed) offers Move and Cancel again.
  await expect(page.getByRole("button", { name: "Move", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible();
});

test("a receptionist invited and accepted through the UI BOOKS an appointment; after the owner removes them the same cookie cannot book or read", async ({ browser }) => {
  const s = await seedE2eStudio();
  const email = `desk-bk-${s.studioId.slice(0, 8)}@harness.local`;
  await createLocalAuthUser(email);
  const client = await seedClient(s.studioId);
  const apptCount = async () => Number((await sql<{ n: string }>("select count(*) n from public.appointments where studio_id=$1 and client_id=$2", [s.studioId, client.id]))[0].n);
  const before = await apptCount();

  const owner = await ownerInvites(browser, s, email, "Booking Desk");
  const deskCtx = await browser.newContext();
  const desk = await deskCtx.newPage();
  await signIn(desk, email);
  await acceptAsReceptionist(desk);
  await expect.poll(async () => (await rows(s.studioId, email)).filter((m) => m.active).length, { timeout: 30_000 }).toBe(1);

  // Book through the desk form: choose the client, a service and a practitioner, a day and time inside the seeded open window.
  await desk.goto("/desk/book");
  await desk.getByLabel("Search clients").fill(client.name.slice(0, 4));
  await desk.getByRole("button", { name: "Search", exact: true }).click();
  await desk.getByRole("button", { name: "Choose" }).first().click();
  await desk.getByLabel("Service").selectOption({ index: 1 });
  await desk.getByLabel("Practitioner").selectOption({ index: 1 });
  const day = new Date(Date.now() + 48 * 3600_000).toISOString().slice(0, 10);
  await desk.getByLabel("Date").fill(day);
  await desk.getByLabel("Start time").fill("10:00");
  await desk.getByRole("button", { name: "Book appointment" }).click();
  await expect(desk.getByRole("status").filter({ hasText: /on the schedule/i })).toBeVisible({ timeout: 30_000 });
  expect(await apptCount()).toBe(before + 1);

  // The owner removes the receptionist in the UI; the same cookie is then refused on the booking page and the schedule.
  await owner.page.goto("/settings/team");
  await owner.page.getByRole("button", { name: /Remove access for Booking Desk/ }).click();
  await expect(owner.page.getByText("No receptionist has access.")).toBeVisible();
  for (const path of ["/desk/book", "/desk"]) {
    await desk.goto(path);
    await expect(desk).toHaveURL(/\/no-access|\/login/);
    await expect(desk.locator("body")).not.toContainText(s.studioName);
  }
  expect(await apptCount()).toBe(before + 1); // nothing was booked after removal
});

test("an invitation the owner issues AFTER removal is deliberate re-admission and works", async ({ browser }) => {
  const s = await seedE2eStudio();
  const email = `desk-re-${s.studioId.slice(0, 8)}@harness.local`;
  await createLocalAuthUser(email);
  const owner = await ownerInvites(browser, s, email, "Returning Desk");
  const deskCtx = await browser.newContext();
  const desk = await deskCtx.newPage();
  await signIn(desk, email);
  await acceptAsReceptionist(desk);
  await expect.poll(async () => (await rows(s.studioId, email)).filter((m) => m.active).length, { timeout: 30_000 }).toBe(1);

  await owner.page.goto("/settings/team");
  await owner.page.getByRole("button", { name: /Remove access for Returning Desk/ }).click();
  await expect(owner.page.getByText("No receptionist has access.")).toBeVisible();
  await desk.goto("/desk");
  await expect(desk).toHaveURL(/\/no-access|\/login/);

  // The owner decides to bring them back: a NEW invitation, issued after the removal.
  const form = owner.page.getByRole("form", { name: "Invite a receptionist" });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Display name").fill("Returning Desk");
  await form.getByRole("button", { name: /invite receptionist/i }).click();
  await expect(owner.page.getByRole("status").filter({ hasText: `Invitation created for ${email}` })).toBeVisible();

  const back = await browser.newContext();
  const page = await back.newPage();
  await signIn(page, email);
  await acceptAsReceptionist(page);
  await expect.poll(async () => (await rows(s.studioId, email)).filter((m) => m.active).length, { timeout: 30_000 }).toBe(1);
  await page.goto("/desk");
  await expect(page).toHaveURL(/\/desk/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("a receptionist in two studios is refused and asked to choose: the desk never picks one", async ({ browser }) => {
  const a = await seedE2eStudio();
  const b = await seedE2eStudio();
  const email = `desk-ms-${a.studioId.slice(0, 8)}@harness.local`;
  const userId = await createLocalAuthUser(email);
  const owner = await ownerInvites(browser, a, email, "Two Studios");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email);
  await acceptAsReceptionist(page);
  await expect.poll(async () => (await rows(a.studioId, email)).filter((m) => m.active).length, { timeout: 30_000 }).toBe(1);
  await page.goto("/desk");
  await expect(page).toHaveURL(/\/desk/); // one studio: lands in it

  // Second studio's receptionist row, copied from the first so the terms fields match (synthetic).
  const bOwner = await getOwnerPractitionerId(b.studioId);
  await sql(
    `insert into public.studio_receptionists (studio_id, user_id, display_name, email, active, created_by_practitioner_id, terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
     select $1, user_id, display_name, email, true, $3, terms_accepted_at, terms_version, privacy_accepted_at, privacy_version from public.studio_receptionists where studio_id=$2 and user_id=$4`,
    [b.studioId, a.studioId, bOwner, userId],
  );
  await page.goto("/desk");
  await expect(page).toHaveURL(/\/no-access\?reason=multiple-studios/);
  await expect(page.locator("body")).not.toContainText(a.studioName);
  await expect(page.locator("body")).not.toContainText(b.studioName);
  await page.goto("/desk/book");
  await expect(page).toHaveURL(/\/no-access/);
  void owner;
});
