import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  seedE2eClientWithPreviousAreas,
  seedE2eIntake,
  seedFutureAppointmentAt,
  getStudioTimezone,
  getOwnerPractitionerId,
  sql,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// The calendar appointment drawer as a PREP WORKSPACE.
//
// Runtime proof for the properties source greps cannot see: that the drawer
// opens without leaving /calendar, that it shows a returning client's last
// treatment, that intake links to the AUTHENTICATED practitioner route, that
// lifecycle actions appear only when the server would honour them, and that
// switching appointments never leaves the previous one's prep on screen.
//
// See the long comment above the switching test for what that last one does
// and does NOT establish — the response-ordering half is proved in
// tests/app/calendar/preview-request.test.ts, not here.
//
// The week grid is desktop-only (`hidden md:block`), so every test here runs at
// a desktop viewport; the default Desktop Chrome project already provides one.

const T = 20_000;

async function openWeek(page: Page): Promise<void> {
  await page.goto("/calendar?view=week");
  // The step nav renders as LINKS, not buttons, and is `hidden md:flex` — so
  // this also confirms we are on the desktop week grid, not the mobile view.
  await expect(page.getByRole("link", { name: "Today" }).first()).toBeVisible({
    timeout: T,
  });
}

// The week grid renders one card per appointment; the accessible name carries
// the client name.
function card(page: Page, clientName: string) {
  return page
    .locator("button")
    .filter({ hasText: clientName })
    .first();
}

function drawer(page: Page) {
  return page.getByRole("dialog", { name: "Appointment preview" });
}

test("drawer opens in place, shows prep, and never leaves /calendar", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClientWithPreviousAreas(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "14:00",
  );
  await seedE2eIntake(seed.studioId, clientId, "submitted");

  await loginAsOwner(page, seed);
  await openWeek(page);

  const clientName = await clientNameOf(apptId);
  await card(page, clientName).click();

  const d = drawer(page);
  await expect(d).toBeVisible({ timeout: T });

  // 2. URL stays on /calendar — the drawer is not a navigation.
  expect(new URL(page.url()).pathname).toBe("/calendar");

  // 4. Summary: client / time / service / status.
  await expect(d.getByRole("heading", { name: clientName })).toBeVisible();
  await expect(d.getByText("Time")).toBeVisible();
  await expect(d.getByText("Status")).toBeVisible();

  // 5. Last treatment for a returning client. The seeded client has a CHARTED
  //    Jan session and a NEWER EMPTY June session; the canonical authority must
  //    skip the empty one, so seeing the January visit is also proof the naive
  //    "newest session" rule is not in play (NC1).
  await expect(d.getByTestId("today-memory-compact")).toBeVisible({ timeout: T });
  await expect(d.getByTestId("today-memory-compact")).toContainText("Jan");

  // 6. Appointment notes are present as a real editable surface.
  await expect(d.getByRole("heading", { name: "Appointment notes" })).toBeVisible();

  // 7. A submitted intake offers a real Review intake control pointing at the
  //    AUTHENTICATED route — never the client's /intake/<token> page (NC4).
  const review = d.getByTestId("preview-review-intake");
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute("href", `/clients/${clientId}/intake`);
  expect(await review.getAttribute("href")).not.toMatch(/^\/intake\//);

  // 12. Escape closes.
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
});

test("a reviewed intake offers View intake, still on the authenticated route", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "15:00",
  );
  await seedE2eIntake(seed.studioId, clientId, "reviewed");

  await loginAsOwner(page, seed);
  await openWeek(page);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  const view = d.getByTestId("preview-view-intake");
  await expect(view).toBeVisible({ timeout: T });
  await expect(view).toHaveAttribute("href", `/clients/${clientId}/intake`);
  // The submitted-state control must NOT also be present.
  await expect(d.getByTestId("preview-review-intake")).toHaveCount(0);
});

test("an in-progress intake is stated but never presented as reviewable", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "16:00",
  );
  await seedE2eIntake(seed.studioId, clientId, "in_progress");

  await loginAsOwner(page, seed);
  await openWeek(page);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  await expect(d.getByText("Started, not yet submitted.")).toBeVisible({ timeout: T });
  await expect(d.getByTestId("preview-review-intake")).toHaveCount(0);
  await expect(d.getByTestId("preview-view-intake")).toHaveCount(0);
});

test("Reschedule opens the shared move dialog; Cancel is offered on a future confirmed booking", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "17:00",
  );

  await loginAsOwner(page, seed);
  await openWeek(page);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  // 10. Cancel is present because this booking is genuinely cancelable.
  await expect(d.getByRole("button", { name: "Cancel appointment" })).toBeVisible({
    timeout: T,
  });

  // 9. Reschedule mounts the SHARED dialog, relabelled through its `label`
  //    prop — the dialog keeps its own "Move appointment" identity.
  await d.getByRole("button", { name: "Reschedule" }).click();
  await expect(page.getByRole("dialog", { name: "Move appointment" })).toBeVisible({
    timeout: T,
  });
});

