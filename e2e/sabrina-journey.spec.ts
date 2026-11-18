import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  createLocalAuthUser, getAppointmentAuditActions, getAppointmentPostcareState, getE2eServiceId, getOwnerPractitionerId,
  insertMembershipInStudio, seedE2eClient, seedE2eEndedAppointmentSession, seedE2eStudio, seedPractitionerDefault,
  seedServiceEligibility, setStudioCapacityBookingEnabled, setStudioCapacityEnabled, setStudioPostcareText, setStudioTimezone,
  sql, type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { markResendLedger } from "./helpers/resend-ledger";
import { TZ, clientNameOf, reservationCount, rows, type User } from "./hon48-support/five-user-team";
import {
  T, asAuthenticated, authUserId, chartOneBlock, fillManualBooking, inviteViaTeamPage, ledgerFor, openColumnDrawer,
  paymentFootprint, practitionerByEmail, sendPostcareViaDialog, signInAnywhere,
} from "./sabrina-support/journey";

// CONNECTED SABRINA JOURNEY (HON-44 / HON-45 / HON-47 / HON-50). One serial run, one synthetic studio, captured transport only:
// invite a practitioner -> they accept -> staff books for them by hand -> they open the assigned appointment and chart ->
// finish with no charge -> postcare through the captured transport -> the owner removes them and revokes a pending invitation ->
// the removed user, an old invitation and a second studio are all refused -> failure and retry. A red step is a FINDING
// against the issue named in its title; nothing here is bent to pass. Synthetic names and addresses only. No real message,
// invitation or charge: app email goes to the fake Resend ledger, sign-in mail to the local Mailpit.
//
// Opt-in (a long multi-context run, so no lane carries it by default): SABRINA_JOURNEY_E2E=1.
//
// Fake Resend: the lane defaults the fake to `reject`; a recipient prefix chooses the mode (`success+`, `failonce+`, `reject+`).

test.skip(process.env.SABRINA_JOURNEY_E2E !== "1", "opt-in Sabrina journey; set SABRINA_JOURNEY_E2E=1");
test.describe.configure({ mode: "serial" });

const run = randomUUID().slice(0, 8);
const INVITEE_EMAIL = `success+j-prac-${run}@harness.local`;
const INVITEE_NAME = `Journey Practitioner ${run}`;
const SECOND_INVITEE = `success+j-late-${run}@harness.local`;
const LOT = `J-LOT-${run}`;

let seed: E2eSeed;
let serviceId: string;
let ownerPage: Page;
let ownerCtx: BrowserContext;
let ownerPractitionerId: string;
let inviteeCtx: BrowserContext;
let inviteePage: Page;
let invitee: { practitionerId: string; userId: string };
let client: { clientId: string; name: string; email: string };
let appointmentId: string;
let sessionId: string;
let day: string;
let studioB: E2eSeed;

test.beforeAll(async ({ browser }) => {
  seed = await seedE2eStudio();
  await setStudioTimezone(seed.studioId, TZ);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  await setStudioPostcareText(seed.studioId, "Keep the area clean and dry.");
  serviceId = await getE2eServiceId(seed.studioId);
  ownerPractitionerId = await getOwnerPractitionerId(seed.studioId);
  for (let wd = 0; wd <= 6; wd++) await seedPractitionerDefault(seed.studioId, ownerPractitionerId, wd, true, "06:00", "22:00");
  const [d] = await sql<{ day: string }>("select ((now() at time zone $1)::date + 3)::text as day", [TZ]);
  day = d.day;
  ownerCtx = await browser.newContext();
  ownerPage = await ownerCtx.newPage();
  await loginAsOwner(ownerPage, seed);
  inviteeCtx = await browser.newContext();
  inviteePage = await inviteeCtx.newPage();
  studioB = await seedE2eStudio();
});
test.afterAll(async () => {
  await ownerCtx?.close();
  await inviteeCtx?.close();
});

