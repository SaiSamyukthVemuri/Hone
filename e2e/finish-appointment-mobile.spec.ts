import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eEndedAppointmentSession,
  seedE2eUnlinkedSession,
  seedE2eLaserSessionWithEntry,
  seedE2eCrossClientLinkedSession,
  setStudioPostcareText,
  getAppointmentPostcareState,
  getSessionAftercareStamp,
  getAppointmentAuditActions,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Chloe finishes charting and the two visit-closing actions — mark completed
// and send postcare — live on the calendar appointment page, a different
// surface. They get forgotten, and payment (gated on completion) stays locked.
//
// This spec drives the real stack. It never reaches a provider: the E2E lane's
// Resend key is a dummy, so a "send" exercises the claim/attempt/failure
// bookkeeping without an email leaving.

const T = 20_000;

async function openSession(page: Page, clientId: string, sessionId: string) {
  await page.goto(`/clients/${clientId}/sessions/${sessionId}`);
  await expect(page.getByTestId("finish-appointment")).toBeVisible({ timeout: T });
}

function finish(page: Page) {
  return page.getByTestId("finish-appointment");
}

async function expectNoHorizontalScroll(page: Page) {
  const d = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(d.s).toBeLessThanOrEqual(d.c + 1);
}

function suite(label: string, viewport: { width: number; height: number }, isMobile: boolean) {
  test.describe(label, () => {
    test.use({ viewport, isMobile, hasTouch: isMobile });

    test("ended confirmed appointment: all four states, complete through confirmation", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      await setStudioPostcareText(seed.studioId, "Keep the area clean and dry.");
      const s = await seedE2eEndedAppointmentSession(seed, { charted: true });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      await test.step("the four states are visible at once — no wizard", async () => {
        await expect(finish(page).getByText("Treatment chart")).toBeVisible();
        await expect(page.getByTestId("finish-charting-status")).toHaveText(
          "Charting recorded",
        );
        await expect(page.getByTestId("finish-aftercare-status")).toHaveText(
          "Not marked",
        );
        await expect(page.getByTestId("finish-completion-status")).toHaveText(
          "Ready to mark completed",
        );
        await expect(finish(page).getByText("Postcare email")).toBeVisible();
        await expect(page.getByTestId("mark-appointment-complete")).toBeVisible();
      });

      await test.step("Cancel in the confirmation sends NO request", async () => {
        await page.getByTestId("mark-appointment-complete").click();
        await expect(page.getByTestId("confirm-dialog")).toBeVisible({ timeout: T });
        await page.getByRole("button", { name: "Cancel" }).first().click();
        expect((await getAppointmentPostcareState(s.appointmentId)).status).toBe(
          "confirmed",
        );
        expect(await getAppointmentAuditActions(s.appointmentId)).not.toContain(
          "marked_complete",
        );
      });

      await test.step("Confirm completes exactly once, durably", async () => {
        await page.getByTestId("mark-appointment-complete").click();
        await page.getByTestId("confirm-dialog-confirm").click();
        await expect
          .poll(async () => (await getAppointmentPostcareState(s.appointmentId)).status, {
            timeout: T,
          })
          .toBe("completed");
        // Exactly one audit row — no double submit.
        const audits = await getAppointmentAuditActions(s.appointmentId);
        expect(audits.filter((a) => a === "marked_complete")).toHaveLength(1);
      });

      await test.step("status becomes Completed and the button is gone", async () => {
        await expect(page.getByTestId("finish-completion-status")).toHaveText(
          "Completed",
          { timeout: T },
        );
        await expect(page.getByTestId("mark-appointment-complete")).toHaveCount(0);
      });

      await test.step("it did NOT navigate away, and did not stamp aftercare", async () => {
        await expect(page.getByTestId("finish-appointment")).toBeVisible();
        expect(await getSessionAftercareStamp(s.sessionId)).toBeNull();
        await expect(page.getByTestId("finish-aftercare-status")).toHaveText(
          "Not marked",
        );
      });

      await test.step("payment sits directly below Finish", async () => {
        const fBox = await finish(page).boundingBox();
        const pBox = await page.locator("#session-payment").boundingBox();
        expect(fBox && pBox && pBox.y > fBox.y).toBe(true);
      });

      await expectNoHorizontalScroll(page);
    });

    test("pre-end: the button is MOUNTED and disabled, then enables itself when ends_at passes — no reload", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      // Ends in ~6 seconds, so the real timer can be observed crossing it.
      const s = await seedE2eEndedAppointmentSession(seed, {
        endsInSeconds: 6,
      });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      // MOUNTED (so its self-enabling timer is running) but disabled. Mounting
      // it only once "ready" meant the timer never ran and the button could not
      // appear without a manual refresh, while the copy promised otherwise.
      const button = page.getByTestId("mark-appointment-complete");
      await expect(button).toBeVisible();
      await expect(button).toBeDisabled();
      await expect(page.getByTestId("mark-complete-not-ended")).toHaveText(
        /updates on its own/,
      );

      // No navigation, no reload — the SAME mounted button becomes enabled.
      const url = page.url();
      await expect(button).toBeEnabled({ timeout: 20_000 });
      expect(page.url()).toBe(url);
      await expect(page.getByTestId("mark-complete-not-ended")).toHaveCount(0);
    });

    test("pre-end appointment: exit still available", async ({ page }) => {
      const seed = await seedE2eStudio();
      const s = await seedE2eEndedAppointmentSession(seed, { endedHoursAgo: -2 });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      await expect(page.getByTestId("finish-completion-status")).toHaveText(
        "Available after the appointment ends",
      );
      await expect(page.getByTestId("mark-appointment-complete")).toBeDisabled();
      // The safe exit is still there.
      await expect(
        finish(page).getByRole("button", { name: /Done — back to client/ }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test("terminal states show no completion action", async ({ page }) => {
      const seed = await seedE2eStudio();
      const cases = [
        ["completed", "Completed", 2],
        ["cancelled", "Cancelled", 6],
        ["no_show", "No-show", 10],
      ] as const;
      for (const [status, label, hoursAgo] of cases) {
        // Staggered: one practitioner cannot hold three overlapping
        // appointments (the double-booking exclusion constraint is real).
        const s = await seedE2eEndedAppointmentSession(seed, {
          status,
          endedHoursAgo: hoursAgo,
        });
        await loginAsOwner(page, seed);
        await openSession(page, s.clientId, s.sessionId);
        await expect(page.getByTestId("finish-completion-status")).toHaveText(label);
        await expect(page.getByTestId("mark-appointment-complete")).toHaveCount(0);
      }
    });

    test("unlinked session: no appointment actions, charting + exit remain", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      const s = await seedE2eUnlinkedSession(seed);
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      await expect(page.getByTestId("finish-completion-status")).toHaveText(
        "No booked appointment linked",
      );
      await expect(page.getByTestId("finish-postcare-status")).toHaveText(
        "No booked appointment linked",
      );
      await expect(page.getByTestId("mark-appointment-complete")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Send postcare" })).toHaveCount(0);
      // Charting status and the safe exit still work.
      await expect(page.getByTestId("finish-charting-status")).toBeVisible();
      await expect(
        finish(page).getByRole("button", { name: /Done — back to client/ }),
      ).toBeVisible();
    });

    test("no client email: explicit unavailable state, no send button", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      await setStudioPostcareText(seed.studioId, "Aftercare text.");
      const s = await seedE2eEndedAppointmentSession(seed, { clientEmail: null });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      await expect(page.getByTestId("postcare-no-client-email")).toHaveText(
        "Postcare unavailable — no client email",
      );
      await expect(page.getByRole("button", { name: /Send postcare/ })).toHaveCount(0);
      // The whole Finish section is still there.
      await expect(page.getByTestId("finish-completion-status")).toBeVisible();
    });

    test("postcare not configured: owner guidance, no send button", async ({ page }) => {
      const seed = await seedE2eStudio();
      await setStudioPostcareText(seed.studioId, null);
      const s = await seedE2eEndedAppointmentSession(seed);
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      await expect(
        finish(page).getByText("Postcare email is not configured yet."),
      ).toBeVisible();
      await expect(
        finish(page).getByRole("link", { name: "Configure postcare" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /Send postcare/ })).toHaveCount(0);
    });

    test("already-sent postcare shows Resend and keeps the timestamp on reload", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      await setStudioPostcareText(seed.studioId, "Aftercare text.");
      const sentAt = new Date(Date.now() - 60_000).toISOString();
      const s = await seedE2eEndedAppointmentSession(seed, {
        status: "completed",
        postcare: { sentAt, attempts: 1 },
      });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      await expect(
        finish(page).getByRole("button", { name: "Resend postcare" }),
      ).toBeVisible({ timeout: T });
      await expect(
        page.getByRole("button", { name: "Send postcare", exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await expect(
        finish(page).getByRole("button", { name: "Resend postcare" }),
      ).toBeVisible({ timeout: T });
      expect((await getAppointmentPostcareState(s.appointmentId)).sentAt).not.toBeNull();
    });

    test("a failed postcare stays honest and completion is not rolled back", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      await setStudioPostcareText(seed.studioId, "Aftercare text.");
      const s = await seedE2eEndedAppointmentSession(seed, {
        status: "completed",
        postcare: { failedAt: new Date().toISOString(), attempts: 1 },
      });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      // Completion is untouched by a postcare failure.
      await expect(page.getByTestId("finish-completion-status")).toHaveText("Completed");
      // ...and an explicit retry is still offered (never auto-retried).
      await expect(
        finish(page).getByRole("button", { name: /Send postcare|Resend postcare/ }),
      ).toBeVisible({ timeout: T });
      expect((await getAppointmentPostcareState(s.appointmentId)).sentAt).toBeNull();
    });

    test("aftercare is marked only by an explicit click", async ({ page }) => {
      const seed = await seedE2eStudio();
      const s = await seedE2eEndedAppointmentSession(seed, { charted: true });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      expect(await getSessionAftercareStamp(s.sessionId)).toBeNull();
      await expect(page.getByTestId("finish-aftercare-status")).toHaveText("Not marked");
      await finish(page)
        .getByRole("button", {
          name: "Mark: procedure risks explained and aftercare information provided",
        })
        .click();
      await expect
        .poll(async () => await getSessionAftercareStamp(s.sessionId), { timeout: T })
        .not.toBeNull();
      await expect(page.getByTestId("finish-aftercare-status")).toHaveText("Recorded", {
        timeout: T,
      });
    });

    test("leaving without the aftercare stamp warns, and Cancel writes nothing", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      const s = await seedE2eEndedAppointmentSession(seed, { charted: true });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      await finish(page).getByRole("button", { name: /Done — back to client/ }).click();
      await expect(page.getByText(/Aftercare not marked/i)).toBeVisible({ timeout: T });
      // Cancel stays on charting and writes nothing.
      // The dismiss affordance is the full-screen backdrop; the centered panel
      // sits on top of its middle, so click near a corner the way a
      // practitioner tapping "outside" actually would.
      await page
        .getByRole("button", { name: "Close", exact: true })
        .click({ position: { x: 6, y: 6 } });
      await expect(page.getByTestId("finish-appointment")).toBeVisible();
      expect(await getSessionAftercareStamp(s.sessionId)).toBeNull();
    });

    test("one Finish section, one lifecycle control, one postcare surface", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      await setStudioPostcareText(seed.studioId, "Aftercare text.");
      const s = await seedE2eEndedAppointmentSession(seed, { charted: true });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      await expect(page.getByTestId("finish-appointment")).toHaveCount(1);
      await expect(page.getByTestId("mark-appointment-complete")).toHaveCount(1);
      await expect(finish(page).getByText("Postcare email")).toHaveCount(1);
      // Charting NEVER offers no-show.
      await expect(page.getByRole("button", { name: /no-show/i })).toHaveCount(0);
      await expectNoHorizontalScroll(page);
    });

    test("a LASER session with a live entry reads as charted", async ({ page }) => {
      const seed = await seedE2eStudio();
      const s = await seedE2eLaserSessionWithEntry(seed, { deleted: false });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);
      await expect(page.getByTestId("finish-charting-status")).toHaveText(
        "Charting recorded",
      );
    });

    test("a LASER session whose only entry is deleted reads as empty", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      const s = await seedE2eLaserSessionWithEntry(seed, { deleted: true });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);
      await expect(page.getByTestId("finish-charting-status")).toHaveText(
        "No treatment charted yet",
      );
    });

    test("an appointment belonging to ANOTHER client yields no Finish actions", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      const s = await seedE2eCrossClientLinkedSession(seed);
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      // The lineage check (studio AND client) finds no row, so the workflow
      // offers nothing to complete or send.
      await expect(page.getByTestId("mark-appointment-complete")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Send postcare", exact: true }),
      ).toHaveCount(0);
    });

    test("touch targets are at least 44px and the confirmation is usable", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      const s = await seedE2eEndedAppointmentSession(seed, { charted: true });
      await loginAsOwner(page, seed);
      await openSession(page, s.clientId, s.sessionId);

      for (const btn of [
        page.getByTestId("mark-appointment-complete"),
        finish(page).getByRole("button", { name: /Done — back to client/ }),
      ]) {
        const box = await btn.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      // The confirmation dialog is fully on screen, controls reachable.
      await page.getByTestId("mark-appointment-complete").click();
      const dialog = page.getByTestId("confirm-dialog");
      await expect(dialog).toBeVisible({ timeout: T });
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
  });
}

suite("iPhone 390px", { width: 390, height: 844 }, true);
suite("desktop", { width: 1280, height: 900 }, false);
