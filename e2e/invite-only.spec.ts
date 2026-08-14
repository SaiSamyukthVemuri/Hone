import { test, expect } from "@playwright/test";
import { seedNoStudioAuthUser } from "./helpers/seed";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// PR #253: invite-only auth + no-studio gate, proven end to end against
// the real local stack. Hone is invite-only for supervised studios: a
// signed-in user with no studio membership (an uninvited account) must be
// gated to /no-access, never the app shell or any studio data.

test.describe("invite-only login page", () => {
  test("the login page presents sign-in only, with invite-only copy and no signup CTA", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Sign in to Hone", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Invited users only\. Use the email address your studio invitation was sent to\./,
      ),
    ).toBeVisible();
    // No self-serve signup / create-studio CTA anywhere on the page.
    await expect(
      page.getByRole("button", { name: /sign up|create account|create studio|start free/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /sign up|create account|create studio|start free/i }),
    ).toHaveCount(0);
  });

  test("the consent gate reads as invited-email confirmation, not legal acceptance", async ({
    page,
  }) => {
    await page.goto("/login");

    // The checkbox label frames itself as identity confirmation, not acceptance.
    await expect(
      page.getByText(
        /I['’]m using the email address my studio invitation was sent to\./,
      ),
    ).toBeVisible();
    // Terms/Privacy appear only as informational links with acceptance deferred
    // to when the owner actually joins a studio.
    await expect(page.getByRole("link", { name: "Terms of Service" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
    await expect(
      page.getByText(/confirm the current versions when you join a studio/i),
    ).toBeVisible();

    // The stale legal-acceptance phrasing never renders anywhere on the page.
    await expect(
      page.getByText(/agree to the Terms of Service and Privacy Policy/i),
    ).toHaveCount(0);

    // The gate is the checkbox: the Send button is disabled until the invited-
    // email confirmation is ticked, then enabled, no acceptance is implied.
    const sendBtn = page.getByRole("button", { name: /send magic link/i });
    await page.locator("#login-email").fill("someone@studio.com");
    await expect(sendBtn).toBeDisabled();
    await page
      .getByRole("checkbox", { name: /using my invited email address/i })
      .check();
    await expect(sendBtn).toBeEnabled();
  });
});

test.describe("no-studio authenticated user is gated", () => {
  test("an uninvited signed-in user lands on /no-access, not the dashboard", async ({
    page,
  }) => {
    const { email } = await seedNoStudioAuthUser();

    // Real magic-link sign-in. The account EXISTS (created above), so the
    // OTP is sent even though shouldCreateUser is false for uninvited
    // emails; the account simply has no studio.
    await page.goto("/login");
    await page
      .getByLabel("I am using my invited email address")
      .check();
    await page.locator("#login-email").fill(email);
    const seen = await listMessageIds(email);
    await page.getByRole("button", { name: /send magic link/i }).click();
    const link = await waitForMagicLink(email, E2E_APP_ORIGIN, {
      excludeIds: seen,
    });

    // The callback default-redirects to /dashboard, where the app-shell
    // guard (requirePractitionerWithStudio) sends a no-studio user on to
    // the safe /no-access gate.
    await page.goto(link);
    await page.waitForURL(/\/no-access/, { timeout: 30_000 });

    await expect(
      page.getByRole("heading", { name: "No studio access yet" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Hone is currently invite-only for supervised studios/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Contact Hone" })).toBeVisible();

    // No app navigation / studio data leaks onto the gate.
    await expect(page.getByRole("link", { name: "Clients" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Calendar" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Records" })).toHaveCount(0);

    // Hitting an app route directly also redirects to the gate (server-side).
    for (const route of ["/dashboard", "/clients", "/calendar", "/records", "/settings/studio"]) {
      await page.goto(route);
      await page.waitForURL(/\/no-access/, { timeout: 20_000 });
    }

    // Sign out returns to /login.
    await page.goto("/no-access");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/, { timeout: 20_000 });
  });

  test("an anonymous user hitting an app route is redirected to /login", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    // The /no-access gate itself bounces anonymous users to /login.
    await page.goto("/no-access");
    await page.waitForURL(/\/login/, { timeout: 20_000 });
  });
});