test.describe("A. invite and accept (HON-44)", () => {
  test("J1 the owner invites a practitioner: a pending invitation exists and the product says so", async () => {
    await inviteViaTeamPage(ownerPage, INVITEE_EMAIL, INVITEE_NAME);
    const pending = await sql<{ status: string; role: string }>(
      "select status, role from public.pending_invitations where studio_id=$1 and lower(email)=lower($2)", [seed.studioId, INVITEE_EMAIL]);
    expect(pending).toEqual([{ status: "pending", role: "practitioner" }]);
    await expect(ownerPage.getByText(INVITEE_EMAIL.toLowerCase()).first()).toBeVisible();
  });

  // FINDING (run 1, 18 Nov): the staff invitation email (settings/team/actions.ts) is sent with the RAW Resend client, not
  // getResendTransport(), so the fake transport and its capture ledger never see it (the server logged
  // team_invitation_email_failed:provider_error:validation_error against the lane's dummy key). Written down as the exact
  // contract; blocked until the invitation send goes through the shared transport.
  test.fixme("J1b the invitation email is recorded by the captured transport, exactly once (blocked until the invitation-transport fix, #1608, is on the base: un-fixme then)", async () => {
    const mark = markResendLedger();
    const email = `success+j-cap-${run}@harness.local`;
    await inviteViaTeamPage(ownerPage, email, `Journey Captured ${run}`);
    expect(await ledgerFor(mark, email)).toHaveLength(1);
  });

  test("J2 the invitee signs in, cannot enter before accepting, accepts, and lands in the studio", async () => {
    await signInAnywhere(inviteePage, INVITEE_EMAIL);
    await inviteePage.waitForURL(/\/accept-invitation/, { timeout: 30_000 });
    await expect(inviteePage.getByRole("heading", { name: "Join your studio" })).toBeVisible();
    await inviteePage.goto("/dashboard");
    await expect(inviteePage).toHaveURL(/\/no-access/);
    await inviteePage.goto("/accept-invitation");
    await inviteePage.getByLabel(/I agree to the current/).check();
    await inviteePage.getByRole("button", { name: /Join .* as/ }).click();
    await inviteePage.waitForURL(/\/dashboard/, { timeout: 30_000 });
    const p = await practitionerByEmail(seed.studioId, INVITEE_EMAIL);
    expect(p, "a membership row exists").not.toBeNull();
    expect(p!.active).toBe(true);
    const [inv] = await sql<{ status: string }>("select status from public.pending_invitations where studio_id=$1 and lower(email)=lower($2)", [seed.studioId, INVITEE_EMAIL]);
    expect(inv.status).toBe("accepted");
    invitee = { practitionerId: p!.id, userId: p!.user_id };
    // Availability and service eligibility are owner configuration the journey is not about: seeded, so the booking step has slots.
    await seedServiceEligibility(seed.studioId, serviceId, invitee.practitionerId);
    for (let wd = 0; wd <= 6; wd++) await seedPractitionerDefault(seed.studioId, invitee.practitionerId, wd, true, "06:00", "22:00");
  });
});

