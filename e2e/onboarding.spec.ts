import { test, expect } from "@playwright/test";
import { seedE2eStudio, setStudioOnboardingV2Enabled, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Onboarding v2 (migration 0140), proven end to end against the real local
// stack. A seeded studio already has a service + full availability + slug, so
// the three REQUIRED setup steps are done; the wizard exercises the welcome →
// walk → optional-payments-skip → celebration path, the pinned setup card, and
// the dismiss/resume behaviour. The flag-OFF case proves the byte-for-byte
// legacy dashboard.
//
// The admin welcome-email SEND + resend flows (success / rejection / exception /
// retry / in-progress / no-duplicate / no-delivered) are covered end to end via
// the fake-Resend transport in e2e/welcome-email-admin.spec.ts (and the
// studio-create success path in e2e/new-studio-wizard.spec.ts).

const WIZARD = '[data-testid="onboarding-wizard"]';

test.describe("onboarding v2 — flag OFF (default) is unchanged", () => {
  test("no wizard, and the legacy getting-started link is shown", async ({
    page,
  }) => {
    const seed = await seedE2eStudio(); // flag defaults OFF
    await loginAsOwner(page, seed);

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // No onboarding-v2 wizard or pinned card.
    await expect(page.locator(WIZARD)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Finish setting up your studio" }),
    ).toHaveCount(0);
    // The legacy getting-started dashboard link still renders (its "N of M
    // steps complete" text is unique to that card, unlike the header menu link).
    await expect(
      page.getByText(/\d+ of \d+ steps complete/).first(),
    ).toBeVisible();
  });
});

test.describe("onboarding v2 — flag ON", () => {
  test("auto-opens, walks the steps, skips payments, celebrates, completes", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setStudioOnboardingV2Enabled(seed.studioId, true);
    await loginAsOwner(page, seed);

    // Wizard auto-opens at the welcome step.
    const wizard = page.locator(WIZARD);
    await expect(wizard).toBeVisible();
    await expect(
      wizard.getByRole("heading", { name: "Welcome to Hone" }),
    ).toBeVisible();
    await expect(wizard.getByText(/Step 1 of 6/)).toBeVisible();

    // Get started -> the three required data steps are already satisfied by the
    // seed, so each shows Done + Continue.
    await wizard.getByRole("button", { name: "Get started" }).click();
    await expect(
      wizard.getByRole("heading", { name: "Create your first service" }),
    ).toBeVisible();
    await expect(wizard.getByText("✓ Done")).toBeVisible();
    await wizard.getByRole("button", { name: "Continue" }).click();

    await expect(
      wizard.getByRole("heading", { name: "Set your availability" }),
    ).toBeVisible();
    await wizard.getByRole("button", { name: "Continue" }).click();

    await expect(
      wizard.getByRole("heading", { name: "Your booking page is live" }),
    ).toBeVisible();
    // The live booking URL is shown for preview/copy.
    await expect(wizard.getByText(`/book/${seed.slug}`)).toBeVisible();
    await wizard.getByRole("button", { name: "Continue" }).click();

    // Optional payments -> skip.
    await expect(
      wizard.getByRole("heading", { name: "Connect payments (optional)" }),
    ).toBeVisible();
    await wizard.getByRole("button", { name: "Skip for now" }).click();

    // Success + celebration.
    await expect(
      wizard.getByRole("heading", { name: "You're ready" }),
    ).toBeVisible();
    await wizard.getByRole("button", { name: "Go to dashboard" }).click();

    // Wizard closes and the pinned setup card is gone (onboarding complete).
    await expect(page.locator(WIZARD)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Finish setting up your studio" }),
    ).toHaveCount(0);
  });

  test("dismiss keeps progress; the pinned card re-opens the wizard", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setStudioOnboardingV2Enabled(seed.studioId, true);
    await loginAsOwner(page, seed);

    const wizard = page.locator(WIZARD);
    await expect(wizard).toBeVisible();

    // Close the overlay -> wizard gone, pinned card remains (progress preserved;
    // the persisted dismissed/resume state is covered by the model unit tests +
    // the studio_onboarding DB test — asserted here is the re-openability).
    await wizard.getByRole("button", { name: "Close setup" }).click();
    await expect(page.locator(WIZARD)).toHaveCount(0);
    const card = page.getByRole("heading", {
      name: "Finish setting up your studio",
    });
    await expect(card).toBeVisible();

    // Re-open from the card.
    await page
      .getByRole("button", { name: /Continue setup|Start setup/ })
      .click();
    await expect(page.locator(WIZARD)).toBeVisible();
  });

  // PERF-01C negative control. The local completion override is a BRIDGE, not a
  // latch: once a server render confirms completion it must retire, so a LATER
  // server model that says incomplete regains authority.
  //
  // Driven through a QUERY-ONLY navigation on purpose. That keeps the same route
  // and therefore the same mounted client component, which is exactly the case a
  // full reload would hide — a remount would clear the flag for the wrong reason
  // and the test would pass without proving anything.
  test("a later INCOMPLETE server model can show the card again", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setStudioOnboardingV2Enabled(seed.studioId, true);
    await loginAsOwner(page, seed);

    // 1-2. Complete onboarding; the surface goes, and the server model agrees.
    const wizard = page.locator(WIZARD);
    await expect(wizard).toBeVisible();
    await wizard.getByRole("button", { name: "Get started" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Skip for now" }).click();
    await wizard.getByRole("button", { name: "Go to dashboard" }).click();
    const card = page.getByRole("heading", {
      name: "Finish setting up your studio",
    });
    await expect(card).toHaveCount(0);

    // 3. The override has been retired by the confirmed model. 4. Now make the
    // authoritative model INCOMPLETE again, as another tab would.
    await sql(`update services set active = false where studio_id = $1`, [
      seed.studioId,
    ]);

    // 5. Same-route, query-only navigation: the client component survives, so
    // only a retired override lets the server's answer through.
    await page.locator('[data-testid="dashboard-next-day"]').click();
    await expect(card).toBeVisible();
  });

  // PERF-01C negative control. markCelebrationShownAction no longer revalidates
  // the dashboard, so a MOUNTED wizard keeps carrying shouldCelebrate=true. The
  // confetti must still be one-time: closing the success step and reopening it
  // from the pinned card is synchronous and must NOT replay it.
  test("the celebration is consumed once, and reopening does not replay it", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setStudioOnboardingV2Enabled(seed.studioId, true);
    await loginAsOwner(page, seed);

    const wizard = page.locator(WIZARD);
    // Presence, not visibility: the confetti container is `h-0` with
    // `overflow-hidden`, so Playwright cannot call the pieces visible. Whether
    // they are IN THE DOM is exactly what distinguishes a replay from none.
    const confetti = wizard.locator(".hone-confetti");
    await expect(wizard).toBeVisible();
    await wizard.getByRole("button", { name: "Get started" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Skip for now" }).click();

    // It plays on the legitimate first completion.
    await expect(
      wizard.getByRole("heading", { name: "You're ready" }),
    ).toBeVisible();
    await expect(confetti).not.toHaveCount(0);

    // The stamp is persisted by the action.
    await expect
      .poll(async () => {
        const rows = await sql<{ celebrated_at: string | null }>(
          `select celebrated_at from studio_onboarding where studio_id = $1`,
          [seed.studioId],
        );
        return rows[0]?.celebrated_at != null;
      })
      .toBe(true);

    // Close WITHOUT completing, then reopen from the pinned card. Same mounted
    // wizard, so shouldCelebrate is still true in its props — the confetti must
    // not return.
    await wizard.getByRole("button", { name: "Close setup" }).click();
    await expect(page.locator(WIZARD)).toHaveCount(0);
    await page
      .getByRole("button", { name: /Continue setup|Start setup/ })
      .click();
    await expect(page.locator(WIZARD)).toBeVisible();
    await expect(
      page.locator(WIZARD).getByRole("heading", { name: "You're ready" }),
    ).toBeVisible();
    await expect(page.locator(WIZARD).locator(".hone-confetti")).toHaveCount(0);
  });
});
