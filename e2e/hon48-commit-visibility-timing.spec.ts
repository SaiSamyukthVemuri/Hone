import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { openDrawerForColumn, prepareBooking, closeTeam, setupFiveUserTeam, DRAWER, type Team, type User } from "./hon48-support/five-user-team";
import { seedE2eClient } from "./helpers/seed";
import { clientNameOf } from "./hon48-support/five-user-team";

// HON-48 committed-visibility MEASUREMENT. It produces numbers; it is not a behaviour proof.
//
// Opt-in: HON48_TIMING_E2E=1 (a multi-minute measurement rig, so it costs nothing in an ordinary lane).
//
//   ACTING   the user who commits a booking sees it in their own Day column: N rounds, five users in turn, elapsed from
//            the Book click to the card appearing in that practitioner's column. ASSERTED: p95 under 2000 ms.
//   OTHER    a second signed-in user who only WATCHES the same Day view sees the committed booking: elapsed from the
//            commit (the acting user's drawer closing) to the card appearing, with no interaction (passive) and with a
//            focus event (the existing refresh policy). RECORDED, NOT ASSERTED: this is the known gap against HON-48
//            (about 60 s passive, 15 s on focus), reported honestly as measured.
//
// Local stack, one app server, one machine: it measures the code path, not network distance. Writes
// test-results/hon48-timing.json.

test.skip(process.env.HON48_TIMING_E2E !== "1", "opt-in HON-48 timing rig; set HON48_TIMING_E2E=1");
test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

const ROUNDS = Number(process.env.HON48_TIMING_ROUNDS ?? 20);
const OTHER_ROUNDS = Number(process.env.HON48_TIMING_OTHER_ROUNDS ?? 1);
const OTHER_CAP_MS = 130_000;

let t: Team;
test.beforeAll(async ({ browser }) => { t = await setupFiveUserTeam(browser, 3); });
test.afterAll(async () => { await closeTeam(t); });

const colSel = (u: User) => `[data-testid="team-day-column"][data-practitioner-id="${u.practitionerId}"]`;

/** Arm an in-page observer: resolves with performance.now() when `name` first appears inside the column. */
async function armSeen(page: Page, selector: string, name: string, needDrawerGone = false) {
  await page.evaluate(([sel, n, needDrawerGone]) => {
    const w = window as unknown as { __seen?: Promise<number> };
    w.__seen = new Promise<number>((resolve) => {
      // A COMMITTED card is a button inside the column that carries the client's name, with the booking drawer gone
      // (an open drawer shows a draft of the same name in the column, which is not a commitment).
      const has = () => {
        if (needDrawerGone && document.querySelector('[role="dialog"][aria-label="New appointment"]')) return false;
        const col = document.querySelector(sel as string);
        if (!col) return false;
        return Array.from(col.querySelectorAll("button")).some(
          (b) => !(b.getAttribute("aria-label") ?? "").startsWith("Open quick-book draft") && (b.textContent ?? "").includes(n as string),
        );
      };
      const mo = new MutationObserver(() => { if (has()) { mo.disconnect(); resolve(performance.now()); } });
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    });
  }, [selector, name, needDrawerGone] as [string, string, boolean]);
}
const readSeen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: Promise<number> }).__seen);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const result: Record<string, unknown> & { diagnostics?: unknown[] } = {};

test("ACTING: the committing user sees their booking in their own column, N rounds", async () => {
  const samples: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const i = r % t.users.length;
    const u = t.users[i];
    const { page } = t.contexts[i];
    const { clientId } = await seedE2eClient(t.seed);
    const name = await clientNameOf(t.seed, clientId);
    await openDrawerForColumn(page, t.day, u);
    const submit = await prepareBooking(page, name, t.serviceId, u, Math.floor(r / t.users.length));
    await armSeen(page, colSel(u), name, true);
    const t0 = await page.evaluate(() => performance.now());
    await submit.click();
    const t1 = await readSeen(page);
    expect(t1 - t0, `round ${r}: the card must appear AFTER the click`).toBeGreaterThan(0);
    samples.push(Math.round(t1 - t0));
    await expect(DRAWER(page)).toBeHidden({ timeout: 30_000 });
  }
  result.acting = { rounds: ROUNDS, samples_ms: samples, p50_ms: pct(samples, 50), p95_ms: pct(samples, 95), max_ms: Math.max(...samples) };
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/hon48-timing-acting.json", JSON.stringify({ measured_at: new Date().toISOString(), ...result }, null, 2));
  console.log("HON48_TIMING_ACTING " + JSON.stringify(result.acting));
  expect(pct(samples, 95), `acting-session commit-to-visible p95 (samples ${samples.join(",")})`).toBeLessThan(2000);
});

