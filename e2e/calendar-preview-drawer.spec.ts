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
// lifecycle actions appear only when the server would honour them, and — the
// one that matters most — that a slow response for appointment A can never
// populate appointment B.
//
// The week grid is desktop-only (`hidden md:block`), so every test here runs at
// a desktop viewport; the default Desktop Chrome project already provides one.

const T = 20_000;

async function openWeek(page: Page): Promise<void> {
  await page.goto("/calendar?view=week");
  await expect(page.getByRole("button", { name: /Today/ }).first()).toBeVisible({
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

test("A's late response can never populate B", async ({ page }) => {
  const seed = await seedE2eStudio();
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);

  // A: a returning client with charted history. B: a brand-new client with none.
  const { clientId: clientA } = await seedE2eClientWithPreviousAreas(seed);
  const { clientId: clientB } = await seedE2eClient(seed);
  const apptA = await seedFutureAppointmentAt(seed.studioId, ownerId, clientA, tz, "09:00");
  const apptB = await seedFutureAppointmentAt(seed.studioId, ownerId, clientB, tz, "10:00");
  await seedE2eIntake(seed.studioId, clientA, "submitted");

  await loginAsOwner(page, seed);

  // Hold A's detail response back so it is guaranteed to land AFTER B's.
  let held = 0;
  await page.route("**/calendar**", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && held === 0) {
      held = 1;
      await new Promise((r) => setTimeout(r, 4000));
    }
    await route.continue();
  });

  await openWeek(page);
  const nameA = await clientNameOf(apptA);
  const nameB = await clientNameOf(apptB);

  await card(page, nameA).click();
  const d = drawer(page);
  await expect(d).toBeVisible({ timeout: T });

  // Switch to B before A's response returns.
  await page.keyboard.press("Escape");
  await card(page, nameB).click();
  await expect(drawer(page).getByRole("heading", { name: nameB })).toBeVisible({
    timeout: T,
  });

  // Let A's held response land.
  await page.waitForTimeout(6000);

  const dB = drawer(page);
  // B is a fresh client: no charted history, no intake. If A's payload had been
  // applied, A's compact treatment line and A's Review intake control would
  // appear under B's name.
  await expect(dB.getByRole("heading", { name: nameB })).toBeVisible();
  await expect(dB.getByTestId("today-memory-compact")).toHaveCount(0);
  await expect(dB.getByTestId("preview-review-intake")).toHaveCount(0);
  await expect(dB.getByText("No previous treatment charted for this client.")).toBeVisible();
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
