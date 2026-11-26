import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { markResendLedger, readResendLedger } from "./helpers/resend-ledger";

// ===========================================================================
// INVITE ANYWAY WHEN THE ESTIMATE IS ZERO
//
// With a short day (two slots) and more live invitations out than slots, the estimate for the chosen service is zero. Send then asks first: Cancel sends nothing, Invite anyway sends exactly one email
// through the same invitation flow. Above zero nothing changes. Every recipient is a synthetic harness address on the fake provider, so nothing leaves
// the machine. Run on a desktop and a phone viewport.
// ===========================================================================

const T = 30_000;
const CONFIRM_TEXT = "No estimated consultation availability remains. Invite this person anyway? They may find no appointments available.";

async function ownerId(seed: E2eSeed) {
  const r = await sql<{ user_id: string }>(`select user_id from public.practitioners where studio_id = $1 and role = 'owner' and user_id is not null limit 1`, [seed.studioId]);
  return r[0]!.user_id;
}

async function seedWaiting(seed: E2eSeed, label: string) {
  await sql(`select * from public.open_new_client_waitlist_admission_round($1,$2,100)`, [seed.studioId, await ownerId(seed)]);
  const name = `Anyway Person ${label} ${seed.runId.slice(0, 6)}`;
  const email = `success+anyway-${label}-${seed.runId}@harness.local`;
  const rows = await sql<{ id: string }>(
    `insert into public.new_client_waitlist_entries (id, studio_id, name, email, status, source)
     values (gen_random_uuid(), $1, $2, $3, 'waiting', 'public_booking') returning id`,
    [seed.studioId, name, email],
  );
  return { id: rows[0]!.id, name, email };
}

