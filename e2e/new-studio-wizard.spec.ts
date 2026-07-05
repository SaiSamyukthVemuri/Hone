import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  seedE2eStudio,
  seedNoStudioAuthUser,
  seedOperatorAuthUser,
} from "./helpers/seed";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// PR #254: internal New Studio Wizard, proven end to end against the real
// local stack. Only a platform operator (isAdmin / ADMIN_EMAILS) can reach
// /admin/studios/new; anonymous and no-studio non-operator users are gated.
// The operator can create a studio + owner invitation through the real form
// and server action; the owner is account-linked later by the existing
// invite-only first-sign-in path (not by the wizard).

const WIZARD = "/admin/studios/new";

async function loginViaMagicLink(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Agree to Terms of Service and Privacy Policy").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, {
    excludeIds: seen,
  });
  await page.goto(link);
}

test.describe("New Studio Wizard access control", () => {
  test("anonymous users hitting the wizard are redirected to /login", async ({
    page,
  }) => {
    await page.goto(WIZARD);
    await page.waitForURL(/\/login/, { timeout: 20_000 });
  });

  test("a signed-in no-studio NON-operator is gated to /no-access", async ({
    page,
  }) => {
    const { email } = await seedNoStudioAuthUser();
    await loginViaMagicLink(page, email);

    // The wizard is operator-only; a no-studio non-admin is bounced by the
    // PR #253 invite-only gate (the PR #254 carve-out is isAdmin-only).
    await page.goto(WIZARD);
    await page.waitForURL(/\/no-access/, { timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "No studio access yet" }),
    ).toBeVisible();
  });
});

test.describe("operator creates a studio + owner invitation", () => {
  test("operator reaches the wizard (no studio needed) and creates a studio", async ({
    page,
  }) => {
    const { email: operatorEmail } = await seedOperatorAuthUser();
    await loginViaMagicLink(page, operatorEmail);

    // The operator has NO studio but IS an admin email, so the PR #254
    // middleware carve-out lets them reach the internal wizard.
    await page.goto(WIZARD);
    await expect(
      page.getByRole("heading", { name: "New studio", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("Create a studio and owner invitation. Internal setup only."),
    ).toBeVisible();

    const runId = randomUUID().slice(0, 8);
    const slug = `e2e-wizard-${runId}`;
    const ownerEmail = `e2e-wizard-owner-${runId}@harness.local`;

    await page.locator("#name").fill(`E2E Wizard Studio ${runId}`);
    await page.locator("#slug").fill(slug);
    await page.locator("#owner_display_name").fill(`E2E Wizard Owner ${runId}`);
    await page.locator("#owner_email").fill(ownerEmail);
    // timezone defaults to America/Toronto.
    await page
      .getByRole("button", { name: /create studio & owner invitation/i })
      .click();

    // Confirmation panel reads the created rows back via the service-role
    // client — its presence proves both DB writes landed.
    await expect(
      page.getByRole("heading", { name: "Studio created", level: 1 }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("link", { name: `/book/${slug}` }).first(),
    ).toBeVisible();
    await expect(page.getByText(ownerEmail)).toBeVisible();
    // Owner invitation is pending until the owner's first sign-in.
    await expect(page.getByText(/owner · pending/i)).toBeVisible();
    // PR B: accurate onboarding copy — payments connect per studio.
    await expect(
      page.getByText(/Payments are not connected until the studio completes Stripe/),
    ).toBeVisible();
  });

  test("rejects a reserved / malformed slug with an inline error (no studio created)", async ({
    page,
  }) => {
    const { email: operatorEmail } = await seedOperatorAuthUser();
    await loginViaMagicLink(page, operatorEmail);
    await page.goto(WIZARD);

    const runId = randomUUID().slice(0, 8);
    await page.locator("#name").fill(`Reserved Test ${runId}`);
    // "admin" is reserved; bypass the HTML pattern by setting the value and
    // submitting via the action (server-side validation is authoritative).
    await page.locator("#slug").evaluate((el: HTMLInputElement) => {
      el.removeAttribute("pattern");
      el.removeAttribute("required");
    });
    await page.locator("#slug").fill("admin");
    await page.locator("#owner_display_name").fill("R Owner");
    await page.locator("#owner_email").fill(`reserved-${runId}@harness.local`);
    await page
      .getByRole("button", { name: /create studio & owner invitation/i })
      .click();

    // Target the banner text directly (Next's route announcer is also
    // role="alert" but empty, so getByRole("alert") is ambiguous).
    await expect(page.getByText(/is reserved/i)).toBeVisible({
      timeout: 20_000,
    });
    // Still on the form, not the success panel.
    await expect(
      page.getByRole("heading", { name: "New studio", level: 1 }),
    ).toBeVisible();
  });
});

test.describe("Admin Console V1 (PR #255)", () => {
  test("operator sees the console and reaches the wizard from it (no overflow)", async ({
    page,
  }) => {
    const { email: operatorEmail } = await seedOperatorAuthUser();
    await loginViaMagicLink(page, operatorEmail);

    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Admin", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("Internal operator tools for invite-only studio setup."),
    ).toBeVisible();
    // PR B: state-driven banner. The e2e stack runs in Stripe test mode.
    await expect(page.getByText(/Stripe runtime:/)).toBeVisible();
    await expect(
      page.getByText(/test mode — no real charges/),
    ).toBeVisible();
    // Overview cards + studios table render (the studios table exists because
    // the wizard test seeded a studio earlier; either way the heading shows).
    await expect(
      page.getByRole("heading", { name: "Studios", level: 2 }),
    ).toBeVisible();

    // The console must not scroll sideways at a normal desktop width.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The New Studio Wizard is discoverable: click the primary CTA.
    await page
      .getByRole("link", { name: "Create new studio" })
      .first()
      .click();
    await page.waitForURL(/\/admin\/studios\/new/, { timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "New studio", level: 1 }),
    ).toBeVisible();
  });
});

test.describe("Admin studio detail privacy (PR #256)", () => {
  test("detail page shows counts/setup metadata, never a raw client name", async ({
    page,
  }) => {
    // A full studio with an owner + a NAMED client + a service.
    const seed = await seedE2eStudio();
    const { email: operatorEmail } = await seedOperatorAuthUser();
    await loginViaMagicLink(page, operatorEmail);

    await page.goto(`/admin/studios/${seed.studioId}`);
    await expect(
      page.getByRole("heading", { name: seed.studioName, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Counts", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Setup checks", level: 2 }),
    ).toBeVisible();
    // PR B: per-mode payment status section (redacted, counts only). The
    // seeded studio has no Stripe rows, so both mode cards say not
    // connected.
    await expect(page.getByText(/account ids are redacted/)).toBeVisible();
    await expect(
      page.getByText(/No test-mode row — not connected in this mode\./),
    ).toBeVisible();

    // The seeded client NAME must NOT appear anywhere on the detail page.
    await expect(page.getByText(seed.clientName)).toHaveCount(0);

    // No horizontal overflow at desktop width.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
