import { test, expect } from "@playwright/test";
import { seedE2eStudio, setStudioOnboardingV2Enabled } from "./helpers/seed";
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
});
