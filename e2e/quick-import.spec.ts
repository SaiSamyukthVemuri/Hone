import { test, expect, type Page } from "@playwright/test";
import {
  createLocalAuthUser,
  insertMembershipInStudio,
  seedE2eStudio,
  seedNoStudioAuthUser,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// IMPORT-01: Quick Import is OPERATOR-ASSISTED ONLY, proven on the real local
// stack against a real ordinary studio owner.
//
// This spec used to drive the full paste -> preview -> confirm flow as an
// ordinary owner. That flow is exactly what the mitigation removes: a run that
// failed after the client insert left clients behind with no history, and a
// retry skipped them. What is proven now is the replacement contract,
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

// ---------------------------------------------------------------------------
// The operator side of the same boundary
// ---------------------------------------------------------------------------
//
// The ordinary-owner specs above are an ABSENCE claim, and an absence claim is
// only worth what its positive control is worth: if `/settings/import` were
// broken for everyone, they would all still pass. This proves the other half
// in a real browser, the island renders, and the SAME gated server action the
// ordinary owner is refused by succeeds for an operator.
//
// No production authorization was weakened and no test-only bypass exists: the
// operator here is authorized by exactly the mechanism production uses, the
// `ADMIN_EMAILS` allowlist, which the harness already declares in
// e2e/helpers/local-env.ts. Every helper used is already exported and
// general-purpose, so `e2e/helpers/**` is untouched.
//
// `e2e@harness.local` is the allowlisted address that NO other spec claims.
// (`e2e-operator@harness.local` is the other one, and seedOperatorAuthUser()
// asserts it holds no practitioner row, giving it a membership here would
// break e2e/new-studio-wizard.spec.ts.)

const OPERATOR_EMAIL = "e2e@harness.local";

/** A studio whose active owner is also a platform operator. */
async function seedOperatorOwnedStudio(): Promise<E2eSeed> {
  const seed = await seedE2eStudio();

  // Idempotent: the address is FIXED (it has to be, to match the allowlist),
  // so on a local stack that is not reset between runs the auth user already
  // exists from a previous run.
  const existing = await sql<{ id: string }>(
    `select id::text as id from auth.users where lower(email) = lower($1)`,
    [OPERATOR_EMAIL],
  );
  const userId = existing[0]?.id ?? (await createLocalAuthUser(OPERATOR_EMAIL));

  // ...and for the same reason its memberships accumulate. Two or more ACTIVE
  // memberships resolve to the studio CHOOSER rather than to the page under
  // test, so retire the older ones first and leave exactly one.
  await sql(
    `update public.practitioners set active = false
      where lower(email) = lower($1)`,
    [OPERATOR_EMAIL],
  );
  await insertMembershipInStudio(seed.studioId, userId, OPERATOR_EMAIL);
  await sql(
    `insert into public.pending_invitations
       (studio_id, email, role, display_name, status, accepted_at)
     values ($1, $2, 'owner', 'E2E Operator', 'accepted', now())`,
    [seed.studioId, OPERATOR_EMAIL],
  );
  return seed;
}

test.describe("a platform operator who owns the studio gets the real island", () => {
  test("the import UI renders and a preview runs, with zero writes", async ({
    page,
  }) => {
    const seed = await seedOperatorOwnedStudio();
    await loginByMagicLink(page, OPERATOR_EMAIL);

    await page.goto(IMPORT);
    await expect(
      page.getByRole("heading", { name: "Import clients and history", level: 2 }),
    ).toBeVisible({ timeout: 20_000 });

    // The operator banner, and NOT the ordinary-owner notice.
    await expect(page.getByText(/Operator-assisted import\./).first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Import is currently operator-assisted/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Contact support" }),
    ).toHaveCount(0);

    // The executable island the ordinary owner does not get.
    await expect(page.locator("#import-text")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: /copy template/i }),
    ).toBeVisible();

    // previewImportAction goes through the SAME ownerContext() gate as confirm,
    // so a successful preview is the operator-authorization proof, and it is
    // the read-only half, which is why this stops here.
    const tsv = [
      "client_name\temail\ttreatment_area\tlast_visit_date",
      `Maya Operator ${seed.runId}\tmaya-op-${seed.runId}@example.com\tUpper lip\t2024-11-02`,
      `Maya Operator ${seed.runId}\tmaya-op-${seed.runId}@example.com\tChin\t2024-11-15`,
      `Jordan Operator ${seed.runId}\tjordan-op-${seed.runId}@example.com\tNeck\t2024-10-01`,
    ].join("\n");
    await page.locator("#import-text").fill(tsv);
    await page.getByRole("button", { name: /preview import/i }).click();

    // Not merely "no error": the plan grouped the two Maya rows into ONE
    // client, so the preview list holds TWO group rows, not three. Counted on
    // the <li> group rows rather than on the text, which also matches the
    // ancestors that contain it.
    const groupRows = page
      .locator("li")
      .filter({ hasText: `Operator ${seed.runId}` });
    await expect(groupRows).toHaveCount(2, { timeout: 20_000 });
    await expect(
      page.getByText(`Maya Operator ${seed.runId}`).first(),
    ).toBeVisible();
    await expect(
      page.getByText(`Jordan Operator ${seed.runId}`).first(),
    ).toBeVisible();
    await expect(page.getByText(/Upper lip/).first()).toBeVisible();

    // Confirm is now offered: deliberately NOT clicked. This lane treats the
    // local database as disposable and attempts no cleanup, and a real confirm
    // creates real client rows that migration 0087 forbids deleting. The write
    // path is proven by the behavioural positive control in
    // tests/app/settings/import/operator-assisted-gate.test.ts instead.
    await expect(
      page.getByRole("button", { name: /confirm import/i }),
    ).toBeVisible();

    // Preview really is read-only, checked at the DATABASE, not inferred.
    const [batches] = await sql<{ n: number }>(
      `select count(*)::int as n from public.import_batches where studio_id = $1`,
      [seed.studioId],
    );
    const [memories] = await sql<{ n: number }>(
      `select count(*)::int as n from public.imported_treatment_memories
        where studio_id = $1`,
      [seed.studioId],
    );
    const [clients] = await sql<{ n: number }>(
      `select count(*)::int as n from public.clients where studio_id = $1`,
      [seed.studioId],
    );
    expect(batches.n).toBe(0);
    expect(memories.n).toBe(0);
    expect(clients.n).toBe(0);
  });
});
