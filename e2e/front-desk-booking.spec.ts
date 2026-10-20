import { test, expect, type Page } from "@playwright/test";
import {
  sql,
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  seedPractitionerDefault,
  getE2eServiceId,
  seedServiceEligibility,
  getStudioTimezone,
  createLocalAuthUser,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// STUDIO-READY-02c (#824): a receptionist books, moves and cancels a treating
// practitioner's appointment through the REAL front-desk UI, and the database
// records the human actor (0220). The same session is then refused the
// practitioner app. Synthetic capacity-ON studio, never Willow/production data.

test.describe.configure({ mode: "serial" });

// The list reporter prints failure details only after the full shard finishes.
// Preserve the actual error immediately if a later job timeout cuts it short.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  for (const error of testInfo.errors) {
    // Auth navigation errors can contain single-use verification URLs.
    const message = (error.message ?? error.value ?? "Unknown test error")
      .replace(/https?:\/\/[^\s"'<>]+/g, "[URL omitted]");
    console.error(`[front-desk acceptance: ${testInfo.title}] ${message}`);
  }
});

let seed: E2eSeed;
let serviceId: string;
let clientId: string;
let clientName: string;
let A: { email: string; displayName: string; practitionerId: string };
let deskEmail: string;
let deskId: string;
let deskUserId: string;
let tz: string;
let appointmentId: string;

/** Tomorrow in the studio's own zone, as YYYY-MM-DD. */
function tomorrowLocal(timeZone: string): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function loginAsReceptionist(page: Page, email: string, awaitFrontDesk = true): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
  // A receptionist has no practitioners row: the middleware sends every app
  // route, /dashboard included, to the front desk.
  if (awaitFrontDesk) await page.waitForURL(/\/front-desk/, { timeout: 30_000 });
}

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  serviceId = await getE2eServiceId(seed.studioId);
  ({ clientId } = await seedE2eClient(seed));
  clientName = (await sql<{ name: string }>(`select name from public.clients where id = $1`, [clientId]))[0].name;
  A = await seedE2eMember(seed);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  await seedServiceEligibility(seed.studioId, serviceId, A.practitionerId);
  for (let d = 0; d <= 6; d++) {
    await seedPractitionerDefault(seed.studioId, A.practitionerId, d, true, "06:00", "22:00");
  }
  tz = await getStudioTimezone(seed.studioId);

  // HON-44: provision only an auth identity. The first test must create the
  // invitation through the owner UI and accept it with explicit consent;
  // pre-creating membership would bypass the boundary this journey proves.
  deskEmail = `e2e-desk-${seed.runId}@harness.local`;
  deskUserId = await createLocalAuthUser(deskEmail);
});

