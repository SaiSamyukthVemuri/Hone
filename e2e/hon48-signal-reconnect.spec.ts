import { expect, test } from "@playwright/test";
import { createBooking, openSeat, requireSignalPlatform, seedStudio, setVisibility, since, sleep, whenVisible } from "./helpers/hon48-signal";

// Needs a Realtime-enabled stack, which CI's browser lanes do not start. Local proofs set HON48_SIGNAL_E2E=1.
test.skip(process.env.HON48_SIGNAL_E2E !== "1", "needs a Realtime stack; run locally");

// HON-48 proofs 2 and 3. Refetches are counted as the browser's own RSC requests for /calendar (what router.refresh() sends),
// so no app instrumentation is needed. The 60 s interval cannot add one inside these windows (each window is well under 60 s).

test("HON48-SIGNAL-2: a change missed while the socket is down converges through ONE catch-up refetch on rejoin", async ({ browser }) => {
  test.setTimeout(300_000);
  await requireSignalPlatform();
  const studio = await seedStudio(1);
  const seat = await openSeat(browser, "m1", studio.memberEmails[0], studio.seed, false, studio.day);
  await sleep(3000);

  await seat.ctx.setOffline(true); // drops the websocket and every request
  await sleep(1500);
  const down = Date.now();
  const missed = await createBooking(studio, studio.pracIds[0], "09:00"); // committed while this browser is deaf
  await sleep(2000);
  expect(await seat.page.evaluate((n) => document.body.innerText.includes(n), missed.name), "the offline browser must NOT have it yet").toBe(false);
  expect(since(seat, down), "no refetch while offline").toBe(0);

  const back = Date.now();
  await seat.ctx.setOffline(false);
  const t = await whenVisible(seat.page, missed.name, 40_000); // supabase-js reconnects with backoff
  expect(t, "the missed change never arrived after rejoin").not.toBeNull();
  await sleep(4000); // anything extra (a storm) would land inside this quiet window
  expect(since(seat, back), "exactly one catch-up refetch for the whole reconnect").toBe(1);

  // and the channel is live again: a fresh write arrives by signal, again with a single refetch
  const mark = Date.now();
  const fresh = await createBooking(studio, studio.pracIds[0], "10:00");
  const t2 = await whenVisible(seat.page, fresh.name, 10_000);
  expect(t2, "a fresh write after the rejoin did not arrive").not.toBeNull();
  await sleep(3000);
  expect(since(seat, mark)).toBe(1);
  console.log("HON48_SIGNAL_RECONNECT " + JSON.stringify({ rejoinToVisibleMs: (t as number) - back, freshAfterRejoinMs: (t2 as number) - fresh.sentAt }));
  await seat.ctx.close();
});

test("HON48-SIGNAL-3a: a token refresh keeps delivery and causes no refetch storm", async ({ browser }) => {
  test.setTimeout(300_000);
  await requireSignalPlatform();
  const studio = await seedStudio(1);
  const seat = await openSeat(browser, "m1", studio.memberEmails[0], studio.seed, false, studio.day);
  await sleep(3000);

  // The stack under test issues short-lived tokens (HON48_SHORT_JWT=1: jwt_expiry 100 s), so supabase-js's own ticker renews the session within ~30 s.
  const refreshed = seat.page.waitForResponse((r) => r.url().includes("/auth/v1/token") && r.url().includes("refresh_token"), { timeout: 120_000 });
  await refreshed;
  const t0 = Date.now();
  await sleep(6000);
  const afterRefresh = since(seat, t0);
  expect(afterRefresh, "a token refresh must not storm").toBeLessThanOrEqual(1);

  const mark = Date.now();
  const w = await createBooking(studio, studio.pracIds[0], "09:00");
  const t = await whenVisible(seat.page, w.name, 10_000);
  expect(t, "delivery stopped after the token refresh").not.toBeNull();
  await sleep(3000);
  expect(since(seat, mark)).toBe(1);
  console.log("HON48_SIGNAL_TOKEN " + JSON.stringify({ refetchesCausedByRefresh: afterRefresh, signalAfterRefreshMs: (t as number) - w.sentAt }));
  await seat.ctx.close();
});

test("HON48-SIGNAL-3b: hidden then visible gives exactly one refetch and shows what changed meanwhile", async ({ browser }) => {
  test.setTimeout(300_000);
  await requireSignalPlatform();
  const studio = await seedStudio(1);
  const seat = await openSeat(browser, "m1", studio.memberEmails[0], studio.seed, false, studio.day);
  await sleep(3000);

  await setVisibility(seat.page, "hidden");
  const hiddenAt = Date.now();
  const a = await createBooking(studio, studio.pracIds[0], "09:00");
  const b = await createBooking(studio, studio.pracIds[0], "10:00");
  await sleep(4000);
  expect(since(seat, hiddenAt), "a hidden tab must not refetch").toBe(0);

  const shown = Date.now();
  await setVisibility(seat.page, "visible");
  expect(await whenVisible(seat.page, a.name, 10_000)).not.toBeNull();
  expect(await whenVisible(seat.page, b.name, 10_000)).not.toBeNull();
  await sleep(4000);
  expect(since(seat, shown), "exactly one refetch on becoming visible, however many changes were missed").toBe(1);
  await seat.ctx.close();
});
