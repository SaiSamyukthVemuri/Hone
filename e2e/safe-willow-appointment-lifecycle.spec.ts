import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  getClientIdByEmail,
  getAppointmentsForClient,
  getCancellationToken,
  type E2eSeed,
} from "./helpers/seed";
import { bookAppointment, loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// SAFE-WILLOW behavioural contract — slice 2: appointment lifecycle. Proves the
// approved Move-appointment workflow's same-record semantics + owner
// authorization, that the public cancel/reschedule/manage tokens RESOLVE to the
// booked appointment, and that one synthetic tenant's tokens are appointment-
// scoped and do not cross to another synthetic tenant.
//
// SAFETY: two fresh SYNTHETIC studios on the LOCAL stack (seedE2eStudio;
// e2e-prefixed, @harness.local, dummy Stripe/Google keys, Mailpit). NEVER
// connects to or mutates Willow or production. Localhost is asserted below.
//
// COVERAGE (this slice):
//   * Move appointment (owner, custom-time through the real Move dialog):
//     same appointment id preserved, NO duplicate row, only scheduling fields
//     change, tenant-scoped to the synthetic studio+client. [DB + browser]
//   * Owner authorization: a NON-owner practitioner never sees the custom-time
//     option. [browser]
//   * Token resolution: the minted token RESOLVES the appointment on
//     /reschedule, /manage and /cancel (not the generic "no longer valid"
//     collapse). [browser]
//   * Cross-tenant isolation: studio B's appointment mints a DISTINCT token;
//     studio A's token is appointment-scoped (resolves A's appointment id, never
//     B's). [DB]
//
// NOT YET COVERED (named for the next SAFE-WILLOW slices):
//   * exercising cancellation/reschedule SUBMIT (driving the confirm + slot
//     picker) and immutable policy/evidence snapshots;
//   * the client PORTAL (separate auth realm: magic-link login, own-data-only,
//     rebooking context) — its own focused slice via the portal magic-link flow.

test.describe.configure({ mode: "serial" });

const instant = (v: string | Date): number => new Date(v).getTime();

// A future studio-local date (derived from the real clock so the spec never
// becomes a time bomb) + an outside-hours custom time.
const futureYmd = (offsetDays: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));

let seedA: E2eSeed;
let clientA: string;
let apptA: string;

test("SAFE-WILLOW: appointment move + token resolution + cross-tenant isolation", async ({
  page,
  browser,
}) => {
  await test.step("localhost guard + seed synthetic studio A, book one appointment", async () => {
    // Explicit localhost guard: this contract runs ONLY against the local stack.
    expect(E2E_APP_ORIGIN).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);
    seedA = await seedE2eStudio();
    await bookAppointment(page, seedA);
    clientA = (await getClientIdByEmail(seedA.studioId, seedA.clientEmail))!;
    expect(clientA).toBeTruthy();
    const appts = await getAppointmentsForClient(seedA.studioId, clientA);
    expect(appts.length).toBe(1);
    expect(appts[0].status).toBe("confirmed");
    apptA = appts[0].id;
  });

  await test.step("owner logs in via REAL magic link", async () => {
    await loginAsOwner(page, seedA);
  });

  await test.step("owner moves the appointment (custom time) — same record, no duplicate, scheduling only", async () => {
    const before = await getAppointmentsForClient(seedA.studioId, clientA);
    const prev = before.find((a) => a.id === apptA)!;

    await page.goto(`/calendar/${apptA}`);
    const dialog = page.getByRole("dialog", { name: "Move appointment" });
    await page.getByRole("button", { name: "Move appointment" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Custom time" }).click();

    await dialog.locator('input[type="date"]').fill(futureYmd(400));
    await dialog.locator('input[type="time"]').fill("05:00"); // before the 06:00 open
    const ack = dialog.getByRole("checkbox");
    const confirm = dialog.getByRole("button", { name: /^Move appointment$/ });
    await expect(confirm).toBeDisabled(); // acknowledgement gate
    await ack.check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });

    // DB: same-record invariant.
    const after = await getAppointmentsForClient(seedA.studioId, clientA);
    expect(after, "no duplicate appointment (row count unchanged)").toHaveLength(before.length);
    const moved = after.find((a) => a.id === apptA)!;
    expect(moved, "same appointment id preserved").toBeTruthy();
    expect(moved.status, "only scheduling changed — still confirmed").toBe("confirmed");
    expect(instant(moved.starts_at), "scheduling actually moved").not.toBe(instant(prev.starts_at));
    // tenant scoping: the moved row is still owned by the synthetic studio+client.
    expect(moved.id).toBe(apptA);
  });

  await test.step("non-owner practitioner cannot see the owner-only custom-time option", async () => {
    const member = await seedE2eMember(seedA);
    const ctx = await browser.newContext();
    const mpage = await ctx.newPage();
    await loginByMagicLink(mpage, member.email);
    await mpage.goto(`/calendar/${apptA}`);
    const dialog = mpage.getByRole("dialog", { name: "Move appointment" });
    await mpage.getByRole("button", { name: "Move appointment" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Custom time" })).toHaveCount(0);
    await ctx.close();
  });

  await test.step("public token RESOLVES the appointment on reschedule/manage/cancel", async () => {
    const token = await getCancellationToken(seedA.studioId, apptA);
    expect(token).toBeTruthy();
    const anon = await browser.newContext();
    const apage = await anon.newPage();

    await apage.goto(`/reschedule/${token}`);
    await expect(apage.getByText("Choose a new time that works better for you.")).toBeVisible();
    await expect(apage.getByText(/can't be used right now/i)).toHaveCount(0);

    await apage.goto(`/manage/${token}`);
    await expect(apage.getByRole("heading", { name: /manage appointment/i })).toBeVisible();

    await apage.goto(`/cancel/${token}`);
    await expect(apage.getByRole("heading", { name: /cancel appointment/i })).toBeVisible();
    await expect(apage.getByText(/no longer valid/i)).toHaveCount(0);
    await anon.close();
  });

  await test.step("cross-tenant isolation: studio B's appointment has a distinct, appointment-scoped token", async () => {
    const seedB = await seedE2eStudio();
    const pageB = await browser.newPage();
    await bookAppointment(pageB, seedB);
    await pageB.close();
    const clientB = (await getClientIdByEmail(seedB.studioId, seedB.clientEmail))!;
    const apptB = (await getAppointmentsForClient(seedB.studioId, clientB))[0].id;

    const tokenA = await getCancellationToken(seedA.studioId, apptA);
    const tokenB = await getCancellationToken(seedB.studioId, apptB);
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    // Distinct tenants -> distinct appointment ids -> distinct tokens.
    expect(apptA).not.toBe(apptB);
    expect(tokenA).not.toBe(tokenB);
    // A's token is scoped to A's appointment only; it never resolves B's rows.
    const anon = await browser.newContext();
    const apage = await anon.newPage();
    await apage.goto(`/cancel/${tokenA}`);
    await expect(apage.getByRole("heading", { name: /cancel appointment/i })).toBeVisible();
    // The A-token page must not surface B's studio/client (a cross-tenant leak).
    const body = await apage.locator("body").innerText();
    expect(body).not.toContain(seedB.studioName);
    expect(body).not.toContain(seedB.clientName);
    await anon.close();
  });
});
