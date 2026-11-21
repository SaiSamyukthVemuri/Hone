import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { markResendLedger, readResendLedger } from "./helpers/resend-ledger";

// ===========================================================================
// INVITE BEYOND THE ESTIMATE, THROUGH NORMAL NAVIGATION
// ===========================================================================
//
// An owner reaches the page the way Chloe does: the Waitlist entry in the main navigation, then the link on the Waitlist page. Never by typing the
// address. She chooses clients, confirms once, and the background route (called with the lane's cron secret, as the scheduler would) sends the rest.
// All data is synthetic, and every recipient is a `hold+` @harness.local address on the fake provider, so nothing leaves the machine; `hold` keeps each
// send in flight for a few seconds, which is what leaves part of the batch for the background route (the confirm step only runs a short first stretch).

const T = 30_000;
const CRON_SECRET = "dummy-cron-secret"; // e2e/helpers/local-env.ts
const RECIPIENTS = 6;

async function ownerUserId(seed: E2eSeed) {
  const r = await sql<{ user_id: string }>(`select user_id from public.practitioners where studio_id = $1 and role = 'owner' and user_id is not null limit 1`, [seed.studioId]);
  return r[0]!.user_id;
}

async function seedWaiting(seed: E2eSeed, count: number, prefixes: string[] = []) {
  const owner = await ownerUserId(seed);
  // An open admission round with room for the whole batch, as the owner would have.
  await sql(`select * from public.open_new_client_waitlist_admission_round($1,$2,50)`, [seed.studioId, owner]);
  const people: { name: string; email: string }[] = [];
  for (let i = 0; i < count; i++) {
    const name = `Beyond Person ${i} ${seed.runId}`;
    const email = `${prefixes[i] ?? "hold+"}beyond-${i}-${seed.runId}@harness.local`;
    await sql(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [seed.studioId, owner, name, email]);
    people.push({ name, email });
  }
  return people;
}

