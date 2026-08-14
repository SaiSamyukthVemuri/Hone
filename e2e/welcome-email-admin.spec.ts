import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  insertBareStudio,
  insertPendingInvite,
  seedOperatorAuthUser,
  seedWelcomeEmailInProgress,
  getWelcomeEmailStateByStudio,
  countStudiosByOwnerEmail,
  countPendingInvitesForStudio,
} from "./helpers/seed";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// Defect 4: welcome-email delivery hardening, proven END TO END through the
// REAL admin "Resend welcome email" control (/admin/studios/[id]) against the
// local stack + the fake-Resend transport. Per-recipient mode control lets a
// single server run exercise every send outcome by seeding the studio's
// owner_email with a mode prefix (success / reject+ / throw+ / failonce+).
//
// The DB-fault + CAS properties that can't be driven through the UI,
// claim-DB-failure (no false success), stamp-write-failure (bounded marker),
// and stale-attempt-cannot-overwrite, are proven at the adapter/DB layer:
//   tests/lib/email/deliver-welcome-email.test.ts (claim error -> failed, no
//     send; stamp write error -> sent + bounded marker; superseded stamp)
//   tests/db/welcome-email-claim.db.test.ts (compare-and-set: a stale attempt
//     cannot overwrite a newer result; two concurrent claims -> exactly one).

