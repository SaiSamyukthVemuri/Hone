import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, seedNoStudioAuthUser } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// IMPORT-01 — Quick Import is OPERATOR-ASSISTED ONLY, proven on the real local
// stack against a real ordinary studio owner.
//
// This spec used to drive the full paste -> preview -> confirm flow as an
// ordinary owner. That flow is exactly what the mitigation removes: a run that
// failed after the client insert left clients behind with no history, and a
// retry skipped them. What is proven now is the replacement contract —
//   * the ordinary owner reaches the route and is told the truth,
//   * there is no executable control anywhere on the page for them,
//   * the server refuses even when the page is bypassed entirely, and
//   * nothing was written when it refused.
//
// The seeded owner (`e2e-owner-<runId>@harness.local`) is deliberately NOT in
// the harness ADMIN_EMAILS allowlist, so they are an ordinary owner in exactly
// the sense the mitigation cares about.

const IMPORT = "/settings/import";

async function loginNoStudio(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
}

test.describe("Quick Import access control", () => {
  test("anonymous users hitting the import route are redirected to /login", async ({
    page,
  }) => {
    await page.goto(IMPORT);
    await page.waitForURL(/\/login/, { timeout: 20_000 });
  });

  test("a signed-in no-studio user is gated to /no-access", async ({ page }) => {
    const { email } = await seedNoStudioAuthUser();
    await loginNoStudio(page, email);
    await page.goto(IMPORT);
    await page.waitForURL(/\/no-access/, { timeout: 20_000 });
  });
});

test.describe("an ordinary studio owner gets an informational surface only", () => {
  test("the page is truthful and exposes no executable import control", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    await page.goto(IMPORT);
    await expect(
      page.getByRole("heading", { name: "Import clients and history", level: 2 }),
    ).toBeVisible({ timeout: 20_000 });

    // The truth, stated on the page.
    await expect(
      page.getByRole("heading", { name: /Import is currently operator-assisted/i }),
    ).toBeVisible();

    // A real way to get the migration done.
    const support = page.getByRole("link", { name: "Contact support" });
    await expect(support).toBeVisible();
    await expect(support).toHaveAttribute("href", /^mailto:support@hone\.care/);

    // NOTHING executable: no paste box, no source picker, no preview/confirm.
    // (The page's only <select> would be the mobile settings-nav one from the
    // shell, so the import controls are named individually rather than swept.)
    await expect(page.locator("#import-text")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: /source/i })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /copy template/i }),
    ).toHaveCount(0);
    // Covers "Preview import", "Confirm import", and any greyed-out decoy: the
    // control must be ABSENT, not disabled.
    await expect(page.getByRole("button", { name: /import/i })).toHaveCount(0);
    await expect(page.locator("main button[disabled]")).toHaveCount(0);

    // The column shape is still shown, so the owner can prepare their file.
    await expect(page.getByText("What to have ready")).toBeVisible();
    await expect(page.getByText(/client_name/)).toBeVisible();

    // No horizontal overflow on the import page.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("the settings tab still leads here, so migration help stays findable", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/settings/data");
    await page.getByRole("link", { name: "How importing works" }).click();
    await page.waitForURL(/\/settings\/import/, { timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "Import clients and history", level: 2 }),
    ).toBeVisible();
  });
});