test("OTHER: a watching user sees a colleague's committed booking: measured, not asserted", async () => {
  const actor = t.users[1];
  // The watcher is the OWNER, whose calendar shows everyone by default. A member's calendar opens on their OWN column only
  // (own-calendar-first), so a member watching would not display the actor's column at all.
  const actorPage = t.contexts[1].page;
  const watcherPage = t.contexts[0].page;
  const passive: number[] = [];
  const onFocus: number[] = [];
  for (const mode of ["passive", "focus"] as const) {
    for (let r = 0; r < OTHER_ROUNDS; r++) {
      const { clientId } = await seedE2eClient(t.seed);
      const name = await clientNameOf(t.seed, clientId);
      await watcherPage.goto(`/calendar?view=day&day=${t.day}`);
      await expect(watcherPage.locator(colSel(actor)), "the watcher's view must display the actor's column").toBeVisible({ timeout: 20_000 });
      await armSeen(watcherPage, colSel(actor), name);
      await openDrawerForColumn(actorPage, t.day, actor);
      const submit = await prepareBooking(actorPage, name, t.serviceId, actor, 5 + r + (mode === "focus" ? OTHER_ROUNDS : 0));
      await submit.click();
      await expect(DRAWER(actorPage)).toBeHidden({ timeout: 30_000 });
      const committed = await watcherPage.evaluate(() => performance.now());
      // The refresh policy needs the screen to be at least 15 s old before a focus refresh is allowed.
      if (mode === "focus") {
        await watcherPage.waitForTimeout(16_000);
        await watcherPage.evaluate(() => window.dispatchEvent(new Event("focus")));
      }
      const seen = await Promise.race([
        readSeen(watcherPage),
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), OTHER_CAP_MS)),
      ]);
      (mode === "passive" ? passive : onFocus).push(seen < 0 ? -1 : Math.round(seen - committed));
      if (seen < 0) {
        const diag = await watcherPage.evaluate(() => ({
          visibility: document.visibilityState,
          online: navigator.onLine,
          url: location.pathname + location.search,
          title: document.title,
          active: document.activeElement?.tagName ?? null,
          modalDialogs: document.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
        }));
        await watcherPage.screenshot({ path: `test-results/hon48-watcher-${mode}.png` });
        await watcherPage.reload();
        const afterReload = ((await watcherPage.locator(colSel(actor)).textContent({ timeout: 15_000 }).catch(() => null)) ?? "").includes(name);
        console.log("HON48_TIMING_DIAG " + JSON.stringify({ mode, diag, visibleAfterManualReload: afterReload }));
        (result.diagnostics ??= []).push({ mode, diag, visibleAfterManualReload: afterReload });
      }
    }
  }
  result.other_session = {
    watcher_view: "Day", passive_ms: passive, on_focus_ms: onFocus,
    note: "-1 means not seen within the cap (130 s). Known gap against HON-48: passive refresh is 60 s polled at 15 s steps, focus refresh needs a 15 s old screen. Recorded, not a pass.",
  };
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/hon48-timing.json", JSON.stringify({ measured_at: new Date().toISOString(), ...result }, null, 2));
  test.info().annotations.push({ type: "timing", description: JSON.stringify(result) });
  console.log("HON48_TIMING " + JSON.stringify(result));
  expect(passive.length + onFocus.length).toBeGreaterThan(0);
});
