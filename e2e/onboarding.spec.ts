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

  // PERF-01C negative control. A celebration the server REFUSED to stamp must
  // stay owed. `markCelebrationShownAction` re-checks the LIVE model and returns
  // not_ready when required setup is no longer green, so the client must not
  // consume a celebration on mere visual playback.
  //
  // The refusal is made deterministic rather than raced: the wizard renders the
  // done step from a model captured BEFORE the services are deactivated, so the
  // confetti mounts from that stale model while the action's own live re-check
  // refuses.
  test("a REFUSED stamp leaves the celebration owed, and it can play again", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setStudioOnboardingV2Enabled(seed.studioId, true);
    await loginAsOwner(page, seed);

    const wizard = page.locator(WIZARD);
    await expect(wizard).toBeVisible();
    await wizard.getByRole("button", { name: "Get started" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();

    // The rendered model still says the celebration is owed; the SERVER is about
    // to disagree.
    await sql(`update services set active = false where studio_id = $1`, [
      seed.studioId,
    ]);
    await wizard.getByRole("button", { name: "Skip for now" }).click();
    await expect(
      wizard.getByRole("heading", { name: "You're ready" }),
    ).toBeVisible();

    // The stamp is REFUSED, so celebrated_at stays null.
    await expect
      .poll(async () => {
        const rows = await sql<{ celebrated_at: string | null }>(
          `select celebrated_at from studio_onboarding where studio_id = $1`,
          [seed.studioId],
        );
        return rows[0]?.celebrated_at ?? null;
      })
      .toBeNull();

    // Closing must NOT consume what the server never recorded: reopening the
    // same mounted wizard still offers the celebration.
    await wizard.getByRole("button", { name: "Close setup" }).click();
    await expect(page.locator(WIZARD)).toHaveCount(0);
    await page
      .getByRole("button", { name: /Continue setup|Start setup/ })
      .click();
    await expect(page.locator(WIZARD)).toBeVisible();
    await expect(
      page.locator(WIZARD).locator(".hone-confetti"),
    ).not.toHaveCount(0);
  });

  // PERF-01C negative control. THE RETRY AFTER A REFUSAL.
  //
  // The browser-observable half of the #658 P3: a celebration the server refused
  // stays owed, the owner reopens, and the RETRY succeeds. The close belonging to
  // the FIRST showing must not combine with the SECOND showing's stamp — or the
  // celebration the owner is looking at right now vanishes before they close it.
  //
  // Determinism: the refusal is forced (services deactivated after the done-step
  // model rendered) and so is the recovery (reactivated before the reopen), so
  // both stamp outcomes are certain. What is NOT pinned here is whether the
  // revalidated model lands while the retry is still in flight; the assertion
  // holds either way. That interleaving is pinned deterministically in
  // tests/lib/onboarding/celebration-machine.test.ts, where it can be written
  // down rather than raced.
  test("a retry after a refusal is not spent by the previous showing's close", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setStudioOnboardingV2Enabled(seed.studioId, true);
    await loginAsOwner(page, seed);

    const wizard = page.locator(WIZARD);
    await expect(wizard).toBeVisible();
    await wizard.getByRole("button", { name: "Get started" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();

    // Force the refusal: the rendered model still says the celebration is owed.
    await sql(`update services set active = false where studio_id = $1`, [
      seed.studioId,
    ]);
    await wizard.getByRole("button", { name: "Skip for now" }).click();
    await expect(
      wizard.getByRole("heading", { name: "You're ready" }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const rows = await sql<{ celebrated_at: string | null }>(
          `select celebrated_at from studio_onboarding where studio_id = $1`,
          [seed.studioId],
        );
        return rows[0]?.celebrated_at ?? null;
      })
      .toBeNull();

    // The owner closes the refused showing. This is the close that must not
    // outlive its showing.
    await wizard.getByRole("button", { name: "Close setup" }).click();
    await expect(page.locator(WIZARD)).toHaveCount(0);

    // Setup is genuinely green again, so the server owes the celebration and the
    // retry will succeed.
    await sql(`update services set active = true where studio_id = $1`, [
      seed.studioId,
    ]);
    await page
      .getByRole("button", { name: /Continue setup|Start setup/ })
      .click();
    await expect(page.locator(WIZARD)).toBeVisible();
    await expect(
      page.locator(WIZARD).locator(".hone-confetti"),
    ).not.toHaveCount(0);

    // The retry lands.
    await expect
      .poll(async () => {
        const rows = await sql<{ celebrated_at: string | null }>(
          `select celebrated_at from studio_onboarding where studio_id = $1`,
          [seed.studioId],
        );
        return rows[0]?.celebrated_at != null;
      })
      .toBe(true);

    // THE ASSERTION. A confirmed stamp alone spends nothing: this showing has not
    // been closed, so the confetti is still owed to the owner. The old close
    // belongs to a showing that is over.
    await expect(
      page.locator(WIZARD).locator(".hone-confetti"),
    ).not.toHaveCount(0);

    // And once THIS showing is closed, it is spent for real.
    await page
      .locator(WIZARD)
      .getByRole("button", { name: "Close setup" })
      .click();
    await expect(page.locator(WIZARD)).toHaveCount(0);
    await page
      .getByRole("button", { name: /Continue setup|Start setup/ })
      .click();
    await expect(page.locator(WIZARD)).toBeVisible();
    await expect(page.locator(WIZARD).locator(".hone-confetti")).toHaveCount(0);
  });

  // PERF-01C negative control. The close may land BEFORE the stamp resolves.
  // Suppression is a conjunction computed during render, so neither ordering has
  // its own branch — this drives the close-first ordering explicitly and asserts
  // the settled outcome is still correct once the stamp is confirmed.
  test("closing before the stamp resolves still settles correctly", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setStudioOnboardingV2Enabled(seed.studioId, true);
    await loginAsOwner(page, seed);

    const wizard = page.locator(WIZARD);
    await expect(wizard).toBeVisible();
    await wizard.getByRole("button", { name: "Get started" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Continue" }).click();
    await wizard.getByRole("button", { name: "Skip for now" }).click();

    // Close IMMEDIATELY — no wait for the heading, the confetti or the action.
    // This is the ordering that also fires dismissOnboardingAction, which DOES
    // revalidate /dashboard: that render can return a model still saying
    // shouldCelebrate=true because the stamp has not committed yet. A model that
    // stale must NOT discard the recorded close, or the conjunction never
    // completes and a reopen replays the confetti.
    await wizard.getByRole("button", { name: "Close setup" }).click();
    await expect(page.locator(WIZARD)).toHaveCount(0);

    // The stamp still lands: this studio is genuinely complete.
    await expect
      .poll(async () => {
        const rows = await sql<{ celebrated_at: string | null }>(
          `select celebrated_at from studio_onboarding where studio_id = $1`,
          [seed.studioId],
        );
        return rows[0]?.celebrated_at != null;
      })
      .toBe(true);

    // With the stamp confirmed and the wizard closed, reopening does not replay.
    await page
      .getByRole("button", { name: /Continue setup|Start setup/ })
      .click();
    await expect(page.locator(WIZARD)).toBeVisible();
    await expect(page.locator(WIZARD).locator(".hone-confetti")).toHaveCount(0);

    // And again after a second close/reopen: a close discarded by a stale
    // in-flight model would leave the conjunction incomplete and replay here.
    await page.locator(WIZARD).getByRole("button", { name: "Close setup" }).click();
    await expect(page.locator(WIZARD)).toHaveCount(0);
    await page
      .getByRole("button", { name: /Continue setup|Start setup/ })
      .click();
    await expect(page.locator(WIZARD)).toBeVisible();
    await expect(page.locator(WIZARD).locator(".hone-confetti")).toHaveCount(0);
  });

  // PERF-01C negative control. An INCOMPLETE studio can never consume the
  // one-time celebration: the server gate refuses, so the stamp stays absent and
  // the celebration remains owed for when setup is genuinely finished.
  test("an incomplete studio cannot consume the celebration early", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await setStudioOnboardingV2Enabled(seed.studioId, true);
    await sql(`update services set active = false where studio_id = $1`, [
      seed.studioId,
    ]);
    await loginAsOwner(page, seed);

    await expect(page.locator(WIZARD)).toBeVisible();
    // Setup is not green, so no celebration is offered and none is stamped.
    await expect(page.locator(WIZARD).locator(".hone-confetti")).toHaveCount(0);
    const rows = await sql<{ celebrated_at: string | null }>(
      `select celebrated_at from studio_onboarding where studio_id = $1`,
      [seed.studioId],
    );
    expect(rows[0]?.celebrated_at ?? null).toBeNull();
  });
});