test.describe("B. staff books, the practitioner charts (HON-45)", () => {
  test("J3 staff books a client by hand, assigned to the new practitioner: one row, one reservation", async () => {
    const { clientId } = await seedE2eClient(seed);
    const name = await clientNameOf(seed, clientId);
    // The postcare recipient: the success+ prefix makes the fake provider ACCEPT it.
    const email = `success+j-client-${run}@harness.local`;
    await sql("update public.clients set email=$3 where studio_id=$1 and id=$2", [seed.studioId, clientId, email]);
    client = { clientId, name, email };
    const target: User = { key: "new", practitionerId: invitee.practitionerId, name: (await practitionerByEmail(seed.studioId, INVITEE_EMAIL))!.display_name, email: INVITEE_EMAIL, clientId, clientName: name };
    await openColumnDrawer(ownerPage, day, [ownerPractitionerId, invitee.practitionerId], target);
    const submit = await fillManualBooking(ownerPage, name, serviceId, target);
    await submit.click();
    await expect(ownerPage.getByRole("dialog", { name: "New appointment" })).toBeHidden({ timeout: 30_000 });
    const booked = await rows(seed, invitee.practitionerId, clientId);
    expect(booked, "exactly one booking, assigned to the new practitioner").toHaveLength(1);
    appointmentId = booked[0].id;
    expect(await reservationCount(appointmentId)).toBe(1);
    // Setup, not product behaviour: completion is gated on the START time, so move this synthetic appointment into the past.
    await sql("update public.appointments set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' where id=$1 and studio_id=$2", [appointmentId, seed.studioId]);
  });

  // EXPLICIT COMPLETION (decided 18 Nov, shipped in the explicit-completion change): charting leaves a past confirmed appointment
  // CONFIRMED and surfaces it as "Finish visit"; the practitioner's separate Finish completes it, with no postcare (this studio is
  // on manual postcare) and no payment. J4/J5 assert that contract. They are NOT proven until that change is on the base and
  // this spec has been run against it; before then the old auto-complete behaviour makes J4 red, which is the point.
  test("J4 the assigned practitioner charts the appointment: it stays CONFIRMED, is surfaced as not finished, and nothing is paid", async () => {
    await inviteePage.goto(`/calendar/${appointmentId}`);
    await expect(inviteePage.getByText(client.name).first()).toBeVisible({ timeout: T });
    await chartOneBlock(inviteePage, client.clientId, appointmentId, LOT);
    const url = inviteePage.url();
    sessionId = /sessions\/([0-9a-f-]{36})/.exec(url)![1];
    await expect(inviteePage.getByTestId("finish-appointment")).toBeVisible({ timeout: T });
    await expect(inviteePage.getByTestId("finish-charting-status")).toHaveText("Charting recorded", { timeout: T });
    // Charting is not completing: the appointment is still open, and completion is offered as its own act.
    expect((await getAppointmentPostcareState(appointmentId)).status).toBe("confirmed");
    expect((await getAppointmentAuditActions(appointmentId)).filter((a) => a === "marked_complete")).toHaveLength(0);
    await expect(inviteePage.getByTestId("finish-completion-status")).toHaveText("Ready to mark completed", { timeout: T });
    expect(await paymentFootprint(seed.studioId, appointmentId, sessionId)).toEqual({ appointmentPaymentRows: 0, chargeAttempts: 0, pricePaidCents: null });
    // The charted-but-unfinished visit is visible to the owner on the dashboard, so it cannot stay open unseen.
    await ownerPage.goto("/dashboard");
    await expect(ownerPage.getByText("Not finished").first()).toBeVisible({ timeout: T });
  });

  test("J5 Finish completes once, sends no postcare and takes no payment; reload changes nothing", async () => {
    const mark = markResendLedger();
    await inviteePage.getByTestId("mark-appointment-complete").click();
    await inviteePage.getByTestId("confirm-dialog-confirm").click();
    await expect.poll(async () => (await getAppointmentPostcareState(appointmentId)).status, { timeout: T }).toBe("completed");
    expect((await getAppointmentAuditActions(appointmentId)).filter((a) => a === "marked_complete")).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      await inviteePage.reload();
      await expect(inviteePage.getByTestId("finish-completion-status")).toHaveText("Completed", { timeout: T });
    }
    // Finish wrote completion ONLY: this studio is on manual postcare, so nothing was claimed or sent, and nothing was charged.
    expect((await getAppointmentPostcareState(appointmentId)).sentAt).toBeNull();
    expect(await ledgerFor(mark, client.email, 0, 1_500)).toHaveLength(0);
    expect(await paymentFootprint(seed.studioId, appointmentId, sessionId)).toEqual({ appointmentPaymentRows: 0, chargeAttempts: 0, pricePaidCents: null });
    // Send postcare and Charge are still separate, labelled actions after Finish.
    await expect(inviteePage.getByRole("button", { name: "Send postcare", exact: true })).toBeVisible({ timeout: T });
  });

  test("J6 postcare goes through the captured transport once; completion does not depend on it", async () => {
    const mark = markResendLedger();
    await sendPostcareViaDialog(inviteePage);
    await expect.poll(async () => (await getAppointmentPostcareState(appointmentId)).sentAt, { timeout: T }).not.toBeNull();
    const captured = await ledgerFor(mark, client.email);
    expect(captured, "one postcare email attempt reached the fake transport").toHaveLength(1);
    const state = await getAppointmentPostcareState(appointmentId);
    expect(state.status).toBe("completed");
    expect(await paymentFootprint(seed.studioId, appointmentId, sessionId)).toEqual({ appointmentPaymentRows: 0, chargeAttempts: 0, pricePaidCents: null });
  });
});

