import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  getCancellationToken,
  getClientIdByEmail,
  getAppointmentsForClient,
} from "./helpers/seed";
import { bookAppointment } from "./helpers/flows";

// PR #260: appointment cancel/reschedule/manage tokens are hashed at rest.
// A real public booking stores ONLY the hash; the surfaces that rebuild a
// link after creation (portal, reminders) mint the stateless HMAC token,
// and, new in PR #260, /reschedule accepts that HMAC fallback alongside
// /cancel and /manage. This proves, on the real Next.js stack, that such a
// token RESOLVES to the booked appointment on all three surfaces (not the
// generic "can't be used" collapse a broken lookup would show).

test.describe("hashed appointment token resolves on the public surfaces", () => {
  test("manage / cancel / reschedule all resolve via the minted token", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await bookAppointment(page, seed);

    const clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
    expect(clientId).toBeTruthy();
    const appointments = await getAppointmentsForClient(seed.studioId, clientId);
    expect(appointments.length).toBe(1);

    const token = await getCancellationToken(seed.studioId, appointments[0].id);
    expect(token).toBeTruthy();

    // Reschedule: the success subhead is rendered ONLY for a resolved,
    // future-confirmed appointment. A broken hash lookup would collapse
    // to the generic error instead.
    await page.goto(`/reschedule/${token}`);
    await expect(
      page.getByText("Choose a new time that works better for you."),
    ).toBeVisible();
    await expect(
      page.getByText(/can't be used right now/i),
    ).toHaveCount(0);

    // Manage: resolves and offers both actions.
    await page.goto(`/manage/${token}`);
    await expect(
      page.getByRole("heading", { name: /manage appointment/i }),
    ).toBeVisible();
    await expect(page.getByText(/can't be used right now/i)).toHaveCount(0);

    // Cancel: resolves to the cancel form (not the "no longer valid"
    // collapse).
    await page.goto(`/cancel/${token}`);
    await expect(
      page.getByRole("heading", { name: /cancel appointment/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/this cancellation link is no longer valid/i),
    ).toHaveCount(0);
  });
});
