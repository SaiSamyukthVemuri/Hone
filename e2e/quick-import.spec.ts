import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, seedNoStudioAuthUser } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// PR #257: Quick Import V1, proven end to end on the real local stack. An
// owner pastes TSV, previews (grouped + deduped), confirms, and the clients +
// imported memory are created — with no live charting. Anonymous/no-studio
// users cannot reach the import route.

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

test.describe("owner imports clients + treatment memory", () => {
  test("paste TSV, preview groups rows, confirm creates clients and memory", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    await page.goto(IMPORT);
    await expect(
      page.getByRole("heading", { name: "Quick import", level: 2 }),
    ).toBeVisible();

    // Two rows for the same client (two treatment areas) + one other client.
    const maya = `maya-${seed.runId}@example.com`;
    const jordan = `jordan-${seed.runId}@example.com`;
    const tsv = [
      "client_name\temail\ttreatment_area\tlast_visit_date\tprobe_lot",
      `Maya QImport\t${maya}\tUpper lip\t2024-11-02\tL-204`,
      `Maya QImport\t${maya}\tChin\t2024-11-15\tL-205`,
      `Jordan QImport\t${jordan}\tNeck\t2024-10-01\t`,
    ].join("\n");

    await page.locator("#import-text").fill(tsv);
    await page.getByRole("button", { name: /preview import/i }).click();

    // Preview groups the two Maya rows into ONE client (2 clients total).
    await expect(page.getByText("Maya QImport").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Jordan QImport").first()).toBeVisible();
    await expect(page.getByText(/Create/).first()).toBeVisible();
    // Treatment areas surfaced in the preview.
    await expect(page.getByText(/Upper lip/).first()).toBeVisible();

    await page.getByRole("button", { name: /confirm import/i }).click();

    await expect(page.getByText("Import complete")).toBeVisible({
      timeout: 20_000,
    });
    // Created-client links (grouped: Maya appears once).
    await expect(
      page.getByRole("link", { name: "Maya QImport" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("link", { name: "Jordan QImport" }),
    ).toBeVisible();
    await expect(page.getByText(/not charted live in Hone/i)).toBeVisible();

    // No horizontal overflow on the import page.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The imported client appears in the Clients list.
    await page.goto("/clients");
    await expect(page.getByText("Maya QImport").first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