test.describe("welcome-email admin resend: fake Resend", () => {
  test.skip(
    process.env.HONE_E2E_FAKE_RESEND !== "1",
    "requires HONE_E2E_FAKE_RESEND=1",
  );

  async function loginOperator(page: Page): Promise<void> {
    const { email } = await seedOperatorAuthUser();
    await page.goto("/login");
    await page.getByLabel("I am using my invited email address").check();
    await page.locator("#login-email").fill(email);
    const seen = await listMessageIds(email);
    await page.getByRole("button", { name: /send magic link/i }).click();
    const link = await waitForMagicLink(email, E2E_APP_ORIGIN, {
      excludeIds: seen,
    });
    await page.goto(link);
  }

  function resendButton(page: Page) {
    return page.getByRole("button", { name: /resend welcome email/i });
  }
  function statusMessage(page: Page) {
    return page.getByTestId("welcome-resend-status");
  }

  test("success → sent (operator sees 'Welcome email sent.')", async ({
    page,
  }) => {
    const studio = await insertBareStudio("welcome-ok");
    await loginOperator(page);
    await page.goto(`/admin/studios/${studio.studioId}`);

    await resendButton(page).click();
    await expect(statusMessage(page)).toHaveText(/Welcome email sent\./);

    await expect
      .poll(async () => (await getWelcomeEmailStateByStudio(studio.studioId))?.status)
      .toBe("sent");
    const state = await getWelcomeEmailStateByStudio(studio.studioId);
    expect(state?.lastSentAt).not.toBeNull();
    // The page reflects the send but never claims a "delivered" state.
    await expect(page.getByText(/delivered/i)).toHaveCount(0);
  });

  test("provider rejection → failed (truthful operator message)", async ({
    page,
  }) => {
    const runId = randomUUID().slice(0, 8);
    const studio = await insertBareStudio(
      "welcome-reject",
      `reject+${runId}@harness.local`,
    );
    await loginOperator(page);
    await page.goto(`/admin/studios/${studio.studioId}`);

    await resendButton(page).click();
    await expect(statusMessage(page)).toHaveText(
      /Send failed\. Please try again\./,
    );
    await expect
      .poll(async () => (await getWelcomeEmailStateByStudio(studio.studioId))?.status)
      .toBe("failed");
  });

  test("provider exception → failed", async ({ page }) => {
    const runId = randomUUID().slice(0, 8);
    const studio = await insertBareStudio(
      "welcome-throw",
      `throw+${runId}@harness.local`,
    );
    await loginOperator(page);
    await page.goto(`/admin/studios/${studio.studioId}`);

    await resendButton(page).click();
    await expect(statusMessage(page)).toHaveText(
      /Send failed\. Please try again\./,
    );
    await expect
      .poll(async () => (await getWelcomeEmailStateByStudio(studio.studioId))?.status)
      .toBe("failed");
  });

  test("retry after a failed attempt succeeds", async ({ page }) => {
    const runId = randomUUID().slice(0, 8);
    // failonce: the first send throws, the retry succeeds.
    const studio = await insertBareStudio(
      "welcome-retry",
      `failonce+${runId}@harness.local`,
    );
    await loginOperator(page);
    await page.goto(`/admin/studios/${studio.studioId}`);

    await resendButton(page).click();
    await expect(statusMessage(page)).toHaveText(
      /Send failed\. Please try again\./,
    );
    await expect
      .poll(async () => (await getWelcomeEmailStateByStudio(studio.studioId))?.status)
      .toBe("failed");

    // The button re-enables after the transition; a second click retries and,
    // because status is no longer 'sending', claims a fresh attempt and sends.
    await expect(resendButton(page)).toBeEnabled();
    await resendButton(page).click();
    await expect(statusMessage(page)).toHaveText(/Welcome email sent\./);
    await expect
      .poll(async () => (await getWelcomeEmailStateByStudio(studio.studioId))?.status)
      .toBe("sent");
  });

  test("a second caller during a live attempt sees in-progress, not sent", async ({
    page,
  }) => {
    const studio = await insertBareStudio("welcome-inflight");
    // Another caller already owns the single-flight claim (status 'sending').
    const liveAttempt = await seedWelcomeEmailInProgress(studio.studioId);
    await loginOperator(page);
    await page.goto(`/admin/studios/${studio.studioId}`);

    await resendButton(page).click();
    await expect(statusMessage(page)).toHaveText(
      /A send is already in progress, nothing sent this time\./,
    );

    // Nothing was sent: the live attempt still owns the claim and no result was
    // stamped (status stays 'sending', the attempt id is unchanged, no send ts).
    const state = await getWelcomeEmailStateByStudio(studio.studioId);
    expect(state?.status).toBe("sending");
    expect(state?.attemptId).toBe(liveAttempt);
    expect(state?.lastSentAt).toBeNull();
  });

  test("resending never duplicates the studio/invitation, never shows delivered or raw text", async ({
    page,
  }) => {
    const studio = await insertBareStudio("welcome-nodup");
    await insertPendingInvite(studio.studioId, studio.ownerEmail, "owner");
    const studiosBefore = await countStudiosByOwnerEmail(studio.ownerEmail);
    const invitesBefore = await countPendingInvitesForStudio(studio.studioId);

    await loginOperator(page);
    await page.goto(`/admin/studios/${studio.studioId}`);

    // Two successful resends.
    await resendButton(page).click();
    await expect(statusMessage(page)).toHaveText(/Welcome email sent\./);
    await expect(resendButton(page)).toBeEnabled();
    await resendButton(page).click();
    await expect(statusMessage(page)).toHaveText(/Welcome email sent\./);

    // No duplicate studio or invitation was created by the resends.
    expect(await countStudiosByOwnerEmail(studio.ownerEmail)).toBe(studiosBefore);
    expect(await countPendingInvitesForStudio(studio.studioId)).toBe(
      invitesBefore,
    );

    // The send-outcome message never leaks a "delivered" claim, the recipient
    // address, or any provider / raw DB text.
    const msg = (await statusMessage(page).textContent()) ?? "";
    expect(msg).toMatch(/Welcome email sent\./);
    expect(msg.toLowerCase()).not.toContain("delivered");
    expect(msg).not.toContain(studio.ownerEmail);
    expect(msg.toLowerCase()).not.toContain("rejected");
    expect(msg.toLowerCase()).not.toContain("exception");
    expect(msg.toLowerCase()).not.toContain("fake resend");
    // The whole page never asserts a delivered/opened state.
    await expect(page.getByText(/delivered/i)).toHaveCount(0);
  });
});