test.describe("invite beyond the estimate", () => {
  test("an owner reaches it from the Waitlist page, confirms once, and every chosen client is sent exactly once", async ({ page }) => {
    test.setTimeout(180_000);
    const seed = await seedE2eStudio();
    const people = await seedWaiting(seed, RECIPIENTS);
    const mark = markResendLedger();

    await loginAsOwner(page, seed);

    // 1. NORMAL NAVIGATION: the main navigation's Waitlist entry, then the link on that page. No page.goto to the override.
    await page.locator('[data-testid="nav-waitlist"]').first().click();
    await expect(page).toHaveURL(/\/settings\/waitlist$/, { timeout: T });
    const link = page.locator('[data-testid="over-invite-link"] a');
    await expect(link).toBeVisible({ timeout: T });
    await expect(link).toHaveText("Invite beyond the estimate");
    await expect(page.locator('[data-testid="over-invite-link"]')).toContainText("You confirm once; sending continues in the background.");
    await link.click();
    await expect(page).toHaveURL(/\/settings\/waitlist\/over-invite/, { timeout: T });

    // 2. Choose the service and see the numbers, then choose every waiting client.
    await page.getByLabel("Service").selectOption({ label: seed.serviceName });
    await page.getByRole("button", { name: "Show numbers" }).click();
    const form = page.locator('[data-testid="over-invite-confirm"]');
    await expect(form).toBeVisible({ timeout: T });
    for (const p of people) await form.getByLabel(p.name).check();
    await expect(page.locator('[data-testid="over-invite-line"]')).toBeVisible();

    // 3. Confirm ONCE and send.
    await form.getByRole("checkbox", { name: /I understand some clients may find no availability/ }).check();
    await form.getByRole("button", { name: "Send invitations" }).click();
    await expect(page.locator('[data-testid="over-invite-result"]')).toContainText(`${RECIPIENTS} confirmed`, { timeout: 60_000 });

    // The first stretch ran inline and could not finish (each send is held): part of the batch is still waiting for the background route.
    const waiting = await sql<{ n: number }>(`select count(*)::int n from public.waitlist_invitation_batch_items where studio_id=$1 and state in ('pending','claimed')`, [seed.studioId]);
    expect(waiting[0]!.n, "some of the batch is left for the background route").toBeGreaterThan(0);

    // 4. The background route, called as the scheduler does. A missing or wrong secret claims nothing.
    const refused = await page.request.get("/api/cron/waitlist-invitation-batches", { headers: { Authorization: "Bearer not-the-secret" } });
    expect(refused.status()).toBe(401);
    expect((await sql<{ n: number }>(`select count(*)::int n from public.waitlist_invitation_batch_items where studio_id=$1 and state in ('pending','claimed')`, [seed.studioId]))[0]!.n).toBe(waiting[0]!.n);
    // The scheduler calls it every minute; each call has a time budget, so a held send or two can leave something for the next call. Call it until this
    // studio has nothing waiting (at most four calls), exactly as the scheduler would.
    const waitingNow = async () => (await sql<{ n: number }>(`select count(*)::int n from public.waitlist_invitation_batch_items where studio_id=$1 and state in ('pending','claimed')`, [seed.studioId]))[0]!.n;
    for (let call = 0; call < 4 && (await waitingNow()) > 0; call++) {
      const ran = await page.request.get("/api/cron/waitlist-invitation-batches", { headers: { Authorization: `Bearer ${CRON_SECRET}` }, timeout: 90_000 });
      expect(ran.status()).toBe(200);
      const summary = await ran.json();
      expect(summary.ok).toBe(true);
      expect(JSON.stringify(summary)).not.toMatch(/@|harness\.local/); // counts only: no name, address or id
    }
    expect(await waitingNow()).toBe(0);

    // 5. Progress shows every chosen client sent.
    await page.goto("/settings/waitlist/over-invite");
    await expect(page.locator('[data-testid="batch-progress"]').first()).toContainText(`${RECIPIENTS} sent · 0 waiting to send`, { timeout: T });
    const states = await sql<{ state: string; n: number }>(`select state, count(*)::int n from public.waitlist_invitation_batch_items where studio_id=$1 group by 1`, [seed.studioId]);
    expect(states).toEqual([{ state: "sent", n: RECIPIENTS }]);

    // 6. Each recipient got exactly one email: nothing twice, nothing skipped.
    const sent = readResendLedger(mark).map((r) => r.to.toLowerCase());
    for (const p of people) expect(sent.filter((to) => to === p.email.toLowerCase()), p.email).toHaveLength(1);
  });

  test("the owner retries a refused delivery through the page: only that person is attempted again, nobody else", async ({ page }) => {
    test.setTimeout(240_000);
    const seed = await seedE2eStudio();
    // 0 and 1 are accepted. 2 is REFUSED by the provider on every attempt. (The fake cannot produce an unknown outcome cheaply: a `failonce` network error is
    // absorbed by the delivery adapter's own retry and ends accepted. The unknown-outcome retry is covered by the database and unit tests.)
    const people = await seedWaiting(seed, 3, ["success+", "success+", "reject+"]);
    const [okA, okB, refused] = people;
    const mark = markResendLedger();

    await loginAsOwner(page, seed);
    await page.locator('[data-testid="nav-waitlist"]').first().click();
    await page.locator('[data-testid="over-invite-link"] a').click();
    await expect(page).toHaveURL(/\/settings\/waitlist\/over-invite/, { timeout: T });
    await page.getByLabel("Service").selectOption({ label: seed.serviceName });
    await page.getByRole("button", { name: "Show numbers" }).click();
    const form = page.locator('[data-testid="over-invite-confirm"]');
    for (const p of people) await form.getByLabel(p.name).check();
    await form.getByRole("checkbox", { name: /I understand some clients may find no availability/ }).check();
    await form.getByRole("button", { name: "Send invitations" }).click();
    await expect(page.locator('[data-testid="over-invite-result"]')).toContainText("3 confirmed", { timeout: 60_000 });

    const waitingNow = async () => (await sql<{ n: number }>(`select count(*)::int n from public.waitlist_invitation_batch_items where studio_id=$1 and state in ('pending','claimed')`, [seed.studioId]))[0]!.n;
    for (let call = 0; call < 4 && (await waitingNow()) > 0; call++) {
      expect((await page.request.get("/api/cron/waitlist-invitation-batches", { headers: { Authorization: `Bearer ${CRON_SECRET}` }, timeout: 90_000 })).status()).toBe(200);
    }

    // The first pass: two sent, one refused, one unknown. Nothing is retried by itself.
    await page.goto("/settings/waitlist/over-invite");
    const progress = page.locator('[data-testid="batch-progress"]').first();
    await expect(progress).toContainText("2 sent", { timeout: T });
    await expect(progress).toContainText("1 refused by the email provider");
    const attempts = () => readResendLedger(mark).map((r) => r.to.toLowerCase());
    const count = (to: string) => attempts().filter((x) => x === to.toLowerCase()).length;
    expect([okA, okB, refused].map((p) => count(p.email))).toEqual([1, 1, 1]);

    // RETRY the refused one through the real page (a confirmed click). Only that person is attempted again; the provider still refuses, so it stays refused.
    await page.getByRole("checkbox", { name: /of the 1 refused deliveries now/ }).check();
    await page.getByRole("button", { name: "Retry refused deliveries" }).click();
    await expect(page.getByText("0 resent, 1 still not delivered.")).toBeVisible({ timeout: 60_000 });
    expect([okA, okB, refused].map((p) => count(p.email))).toEqual([1, 1, 2]);

    await page.goto("/settings/waitlist/over-invite");
    await expect(page.locator('[data-testid="batch-progress"]').first()).toContainText("2 sent", { timeout: T });
    const states = await sql<{ state: string; n: number }>(`select state, count(*)::int n from public.waitlist_invitation_batch_items where studio_id=$1 group by 1 order by 1`, [seed.studioId]);
    expect(states).toEqual([{ state: "failed", n: 1 }, { state: "sent", n: 2 }]);
  });

  test("a non-owner sees no link on the Waitlist page and the page refuses them", async ({ page }) => {
    const seed = await seedE2eStudio();
    await seedWaiting(seed, 1);
    const member = await seedE2eMember(seed);
    await loginByMagicLink(page, member.email);

    await page.goto("/settings/waitlist");
    await expect(page.getByText("Only studio owners can see the new-client waitlist.")).toBeVisible({ timeout: T });
    await expect(page.locator('[data-testid="over-invite-link"]')).toHaveCount(0);
    await expect(page.getByText("Invite beyond the estimate")).toHaveCount(0);

    await page.goto("/settings/waitlist/over-invite");
    await expect(page.getByText("Only studio owners can invite beyond the estimate.")).toBeVisible({ timeout: T });
    await expect(page.locator('[data-testid="over-invite-confirm"]')).toHaveCount(0);
  });
});