// The estimate reads zero when the live invitations out are at least the consultations that fit. The day is cut to two slots, so a fortnight holds at
// most about thirty, and forty people are invited through the command with the largest capacity number (no email is sent by this seed).
async function makeEstimateZero(seed: E2eSeed) {
  await sql(`update public.studio_availability_default set open_time = '06:00', close_time = '07:00' where studio_id = $1`, [seed.studioId]);
  const owner = await ownerId(seed);
  const service = await sql<{ id: string }>(`select id from public.services where studio_id = $1 and active limit 1`, [seed.studioId]);
  for (let i = 0; i < 40; i++) {
    const e = await sql<{ entry_id: string }>(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [seed.studioId, owner, `Filler ${i}`, `filler-${i}-${seed.runId}@harness.local`]);
    const a = await sql<{ result: string }>(
      `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,current_date,current_date + 13,null,72,2147483647)`,
      [seed.studioId, owner, e[0]!.entry_id, service[0]!.id],
    );
    expect(a[0]!.result).toBe("admitted");
  }
}
const liveInvitations = async (entryId: string) =>
  (await sql<{ n: number }>(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id = $1 and redeemed_at is null and expired_at is null and released_at is null and declined_at is null`, [entryId]))[0]!.n;

async function openComposer(page: Page, name: string) {
  const entry = page.locator("li[data-entry-id]").filter({ has: page.getByText(name, { exact: true }) });
  const invite = entry.getByTestId("row-invite").locator("> summary");
  if (!await invite.isVisible()) {
    await entry.getByTestId("waitlist-entry-details").locator("> summary").click();
  }
  await invite.click();
  const row = entry.getByTestId("invite-composer");
  await expect(row).toBeVisible({ timeout: T });
  await row.locator('[data-testid="composer-service"]').selectOption({ index: 1 });
  return row;
}

for (const [label, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(`invite anyway at zero (${label})`, () => {
    test.use({ viewport });

    test("Send asks first and Cancel sends nothing", async ({ page }) => {
      test.setTimeout(120_000);
      const seed = await seedE2eStudio();
      const p = await seedWaiting(seed, `cancel-${label}`);
      await makeEstimateZero(seed);
      const mark = markResendLedger();
      await loginAsOwner(page, seed);
      await page.goto("/settings/waitlist?section=waiting");
      const row = await openComposer(page, p.name);
      await expect(row.locator('[data-testid="composer-capacity"]')).toContainText("You can invite 0 more people", { timeout: T });

      await row.locator('[data-testid="composer-send"]').click();
      const confirm = row.locator('[data-testid="composer-beyond-confirm"]');
      await expect(confirm).toBeVisible({ timeout: T });
      await expect(confirm).toContainText(CONFIRM_TEXT);
      await expect(confirm.getByRole("button", { name: "Invite anyway" })).toBeVisible();
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(confirm).toHaveCount(0);

      expect(await liveInvitations(p.id)).toBe(0);
      expect(readResendLedger(mark).filter((r) => r.to.toLowerCase() === p.email.toLowerCase())).toHaveLength(0);
    });

    test("Invite anyway sends exactly one invitation and one email, and the page shows it", async ({ page }) => {
      test.setTimeout(120_000);
      const seed = await seedE2eStudio();
      const p = await seedWaiting(seed, `anyway-${label}`);
      await makeEstimateZero(seed);
      const mark = markResendLedger();
      await loginAsOwner(page, seed);
      await page.goto("/settings/waitlist?section=waiting");
      const row = await openComposer(page, p.name);
      await expect(row.locator('[data-testid="composer-capacity"]')).toContainText("You can invite 0 more people", { timeout: T });

      await row.locator('[data-testid="composer-send"]').click();
      const confirm = row.locator('[data-testid="composer-beyond-confirm"]');
      await expect(confirm).toBeVisible({ timeout: T });
      // A double press sends once: the second click lands on a disabled button or a row that is already invited.
      await confirm.getByRole("button", { name: "Invite anyway" }).dblclick();

      await expect(page.locator('[data-testid="invite-outcome"]').first()).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => liveInvitations(p.id), { timeout: T }).toBe(1);
      const status = await sql<{ status: string }>(`select status from public.new_client_waitlist_entries where id = $1`, [p.id]);
      expect(status[0]!.status).toBe("invited");
      expect(readResendLedger(mark).filter((r) => r.to.toLowerCase() === p.email.toLowerCase())).toHaveLength(1);
      // The counts refresh: the allowance section is still there and now reports the invitation that is out.
      await expect(page.locator('[data-testid="allowance-headline"]')).toBeVisible();
    });

    test("above zero nothing changes: Send sends straight away with no confirmation", async ({ page }) => {
      test.setTimeout(120_000);
      const seed = await seedE2eStudio();
      const p = await seedWaiting(seed, `above-${label}`);
      const mark = markResendLedger();
      await loginAsOwner(page, seed);
      await page.goto("/settings/waitlist?section=waiting");
      const row = await openComposer(page, p.name);
      await expect(row.locator('[data-testid="composer-capacity"]')).not.toContainText("You can invite 0 more people", { timeout: T });
      await expect(row.locator('[data-testid="composer-capacity"]')).toContainText("You can invite", { timeout: T });

      await row.locator('[data-testid="composer-send"]').click();
      await expect(page.locator('[data-testid="invite-outcome"]').first()).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-testid="composer-beyond-confirm"]')).toHaveCount(0);
      expect(await liveInvitations(p.id)).toBe(1);
      expect(readResendLedger(mark).filter((r) => r.to.toLowerCase() === p.email.toLowerCase())).toHaveLength(1);
    });

    test("the page saw room but the server finds none: Send asks, sends nothing, then Invite anyway sends one", async ({ page }) => {
      test.setTimeout(120_000);
      const seed = await seedE2eStudio();
      const p = await seedWaiting(seed, `late-${label}`);
      const mark = markResendLedger();
      await loginAsOwner(page, seed);
      await page.goto("/settings/waitlist?section=waiting");
      const row = await openComposer(page, p.name);
      await expect(row.locator('[data-testid="composer-capacity"]')).toContainText("You can invite", { timeout: T });
      await expect(row.locator('[data-testid="composer-capacity"]')).not.toContainText("You can invite 0 more people");
      // The room goes away after the page read it.
      await makeEstimateZero(seed);

      await row.locator('[data-testid="composer-send"]').click();
      const confirm = row.locator('[data-testid="composer-beyond-confirm"]');
      await expect(confirm).toContainText("No estimated consultation availability remains. Invite this person anyway? They may find no appointments available.", { timeout: 60_000 });
      expect(await liveInvitations(p.id)).toBe(0);
      expect(readResendLedger(mark).filter((r) => r.to.toLowerCase() === p.email.toLowerCase())).toHaveLength(0);

      // The question itself is not an outcome: nothing is announced above the queue for it.
      await expect(page.locator('[data-testid="invite-outcome"]')).toHaveCount(0);

      await confirm.locator('[data-testid="composer-invite-anyway"]').click();
      await expect(page.locator('[data-testid="invite-outcome"]').first()).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => liveInvitations(p.id), { timeout: 30_000 }).toBe(1);
      expect(readResendLedger(mark).filter((r) => r.to.toLowerCase() === p.email.toLowerCase())).toHaveLength(1);
    });
  });
}