test("a completed appointment offers neither Cancel nor Reschedule", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "18:00",
  );
  // Drive the row terminal. The server refuses cancellation from here, so the
  // UI must not offer it (NC3).
  await setStatus(apptId, "completed");

  await loginAsOwner(page, seed);
  await openWeek(page);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  // The prep sections still load — this is about ACTIONS, not content.
  await expect(d.getByRole("heading", { name: "Appointment notes" })).toBeVisible({
    timeout: T,
  });
  await expect(d.getByRole("button", { name: "Cancel appointment" })).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Reschedule" })).toHaveCount(0);
  // 11. The escape hatch still works.
  await expect(d.getByRole("link", { name: "Open full details" })).toBeVisible();
});

// Switching appointments must never leave the previous one's prep on screen.
//
// WHAT THIS PROVES, HONESTLY. This is a behavioural REGRESSION assertion, not a
// mutation-detected proof, and it is labelled that way because it was measured:
// no single mutation to the drawer turns it red. Three separate mechanisms have
// to fail together, and the architecture prevents that today.
//
//   * Removing the switch-time clear does not flip it — closing the drawer
//     already clears the cached detail on its own.
//   * Removing BOTH clears does not flip it — the response guard then rejects
//     appointment A's superseded payload (issued seq 1, current seq 3).
//   * Removing the GUARD does not flip it either — Next.js serializes
//     server-action requests, so B is not dispatched until A settles and B
//     therefore always resolves LAST, correcting the state. Measured while
//     deliberately delaying A: A's response at 663ms, B's at 4971ms. Delaying
//     at the Playwright route layer is worse still: route handlers dispatch
//     serially, so holding A holds B behind it.
//
// So the ordering guard is defence in depth against a Next.js implementation
// detail that is not a documented contract, and its LOGIC is proved directly in
// tests/app/calendar/preview-request.test.ts. This test is kept because it goes
// live the moment that architecture changes — move the load to a route handler
// and real concurrency appears — and because the end-state it asserts is the
// thing a practitioner would actually see go wrong.
test("switching from A to B ends on B's data, never A's", async ({ page }) => {
  const seed = await seedE2eStudio();
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);

  // A: a returning client with charted history and a submitted intake.
  // B: a brand-new client with neither. Any A content under B is unmistakable.
  const { clientId: clientA } = await seedE2eClientWithPreviousAreas(seed);
  const { clientId: clientB } = await seedE2eClient(seed);
  const apptA = await seedFutureAppointmentAt(seed.studioId, ownerId, clientA, tz, "09:00");
  const apptB = await seedFutureAppointmentAt(seed.studioId, ownerId, clientB, tz, "10:00");
  await seedE2eIntake(seed.studioId, clientA, "submitted");

  await loginAsOwner(page, seed);
  await openWeek(page);

  const nameA = await clientNameOf(apptA);
  const nameB = await clientNameOf(apptB);

  // Open A and let its prep arrive, so there is genuinely something cached to
  // leak before switching away.
  await card(page, nameA).click();
  const dA = drawer(page);
  await expect(dA.getByTestId("today-memory-compact")).toBeVisible({ timeout: T });

  // Switch to B as fast as the UI allows.
  await page.keyboard.press("Escape");
  await card(page, nameB).click();

  const dB = drawer(page);
  await expect(dB.getByRole("heading", { name: nameB })).toBeVisible({ timeout: T });
  await expect(dB.getByText("No previous treatment charted for this client.")).toBeVisible({
    timeout: T,
  });

  // None of A's clinical content is present under B's name.
  await expect(dB.getByTestId("today-memory-compact")).toHaveCount(0);
  await expect(dB.getByTestId("preview-review-intake")).toHaveCount(0);
  await expect(dB.getByRole("heading", { name: nameA })).toHaveCount(0);
});

test("opening the week issues no per-appointment detail load", async ({ page }) => {
  const seed = await seedE2eStudio();
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  for (const hhmm of ["09:00", "10:00", "11:00", "12:00"]) {
    const { clientId } = await seedE2eClient(seed);
    await seedFutureAppointmentAt(seed.studioId, ownerId, clientId, tz, hhmm);
  }

  await loginAsOwner(page, seed);

  // Count server-action POSTs to the calendar route during the initial render.
  let actionPosts = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/calendar") {
      actionPosts += 1;
    }
  });

  await openWeek(page);
  await page.waitForTimeout(2000);

  // Four appointments on screen, ZERO detail loads. The drawer's load is
  // click-triggered; the grid pays nothing.
  expect(actionPosts).toBe(0);
});

// --- helpers ---------------------------------------------------------------

async function clientNameOf(appointmentId: string): Promise<string> {
  const rows = await sql<{ name: string }>(
    `select c.name from public.appointments a
       join public.clients c on c.id = a.client_id
      where a.id = $1`,
    [appointmentId],
  );
  return rows[0].name;
}

async function setStatus(appointmentId: string, status: string): Promise<void> {
  await sql(`update public.appointments set status = $2 where id = $1`, [
    appointmentId,
    status,
  ]);
}
