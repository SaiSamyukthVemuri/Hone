import { expect, test } from "@playwright/test";
import { createBooking, openSeat, requireSignalPlatform, seedStudio, since, sleep, whenVisible } from "./helpers/hon48-signal";
import { createClient } from "@supabase/supabase-js";
import { E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "./helpers/local-env";
import { seedE2eStudio, sql } from "./helpers/seed";
import { withPassword } from "./helpers/hon48-signal";

// HON-48 proofs 4 and 5.

test("HON48-SIGNAL-4: a revoked member gets no update, and its rejoin is refused", async ({ browser }) => {
  test.setTimeout(300_000);
  await requireSignalPlatform();
  const studio = await seedStudio(2);
  const owner = await openSeat(browser, "owner", studio.seed.ownerEmail, studio.seed, true, studio.day);
  const keep = await openSeat(browser, "kept", studio.memberEmails[0], studio.seed, false, studio.day);
  const gone = await openSeat(browser, "revoked", studio.memberEmails[1], studio.seed, false, studio.day);
  await sleep(3000);

  // control: before revocation all three get the signal
  const c0 = await createBooking(studio, studio.pracIds[0], "09:00");
  for (const s of [owner, keep, gone]) expect(await whenVisible(s.page, c0.name, 10_000), `${s.label} should receive before revocation`).not.toBeNull();

  await sql(`update public.practitioners set active = false where studio_id = $1 and lower(email) = lower($2)`, [studio.seed.studioId, studio.memberEmails[1]]);
  // The revoked browser's socket holds its old token until it renews or rejoins. Force the rejoin the way a real drop does.
  await gone.ctx.setOffline(true); await sleep(1500);
  const before = Date.now();
  const c1 = await createBooking(studio, studio.pracIds[0], "10:00");
  expect(await whenVisible(keep.page, c1.name, 10_000), "a kept member still receives").not.toBeNull();
  await gone.ctx.setOffline(false);
  const leaked = await whenVisible(gone.page, c1.name, 30_000);
  // Its own server render is also refused for a deactivated member, so the page may redirect; either way it must not show the change.
  expect(leaked, "the revoked member's browser showed a change made after revocation").toBeNull();
  const c2 = await createBooking(studio, studio.pracIds[0], "11:00");
  expect(await whenVisible(keep.page, c2.name, 10_000)).not.toBeNull();
  await sleep(3000);
  const stray = gone.rsc.filter((x) => x >= before).length;
  console.log("HON48_SIGNAL_REVOKED " + JSON.stringify({ revokedRefetchesAfterRevocation: stray }));
  // direct refusal: a fresh token for the removed member, a brand-new private join on the studio topic
  const tok = (await withPassword(studio.memberEmails[1])).token;
  const direct = createClient(E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await direct.realtime.setAuth(tok);
  let got = 0;
  const status = await new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve("TIMEOUT"), 15_000);
    direct.channel(`schedule:${studio.seed.studioId}`, { config: { private: true } }).on("broadcast", { event: "*" }, () => { got++; })
      .subscribe((st) => { clearTimeout(t); resolve(st); });
  });
  await createBooking(studio, studio.pracIds[0], "12:00"); await sleep(3000);
  expect(status, "the removed member's direct private join must be refused").not.toBe("SUBSCRIBED");
  expect(got).toBe(0);
  await direct.removeAllChannels();
  await Promise.all([owner, keep, gone].map((s) => s.ctx.close()));
});

test("HON48-SIGNAL-5: another studio's browser never refreshes", async ({ browser }) => {
  test.setTimeout(300_000);
  await requireSignalPlatform();
  const a = await seedStudio(1);
  const other = await seedE2eStudio();
  const seatA = await openSeat(browser, "A-member", a.memberEmails[0], a.seed, false, a.day);
  const seatOther = await openSeat(browser, "other-owner", other.ownerEmail, other, true, a.day, false);
  await sleep(3000);
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) { const b = await createBooking(a, a.pracIds[0], ["08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00"][i]); await whenVisible(seatA.page, b.name, 10_000); await sleep(1200); }
  await sleep(3000);
  expect(since(seatA, t0), "control: the studio's own member refreshed").toBeGreaterThanOrEqual(1);
  expect(since(seatOther, t0), "another studio's browser must make zero refetches during ten writes").toBe(0);
  await Promise.all([seatA, seatOther].map((s) => s.ctx.close()));
});