test.describe("C. removal and revocation (HON-44)", () => {
  test("J7 the owner revokes a pending invitation and removes the practitioner", async () => {
    await inviteViaTeamPage(ownerPage, SECOND_INVITEE, `Journey Late ${run}`);
    await ownerPage.goto("/settings/team");
    await ownerPage.locator("li", { hasText: SECOND_INVITEE.toLowerCase() }).getByRole("button", { name: "Revoke" }).click();
    await expect.poll(async () => (await sql<{ status: string }>("select status from public.pending_invitations where studio_id=$1 and lower(email)=lower($2)", [seed.studioId, SECOND_INVITEE]))[0]?.status, { timeout: T }).toBe("revoked");
    await ownerPage.goto("/settings/team");
    await ownerPage.locator("li", { hasText: INVITEE_EMAIL.toLowerCase() }).getByRole("button", { name: "Remove" }).click();
    await expect.poll(async () => (await practitionerByEmail(seed.studioId, INVITEE_EMAIL))?.active, { timeout: T }).toBe(false);
  });

  test("J8a the removed user's EXISTING session reaches no studio page", async () => {
    for (const path of ["/dashboard", "/calendar", `/calendar/${appointmentId}`, `/clients/${client.clientId}`]) {
      await inviteePage.goto(path);
      await expect(inviteePage, `${path} is refused for a removed user`).toHaveURL(/\/no-access/);
    }
  });

  test("J8b a direct database read as the removed user returns nothing (row-level security, not a hidden button)", async () => {
    for (const table of ["appointments", "clients", "sessions"]) {
      const got = await asAuthenticated<{ n: number }>(invitee.userId, `select count(*)::int as n from public.${table} where studio_id=$1`, [seed.studioId]);
      expect(got[0].n, `${table} visible to the removed user`).toBe(0);
    }
  });

  test("J8c the REVOKED invitation cannot restore access: sign-in lands on no-access, accepting is refused", async ({ browser }) => {
    await createLocalAuthUser(SECOND_INVITEE).catch(() => undefined); // GoTrue creates it on first magic link otherwise
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signInAnywhere(page, SECOND_INVITEE);
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/no-access/);
      await page.goto("/accept-invitation");
      await expect(page).not.toHaveURL(/\/dashboard/);
      expect(await practitionerByEmail(seed.studioId, SECOND_INVITEE), "no membership was created from a revoked invitation").toBeNull();
    } finally {
      await ctx.close();
    }
  });

  test("J8d record continuity: the removed practitioner's appointment, chart and postcare history are intact for the owner", async () => {
    const appt = await sql<{ status: string; practitioner_id: string }>("select status, practitioner_id from public.appointments where id=$1", [appointmentId]);
    expect(appt).toEqual([{ status: "completed", practitioner_id: invitee.practitionerId }]);
    const [s] = await sql<{ n: number }>("select count(*)::int as n from public.sessions where id=$1 and studio_id=$2", [sessionId, seed.studioId]);
    expect(s.n).toBe(1);
    await ownerPage.goto(`/clients/${client.clientId}/sessions/${sessionId}`);
    await expect(ownerPage.getByText(LOT).first()).toBeVisible({ timeout: T });
  });
});

test.describe("D. isolation (HON-44)", () => {
  test("J9a another studio's owner cannot read this studio's records, by page or by direct read", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await loginAsOwner(page, studioB);
      await page.goto(`/calendar/${appointmentId}`);
      await expect(page.getByText(client.name)).toHaveCount(0);
      await page.goto(`/clients/${client.clientId}`);
      await expect(page.getByText(client.name)).toHaveCount(0);
      const bOwner = await authUserId(studioB.ownerEmail);
      const got = await asAuthenticated<{ n: number }>(bOwner, "select count(*)::int as n from public.appointments where id=$1", [appointmentId]);
      expect(got[0].n).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test("J9b a user active in TWO studios is asked to choose, never auto-selected", async ({ browser }) => {
    const email = `j-two-${run}@harness.local`;
    const userId = await createLocalAuthUser(email);
    await insertMembershipInStudio(seed.studioId, userId, email, true);
    await insertMembershipInStudio(studioB.studioId, userId, email, true);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signInAnywhere(page, email);
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/no-access\?reason=multiple-studios/);
    } finally {
      await ctx.close();
    }
  });
});