test("owner invites a receptionist who explicitly accepts before receiving front-desk access", async ({ page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/settings/team");
  await page.getByRole("textbox", { name: /^Email/ }).fill(deskEmail);
  await page.getByLabel("Display name", { exact: true }).fill("Front Desk E2E");
  await page.getByLabel("Role", { exact: true }).selectOption("receptionist");
  await page.getByRole("button", { name: "Create invite", exact: true }).click();
  await expect(page.getByText(`Invite created for ${deskEmail}.`, { exact: true })).toBeVisible();

  const pending = await sql<{ role: string; status: string }>(
    `select role, status from public.pending_invitations where studio_id = $1 and email = $2`,
    [seed.studioId, deskEmail],
  );
  expect(pending).toEqual([{ role: "receptionist", status: "pending" }]);

  // Separate sessions: an owner's existing cookie must never satisfy the
  // invitee's authorization or the acceptance route.
  await page.context().clearCookies();
  await loginAsReceptionist(page, deskEmail, false);
  await page.waitForURL(/\/accept-invitation(?:\?|$)/, { timeout: 30_000 });
  const join = page.getByRole("button", { name: /Join .* as/ });
  await expect(join).toBeDisabled();
  const before = await sql<{ n: number }>(
    `select count(*)::int as n from public.studio_receptionists
      where studio_id = $1 and user_id = $2 and active`, [seed.studioId, deskUserId],
  );
  expect(before).toEqual([{ n: 0 }]);

  await page.getByLabel(/I agree to the current/).check();
  await join.click();
  await page.waitForURL(/\/front-desk$/, { timeout: 30_000 });
  const memberships = await sql<{ id: string; terms_accepted_at: string | null; privacy_accepted_at: string | null }>(
    `select id, terms_accepted_at::text, privacy_accepted_at::text
       from public.studio_receptionists where studio_id = $1 and user_id = $2 and active`,
    [seed.studioId, deskUserId],
  );
  expect(memberships).toHaveLength(1);
  expect(memberships[0].terms_accepted_at).not.toBeNull();
  expect(memberships[0].privacy_accepted_at).not.toBeNull();
  deskId = memberships[0].id;
  const treatingRows = await sql<{ n: number }>(
    `select count(*)::int as n from public.practitioners where studio_id = $1 and user_id = $2`,
    [seed.studioId, deskUserId],
  );
  expect(treatingRows).toEqual([{ n: 0 }]);
});

test("a receptionist books for a treating practitioner, attributed to the receptionist", async ({ page }) => {
  await loginAsReceptionist(page, deskEmail);
  await page.getByRole("link", { name: "Book" }).click();
  await page.waitForURL(/\/front-desk\/book/);

  // Find the client through the contacts projection.
  await page.getByRole("search", { name: "Find a client" }).getByRole("searchbox").fill(clientName.slice(0, 12));
  await page.getByRole("button", { name: "Search" }).click();

  const form = page.getByRole("form", { name: "Book an appointment" });
  await form.getByLabel("Client").selectOption({ label: clientName });
  await form.getByLabel("Service").selectOption(serviceId);
  await form.getByLabel("Practitioner").selectOption(A.practitionerId);
  await form.getByLabel("Date").fill(tomorrowLocal(tz));
  await form.getByLabel(/^Time/).fill("10:00");
  await form.getByRole("button", { name: "Book appointment" }).click();
  await expect(form.getByRole("status")).toHaveText("Appointment booked.", { timeout: 20_000 });

  const rows = await sql<{
    id: string;
    practitioner_id: string;
    created_by_receptionist_id: string | null;
    created_by_practitioner_id: string | null;
    notes: string | null;
  }>(
    `select id, practitioner_id, created_by_receptionist_id, created_by_practitioner_id, notes
       from public.appointments where client_id = $1 and status = 'confirmed'`,
    [clientId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    practitioner_id: A.practitionerId,
    created_by_receptionist_id: deskId,
    created_by_practitioner_id: null,
    notes: null,
  });
  appointmentId = rows[0].id;
  const audit = await sql<{ actor_type: string; actor_receptionist_id: string | null }>(
    `select actor_type, actor_receptionist_id from public.appointment_audit where appointment_id = $1 and action = 'created'`,
    [appointmentId],
  );
  expect(audit).toEqual([{ actor_type: "receptionist", actor_receptionist_id: deskId }]);
});

test("the receptionist moves it from the schedule, and the move is theirs", async ({ page }) => {
  await loginAsReceptionist(page, deskEmail);
  await page.goto("/front-desk");
  const row = page.getByRole("listitem").filter({ hasText: clientName });
  await row.getByText("Change").click();
  const move = row.getByRole("form", { name: `Move ${clientName}'s appointment` });
  await move.getByLabel("Time").fill("11:00");
  await move.getByRole("button", { name: "Move" }).click();
  // The move is COMMITTED either way. The e2e fake email transport may reject
  // the client notification, and the action then says so honestly ("…could not
  // be delivered"), so this asserts the commit, not delivery.
  await expect(move.getByRole("status")).toHaveText(/^Appointment moved(\.|, but the client notification could not be delivered\.)$/, {
    timeout: 20_000,
  });

  const audit = await sql<{ action: string; actor_type: string; actor_receptionist_id: string | null }>(
    `select action, actor_type, actor_receptionist_id from public.appointment_audit
      where appointment_id = $1 and action = 'moved'`,
    [appointmentId],
  );
  expect(audit).toEqual([{ action: "moved", actor_type: "receptionist", actor_receptionist_id: deskId }]);
});

test("the receptionist cancels it, recorded as the front desk", async ({ page }) => {
  await loginAsReceptionist(page, deskEmail);
  await page.goto("/front-desk");
  const row = page.getByRole("listitem").filter({ hasText: clientName });
  await row.getByText("Change").click();
  const cancel = row.getByRole("form", { name: `Cancel ${clientName}'s appointment` });
  await cancel.getByLabel(/Reason/).fill("client called");
  await cancel.getByRole("button", { name: "Cancel appointment" }).click();
  // The schedule re-renders after the commit: the row stays, now marked
  // cancelled, and its Change control is gone (only confirmed future rows have one).
  await expect(row).toContainText("cancelled", { timeout: 20_000 });
  await expect(row.getByText("Change")).toHaveCount(0);

  const a = await sql<{ status: string; cancelled_by: string; cancelled_by_receptionist_id: string | null; cancelled_by_practitioner_id: string | null }>(
    `select status, cancelled_by, cancelled_by_receptionist_id, cancelled_by_practitioner_id from public.appointments where id = $1`,
    [appointmentId],
  );
  expect(a[0]).toEqual({
    status: "cancelled",
    cancelled_by: "receptionist",
    cancelled_by_receptionist_id: deskId,
    cancelled_by_practitioner_id: null,
  });
});

test("the same session is refused the practitioner app and its clinical routes", async ({ page }) => {
  await loginAsReceptionist(page, deskEmail);
  for (const path of [`/clients/${clientId}`, "/calendar", "/records", "/settings/team"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/front-desk$/);
  }
});
