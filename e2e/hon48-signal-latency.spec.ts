import { expect, test } from "@playwright/test";
import { createBooking, openSeat, requireSignalPlatform, seedStudio, sleep, summary, whenVisible, type Seat } from "./helpers/hon48-signal";

// Needs a Realtime-enabled stack, which CI's browser lanes do not start. Local proofs set HON48_SIGNAL_E2E=1.
test.skip(process.env.HON48_SIGNAL_E2E !== "1", "needs a Realtime stack; run locally");

// HON-48 proof 1: commit-to-visible p95 under 2 s, five signed-in sessions, 30+ trials, NO manual reload or refresh
// from the test. The commit goes through the real receptionist RPC (the same write path the trigger fires on).
const TRIALS = 30;

test("HON48-SIGNAL-1: commit to visible on all five sessions, p95 under 2 s", async ({ browser }) => {
  test.setTimeout(900_000);
  await requireSignalPlatform();
  const studio = await seedStudio(4);
  const seats: Seat[] = [await openSeat(browser, "owner", studio.seed.ownerEmail, studio.seed, true, studio.day)];
  for (const [i, e] of studio.memberEmails.entries()) seats.push(await openSeat(browser, `m${i + 1}`, e, studio.seed, false, studio.day));
  expect(seats).toHaveLength(5);
  await sleep(3000); // let every socket join; the join itself must not count as a trial

  const visible: number[] = []; const perSeat: Record<string, number[]> = {}; const commitMs: number[] = [];
  let missed = 0; let trial = 0;
  const hours = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];
  outer: for (const hh of hours) {
    for (const p of studio.pracIds) {
      if (trial >= TRIALS) break outer;
      const c = studio.nextClient();
      const pending = seats.map((st) => whenVisible(st.page, c.name, 10_000));
      const b = await createBooking(studio, p, hh, c);
      const seen = await Promise.all(pending);
      trial++; commitMs.push(b.ms);
      seen.forEach((t, i) => {
        if (t === null || t === -1) { missed++; return; } // timeout, or already there before the commit (invalid trial)
        const ms = t - b.sentAt; visible.push(ms); (perSeat[seats[i].label] ??= []).push(ms);
      });
      await sleep(1300); // clear the 1 s minimum refresh gap so each trial is its own signal
    }
  }
  const out = { trials: trial, samples: visible.length, missedOrInvalid: missed, all: summary(visible), perSeat: Object.fromEntries(Object.entries(perSeat).map(([k, v]) => [k, summary(v)])), bookingCommitMs: summary(commitMs) };
  console.log("HON48_SIGNAL_LATENCY " + JSON.stringify(out));
  expect(trial).toBeGreaterThanOrEqual(30);
  expect(missed, "a session never showed the change within 10 s").toBe(0);
  expect(out.all.p95 as number).toBeLessThan(2000);
  await Promise.all(seats.map((s) => s.ctx.close()));
});