test.describe("E. failure and retry (HON-50 / HON-45)", () => {
  test("J10 a failed postcare send is shown as failed, a retry sends once, completion never changes", async () => {
    const failOnce = `failonce+j-retry-${run}@harness.local`;
    const s = await seedE2eEndedAppointmentSession(seed, { charted: true, clientEmail: failOnce });
    await ownerPage.goto(`/clients/${s.clientId}/sessions/${s.sessionId}`);
    await expect(ownerPage.getByTestId("finish-appointment")).toBeVisible({ timeout: T });
    await ownerPage.getByTestId("mark-appointment-complete").click();
    await ownerPage.getByTestId("confirm-dialog-confirm").click();
    await expect.poll(async () => (await getAppointmentPostcareState(s.appointmentId)).status, { timeout: T }).toBe("completed");

    const mark = markResendLedger();
    await sendPostcareViaDialog(ownerPage);
    await expect.poll(async () => (await getAppointmentPostcareState(s.appointmentId)).attempts, { timeout: T }).toBe(1);
    let state = await getAppointmentPostcareState(s.appointmentId);
    expect(state.sentAt, "the first attempt failed: nothing is marked sent").toBeNull();
    expect(state.status, "a failed postcare send never undoes completion").toBe("completed");
    await expect(ownerPage.getByText(/send failed|try again/i).first(), "the failure is shown to the practitioner").toBeVisible({ timeout: T });

    await ownerPage.reload();
    await sendPostcareViaDialog(ownerPage);
    await expect.poll(async () => (await getAppointmentPostcareState(s.appointmentId)).sentAt, { timeout: T }).not.toBeNull();
    const attempts = await ledgerFor(mark, failOnce, 2);
    expect(attempts, "one failed attempt then one accepted attempt, no duplicate").toHaveLength(2);
    state = await getAppointmentPostcareState(s.appointmentId);
    expect(state.status).toBe("completed");
    await ownerPage.reload();
    // Sent: the first-send control is gone and only the explicit "Resend" remains (exact match; "Send postcare" is a substring of it).
    await expect(ownerPage.getByRole("button", { name: "Send postcare", exact: true })).toHaveCount(0);
    await expect(ownerPage.getByRole("button", { name: "Resend postcare", exact: true })).toHaveCount(1);
    expect(await paymentFootprint(seed.studioId, s.appointmentId, s.sessionId)).toEqual({ appointmentPaymentRows: 0, chargeAttempts: 0, pricePaidCents: null });
  });

  test("J10b an invitation email that the provider refuses leaves a pending, shareable invitation (no silent loss)", async () => {
    const refused = `reject+j-refused-${run}@harness.local`;
    await inviteViaTeamPage(ownerPage, refused, "Refused Invitee");
    const [inv] = await sql<{ status: string }>("select status from public.pending_invitations where studio_id=$1 and lower(email)=lower($2)", [seed.studioId, refused]);
    expect(inv.status).toBe("pending");
    // The product's only recovery for a refused invitation email is the on-screen share message.
    await expect(ownerPage.getByRole("button", { name: "Copy message" })).toBeVisible();
  });
});

// J11 is BLOCKED until the client portal switch exists (a studios.client_portal_enabled column) and the studio can turn the
// portal off. The assertions below are the exact contract, ready to flip on. They are written, not run.
test.fixme("J11 staff-managed booking with the client portal OFF (blocked: no portal switch on this schema yet)", async ({ browser }) => {
  await sql("update public.studios set client_portal_enabled=false where id=$1", [seed.studioId]);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    // staff booking still works
    const { clientId } = await seedE2eClient(seed);
    expect(clientId).toBeTruthy();
    // direct client routes are refused
    for (const path of ["/portal", `/portal/login?studio=${seed.slug}`]) {
      await page.goto(path);
      await expect(page.getByText(/online client access isn.t available|portal.*off/i).first()).toBeVisible();
    }
    // client email variants carry no portal, cancel or reschedule CTA while reminders and postcare still go out
    const mark = markResendLedger();
    const s = await seedE2eEndedAppointmentSession(seed, { charted: true, clientEmail: `success+j11-${run}@harness.local` });
    expect(s.appointmentId).toBeTruthy();
    const recs = await ledgerFor(mark, `success+j11-${run}@harness.local`, 0, 1_000);
    for (const r of recs) for (const h of r.hrefs ?? []) expect(h).not.toMatch(/\/portal|\/cancel\/|\/reschedule\//);
    // intake and consent links keep working with the portal off (they are care forms)
  } finally {
    await ctx.close();
    await sql("update public.studios set client_portal_enabled=true where id=$1", [seed.studioId]).catch(() => undefined);
  }
});
