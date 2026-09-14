import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// ===========================================================================
// THE INVITATION ANSWER SURVIVES ITS OWN REVALIDATION
// ===========================================================================
//
// `inviteToBookAction` calls `revalidatePath` on a COMMITTED admission, which is
// correct — the queue must show the truth at once. The entry then moves
// `waiting` -> `invited`, and a composer is mounted only for
// INVITE_TO_BOOK_STATUSES (`waiting`, `claimed`). So the composer UNMOUNTS on
// exactly the outcomes that carry a delivery disposition.
//
// The first attempt owned the result inside the composer. It rendered for
// `refused` and `indeterminate` (which do not revalidate) and showed NOTHING for
// all three committed cases — the precise inversion of the requirement.
//
// STATIC RENDERING CANNOT CATCH THAT. The notice renders perfectly in isolation
// either way; only a real submission followed by a real revalidation tells the
// truth. That is what this spec does.
// ===========================================================================

const T = 30_000;

/**
 * An OPEN admission round, without which every invite refuses `no_admission_round`
 * — which is a refusal, not a committed admission, and would prove nothing about
 * surviving revalidation.
 */
async function openAdmissionRound(seed: E2eSeed) {
  const owner = await sql<{ user_id: string }>(
    `select user_id from public.practitioners
      where studio_id = $1 and role = 'owner' and user_id is not null limit 1`,
    [seed.studioId],
  );
  await sql(
    `select * from public.open_new_client_waitlist_admission_round($1,$2,20)`,
    [seed.studioId, owner[0]!.user_id],
  );
}

async function seedWaitingEntry(seed: E2eSeed, name: string, email: string) {
  const rows = await sql<{ id: string }>(
    `insert into public.new_client_waitlist_entries
       (id, studio_id, name, email, status, source)
     values (gen_random_uuid(), $1, $2, $3, 'waiting', 'public_booking')
     returning id`,
    [seed.studioId, name, email],
  );
  return rows[0]!.id;
}

/** Open this prospect's disclosure, fill the composer, submit it. */
async function invite(page: Page, name: string) {
  // The composer lives inside a per-row <details>, closed by default. Scope to
  // the details that actually CONTAINS a composer, so an ancestor cannot match.
  const details = page
    .locator('details:has([data-testid="invite-composer"])')
    .filter({ hasText: name })
    .first();
  await details.locator("> summary").click();
  const row = page.locator('[data-testid="invite-composer"]', { hasText: name });
  await expect(row, "composer for this prospect").toBeVisible({ timeout: T });
  // The service select is the one required answer.
  const service = row.locator('[data-testid="composer-service"]');
  await service.selectOption({ index: 1 });
  await row.locator('[data-testid="composer-send"]').click();
}

test.describe("queue navigation cannot strand an in-flight invitation", () => {
  test("every navigation control is inert while a send is pending, and live after", async ({
    page,
  }) => {
    // THE ONLY OBSERVER OF THE RESULT is the boundary's useActionState, and
    // nothing persists it by design. A full navigation mid-flight therefore
    // destroys the answer — while the invitation may already have committed and
    // consumed the round's allowance.
    //
    // The `hold+` recipient prefix keeps the fake transport genuinely IN FLIGHT,
    // which is the only way to observe a pending surface. It releases itself.
    const seed = await seedE2eStudio();
    await openAdmissionRound(seed);
    const name = `Held Person ${seed.runId.slice(0, 6)}`;
    await seedWaitingEntry(seed, name, `hold+${seed.runId}@harness.local`);

    await loginAsOwner(page, seed);
    // THE FOCUSED VIEW, so the queue actually renders navigation to guard:
    // "Back to all groups" exists only here, and it is the control that used to
    // sit ABOVE the boundary entirely.
    await page.goto("/settings/waitlist?section=waiting");
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: T });

    const navs = page.locator('[data-waitlist-nav]');
    const before = await navs.count();
    expect(before, "no queue navigation rendered to guard").toBeGreaterThan(0);

    await invite(page, name);

    // --- DURING THE PENDING INTERVAL -------------------------------------
    // DETERMINISTIC, NOT A FLICKER. The transport holds for HOLD_MS, so the
    // pending state must still be observable well after the submission — an
    // assertion that merely catches a momentary true would pass even if the
    // hold never took effect, which is exactly how the previous version of this
    // proof passed against a transport that was never consulted.
    const submittedAt = Date.now();
    await expect(navs.first()).toHaveAttribute("data-pending", "true", { timeout: T });
    await page.waitForTimeout(1_500);
    await expect(
      navs.first(),
      "pending ended too early — the transport did not actually hold",
    ).toHaveAttribute("data-pending", "true");
    const pendingCount = await navs.count();
    for (let i = 0; i < pendingCount; i += 1) {
      const nav = navs.nth(i);
      // NOT A LINK AT ALL: no href to follow by mouse OR keyboard, and out of
      // the tab order. An aria-disabled label over a live href would still
      // navigate for a keyboard user.
      await expect(nav).toHaveAttribute("aria-disabled", "true");
      expect(await nav.getAttribute("href"), "a usable href survived").toBeNull();
      expect(await nav.evaluate((el) => el.tagName)).not.toBe("A");
    }
    // The URL must not move even if something tries.
    const urlDuring = page.url();
    await navs.first().click({ force: true }).catch(() => undefined);
    expect(page.url(), "navigation happened while pending").toBe(urlDuring);

    // --- AFTER SETTLEMENT -------------------------------------------------
    const notice = page.locator('[data-testid="invite-outcome"]');
    await expect(notice).toBeVisible({ timeout: T });
    await expect(notice).toContainText(name);
    await expect(notice).toContainText(/Invitation created/i);
    // Navigation is operable again, and only AFTER the held window.
    await expect(navs.first()).toHaveAttribute("data-pending", "false", { timeout: T });
    expect(
      Date.now() - submittedAt,
      "settled before the hold could have elapsed",
    ).toBeGreaterThanOrEqual(3_000);
    expect(await navs.first().getAttribute("href")).not.toBeNull();
  });
});

test.describe("delivery status survives revalidation", () => {
  test("a committed invitation reports its delivery AFTER the queue refreshes", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await openAdmissionRound(seed);
    const name = `Queue Person ${seed.runId.slice(0, 6)}`;
    await seedWaitingEntry(seed, name, `wl-${seed.runId}@harness.local`);

    await loginAsOwner(page, seed);
    await page.goto("/settings/waitlist");
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: T });

    await invite(page, name);

    // 1. THE QUEUE UPDATED — the admission committed and revalidation ran.
    await expect(
      page.locator('[data-testid="invite-outcome"]'),
      "the notice did not survive revalidation",
    ).toBeVisible({ timeout: T });

    // 2. THE COMPOSER FOR THIS PROSPECT IS GONE — the row left waiting/claimed.
    await expect(
      page.locator('[data-testid="invite-composer"]', { hasText: name }),
    ).toHaveCount(0);

    // 3. THE NOTICE IS STILL MOUNTED, names the prospect, and reports an
    //    invitation that EXISTS.
    const notice = page.locator('[data-testid="invite-outcome"]');
    await expect(notice).toContainText(name);
    await expect(notice).toContainText(/Invitation created/i);
    await expect(notice).toHaveAttribute("data-invitation-exists", "true");
    // Never a delivery claim nobody observed.
    await expect(notice).not.toContainText(/\b(delivered|opened|read)\b/i);
  });

  test("two prospects cannot wear each other's answer", async ({ page }) => {
    const seed = await seedE2eStudio();
    await openAdmissionRound(seed);
    const first = `Alpha ${seed.runId.slice(0, 6)}`;
    const second = `Beta ${seed.runId.slice(0, 6)}`;
    await seedWaitingEntry(seed, first, `a-${seed.runId}@harness.local`);
    await seedWaitingEntry(seed, second, `b-${seed.runId}@harness.local`);

    await loginAsOwner(page, seed);
    await page.goto("/settings/waitlist");

    await invite(page, first);
    const notice = page.locator('[data-testid="invite-outcome"]');
    await expect(notice).toContainText(first, { timeout: T });

    // The SECOND submission replaces it wholesale — one answer at a time, always
    // the most recent, always named. The first prospect's result must not remain
    // attached to the second.
    await invite(page, second);
    await expect(notice).toContainText(second, { timeout: T });
    await expect(notice).not.toContainText(first);
  });
});
