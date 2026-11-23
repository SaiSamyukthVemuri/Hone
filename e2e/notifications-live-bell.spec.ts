import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2eStudio, seedE2eMember, getOwnerPractitionerId, seedNoStudioAuthUser, sql, type E2eSeed } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// HON-106 PR 1: the live bell count, proven with real sessions against the real summary route and real RLS.
//
// WHAT IS PROVEN (synthetic data only, a local stack):
//   * ONE poll per tab: the header renders the bell twice (both instances are in the DOM at 1440 and at 390), the provider is mounted once,
//     so a page load sends exactly one /api/notifications/summary request, and six focus events during a slow request still leave exactly
//     one in flight
//   * BOTH bell instances show the same number, and it changes ONCE per event id (never through intermediate values)
//   * role and studio isolation at the data: an owner's count includes studio-wide and owner-only rows; a non-owner's does not; a
//     per-recipient cancellation counts only for its recipient; another studio's rows count for nobody here
//   * failures: 503 keeps the last count and backs off; 403 stops polling; a repeated 401 stops it; a REAL signed-out (cookies gone)
//     request is the middleware redirect and the poller stops cleanly on it, without a page error
//   * a hidden tab sends nothing
//   * sign out, then sign in as someone ELSE in the same tab: the remembered seen set is not inherited
//
// HOW A POLL IS TRIGGERED: the machine's own "returned" rule (the tab regained focus) checks immediately, so a `focus` event stands in for
// waiting out the 30 s interval. The interval and back-off arithmetic are proved in tests/lib/notifications/live-poller.test.ts.
//
// NOT COVERED HERE: a receptionist session. A receptionist has no practitioner row, so the middleware refuses it exactly as it refuses the
// signed-in user with no studio used below; the receptionist role itself is not seeded by this lane.

test.describe.configure({ mode: "serial" });

const SUMMARY = "/api/notifications/summary";
const SEEN_KEY = "hone:notifications-seen";
const label = (n: number) => (n > 0 ? `Notifications, ${n} unread` : "Notifications");

let seed: E2eSeed;
let seedB: E2eSeed;
let ownerId = "";
let memberId = "";
let memberEmail = "";
const ctxs: BrowserContext[] = [];
let owner: Tracked;
let member: Tracked;
let ownerB: Tracked;

type Tracked = { page: Page; requests: () => number; responses: () => number; errors: string[] };

function track(page: Page): Tracked {
  let requests = 0;
  let responses = 0;
  const errors: string[] = [];
  page.on("request", (r) => { if (r.url().includes(SUMMARY)) requests++; });
  page.on("response", (r) => { if (r.url().includes(SUMMARY)) responses++; });
  page.on("pageerror", (e) => errors.push(String(e)));
  return { page, requests: () => requests, responses: () => responses, errors };
}

async function openContext(browser: Browser, viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport });
  ctxs.push(ctx);
  return ctx;
}

async function signedIn(browser: Browser, email: string, viewport = { width: 1440, height: 900 }): Promise<Tracked> {
  const ctx = await openContext(browser, viewport);
  const page = await ctx.newPage();
  const t = track(page);
  await loginByMagicLink(page, email);
  // the provider's first poll: one request, answered
  await expect.poll(t.responses, { timeout: 20_000 }).toBe(1);
  return t;
}

const bells = (page: Page) => page.locator('[data-testid="nav-notifications"]');
const labels = (page: Page) => bells(page).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));

/** Both bell instances are in the DOM and show the same label. */
async function expectBoth(page: Page, n: number) {
  await expect(bells(page)).toHaveCount(2);
  await expect.poll(() => labels(page), { timeout: 15_000 }).toEqual([label(n), label(n)]);
}

/** One poll, the way the machine's own rule asks for one: the tab regained focus. Resolves when the answer arrived. */
async function pollNow(t: Tracked) {
  const before = t.responses();
  await t.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(t.responses, { timeout: 15_000 }).toBe(before + 1);
  await t.page.waitForTimeout(150); // let React apply the answer
}

async function insertRow(opts: { studioId: string; practitionerId: string | null; type: string; dedupe?: string; title?: string }): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `insert into public.practitioner_notifications (studio_id, practitioner_id, event_type, title, body, href, dedupe_key)
     values ($1, $2, $3, $4, 'synthetic', '/dashboard', $5) returning id`,
    [opts.studioId, opts.practitionerId, opts.type, opts.title ?? `Synthetic ${opts.type}`, opts.dedupe ?? null],
  );
  return row.id;
}

const storedSeen = (page: Page) =>
  page.evaluate((k) => {
    const raw = window.sessionStorage.getItem(k);
    return raw ? (JSON.parse(raw) as { viewer: string | null; seen: string[] }) : null;
  }, SEEN_KEY);

test.beforeAll(async ({ browser }) => {
  seed = await seedE2eStudio();
  seedB = await seedE2eStudio();
  ownerId = await getOwnerPractitionerId(seed.studioId);
  const m = await seedE2eMember(seed);
  memberId = m.practitionerId;
  memberEmail = m.email;
  owner = await signedIn(browser, seed.ownerEmail);
  member = await signedIn(browser, memberEmail);
  ownerB = await signedIn(browser, seedB.ownerEmail);
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close();
});

test("ONE poll per tab at 1440: both bell instances are in the DOM, one request on load, none more without a trigger", async () => {
  for (const t of [owner, member]) {
    await expect(bells(t.page)).toHaveCount(2);
    await expectBoth(t.page, 0);
    await t.page.waitForTimeout(2_500);
    expect(t.requests(), "requests on load plus 2.5 s idle").toBe(1);
  }
});

test("exactly ONE poll in flight per tab: six focus events during a slow request leave one request", async () => {
  const page = owner.page;
  let inFlight = 0;
  let maxInFlight = 0;
  await page.route(`**${SUMMARY}`, async (route) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 900));
    await route.continue();
    inFlight--;
  });
  const before = owner.requests();
  await page.evaluate(() => { for (let i = 0; i < 6; i++) window.dispatchEvent(new Event("focus")); });
  await expect.poll(owner.responses, { timeout: 15_000 }).toBe(before + 1);
  await page.waitForTimeout(600);
  await page.unroute(`**${SUMMARY}`);
  expect(maxInFlight).toBe(1);
  expect(owner.requests() - before).toBe(1);
});

test("the count changes ONCE per event id on BOTH bell instances, with no intermediate value, and the seen set holds each id once", async () => {
  for (const t of [owner, member]) {
    await t.page.evaluate(() => {
      const w = window as unknown as { __log: string[][] };
      w.__log = [[], []];
      document.querySelectorAll('[data-testid="nav-notifications"]').forEach((el, i) => {
        new MutationObserver(() => w.__log[i].push(el.getAttribute("aria-label") ?? "")).observe(el, { attributes: true, attributeFilter: ["aria-label"] });
      });
    });
  }
  const first = await insertRow({ studioId: seed.studioId, practitionerId: null, type: "new_booking", title: "Synthetic booking one" });
  for (const t of [owner, member]) {
    await pollNow(t);
    await expectBoth(t.page, 1);
    for (let i = 0; i < 3; i++) await pollNow(t); // the same row returned again and again
    await expectBoth(t.page, 1);
  }
  const second = await insertRow({ studioId: seed.studioId, practitionerId: null, type: "new_booking", title: "Synthetic booking two" });
  for (const t of [owner, member]) {
    await pollNow(t);
    await pollNow(t);
    await expectBoth(t.page, 2);
    const log = await t.page.evaluate(() => (window as unknown as { __log: string[][] }).__log);
    expect(log, "each instance changes exactly once per event, in order").toEqual([[label(1), label(2)], [label(1), label(2)]]);
    const stored = await storedSeen(t.page);
    expect(stored?.viewer).toMatch(/^[0-9a-f]{16}$/);
    expect(stored?.seen.filter((id) => id === first)).toHaveLength(1);
    expect(stored?.seen.filter((id) => id === second)).toHaveLength(1);
  }
});

test("role isolation at the data: owner-only and per-recipient rows, and another studio's rows", async () => {
  // state so far: both see 2 studio-wide rows
  // (a) another studio's studio-wide row counts for nobody in studio A, and does count for studio B's own owner
  await insertRow({ studioId: seedB.studioId, practitionerId: null, type: "new_booking" });
  await pollNow(owner); await pollNow(member); await pollNow(ownerB);
  await expectBoth(owner.page, 2);
  await expectBoth(member.page, 2);
  await expectBoth(ownerB.page, 1);

  // (b) an OWNER-ONLY event (card on file, targeted at the owner) counts for the owner and not for a non-owner practitioner
  await insertRow({ studioId: seed.studioId, practitionerId: ownerId, type: "card_added", title: "Synthetic card event" });
  await pollNow(owner); await pollNow(member);
  await expectBoth(owner.page, 3);
  await expectBoth(member.page, 2);

  // (c) a per-recipient cancellation counts only for its recipient
  await insertRow({ studioId: seed.studioId, practitionerId: memberId, type: "appointment_cancelled", dedupe: `appointment_cancelled:${randomUUID()}` });
  await pollNow(owner); await pollNow(member);
  await expectBoth(owner.page, 3); // another practitioner's recipient row never counts for the owner
  await expectBoth(member.page, 3);
  await insertRow({ studioId: seed.studioId, practitionerId: ownerId, type: "appointment_cancelled", dedupe: `appointment_cancelled:${randomUUID()}` });
  await pollNow(owner); await pollNow(member);
  await expectBoth(owner.page, 4);
  await expectBoth(member.page, 3);

  // the answer for each viewer agrees with the database truth for that viewer
  const [{ n: ownerSees }] = await sql<{ n: string }>(
    `select count(*)::text as n from public.practitioner_notifications where studio_id=$1 and read_at is null
       and (event_type <> 'appointment_cancelled' or dedupe_key is null or dedupe_key not like 'appointment_cancelled:%' or practitioner_id = $2 or practitioner_id is null)`,
    [seed.studioId, ownerId],
  );
  expect(Number(ownerSees)).toBe(4);
});

test("503 keeps the last count and backs off; 403 stops polling; a repeated 401 stops it", async ({ browser }) => {
  const t = await signedIn(browser, seed.ownerEmail);
  await expectBoth(t.page, 4);

  // 503: the last count stays; the machine waits (no request without a trigger inside 3 s), and a good answer later recovers
  await t.page.route(`**${SUMMARY}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
  await pollNow(t);
  await expectBoth(t.page, 4);
  const after503 = t.requests();
  await t.page.waitForTimeout(3_000);
  expect(t.requests(), "back-off: no further request without a trigger").toBe(after503);
  await t.page.unroute(`**${SUMMARY}`);
  await insertRow({ studioId: seed.studioId, practitionerId: null, type: "new_booking", title: "Synthetic after outage" });
  await pollNow(t);
  await expectBoth(t.page, 5);

  // 403: stops for good
  await t.page.route(`**${SUMMARY}`, (route) => route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"forbidden"}' }));
  await pollNow(t);
  const after403 = t.requests();
  for (let i = 0; i < 3; i++) await t.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await t.page.waitForTimeout(1_000);
  expect(t.requests(), "stopped: a focus sends nothing").toBe(after403);
  await expectBoth(t.page, 5); // the last count is kept, nothing is blanked
  expect(t.errors).toEqual([]);
});

test("a repeated 401 stops polling only after three; a fourth focus sends nothing", async ({ browser }) => {
  const t = await signedIn(browser, seed.ownerEmail);
  await t.page.route(`**${SUMMARY}`, (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthenticated"}' }));
  await pollNow(t); await pollNow(t);
  const two = t.requests();
  await pollNow(t); // the third strike
  expect(t.requests()).toBe(two + 1);
  const stopped = t.requests();
  await t.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await t.page.waitForTimeout(1_000);
  expect(t.requests()).toBe(stopped);
  expect(t.errors).toEqual([]);
});

test("a REAL signed-out request is the middleware redirect: no count is served and the poller stops cleanly instead of parsing it", async ({ browser, request }) => {
  // signed out, no cookies: the route is refused before it runs
  const anon = await request.get(SUMMARY, { maxRedirects: 0 });
  expect([307, 401]).toContain(anon.status());
  expect(await anon.text()).not.toContain("unread");

  // a signed-in user with NO studio (a receptionist has no practitioner row either): the middleware redirect, not a count
  const nostudio = await seedNoStudioAuthUser();
  const ctx = await openContext(browser, { width: 1440, height: 900 });
  const npage = await ctx.newPage();
  const seenIds = await listMessageIds(nostudio.email);
  await npage.goto("/login");
  await npage.getByLabel("I am using my invited email address").check();
  await npage.locator("#login-email").fill(nostudio.email);
  await npage.getByRole("button", { name: /send magic link/i }).click();
  await npage.goto(await waitForMagicLink(nostudio.email, E2E_APP_ORIGIN, { excludeIds: seenIds }));
  await npage.waitForURL(/no-access|dashboard/, { timeout: 30_000 });
  const res = await ctx.request.get(SUMMARY, { maxRedirects: 0 });
  expect([307, 401, 403]).toContain(res.status());
  expect(await res.text()).not.toContain("unread");

  // the session vanishes under an open page (cookies cleared): the poller meets the real middleware redirect three times and stops
  const t = await signedIn(browser, seed.ownerEmail);
  await expectBoth(t.page, 5);
  await t.page.context().clearCookies();
  // WHY the poller asks with redirect:"manual": signed out, the middleware answers with a redirect. A manual fetch sees an opaque
  // redirect (a definite "not signed in" answer). A default fetch would FOLLOW it: it either fails at the network layer (a redirect to
  // another origin) or lands on the login page's HTML with status 200. Neither is a summary a poller could parse, so without "manual"
  // it could only ever call the answer a transient failure, and retry forever instead of stopping.
  const seen = await t.page.evaluate(async (url) => {
    const manual = await fetch(url, { cache: "no-store", credentials: "same-origin", redirect: "manual" });
    let followed: { failed: boolean; status: number; contentType: string } = { failed: false, status: 0, contentType: "" };
    try {
      const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      followed = { failed: false, status: res.status, contentType: res.headers.get("content-type") ?? "" };
    } catch {
      followed = { failed: true, status: 0, contentType: "" };
    }
    return { manualType: manual.type, followed };
  }, SUMMARY);
  expect(seen.manualType).toBe("opaqueredirect");
  expect(seen.followed.failed || /text\/html/.test(seen.followed.contentType), "a followed redirect is never JSON").toBe(true);
  const baseline = t.requests();
  // an opaque redirect may not surface as a `response` event, so wait on the REQUEST each strike sends
  for (let i = 1; i <= 3; i++) {
    await t.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(t.requests, { timeout: 15_000 }).toBe(baseline + i);
    await t.page.waitForTimeout(300);
  }
  expect(t.requests() - baseline, "three strikes, one request each").toBe(3);
  const stopped = t.requests();
  await t.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await t.page.waitForTimeout(1_000);
  expect(t.requests(), "stopped after the third repeated refusal").toBe(stopped);
  await expectBoth(t.page, 5); // the last count stays; nothing was parsed from a redirect
  expect(t.errors).toEqual([]);
});

test("a hidden tab sends nothing, and returning to it checks at once", async ({ browser }) => {
  const t = await signedIn(browser, seed.ownerEmail);
  await t.page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const before = t.requests();
  await t.page.evaluate(() => window.dispatchEvent(new Event("focus"))); // a focus while hidden must not send
  await t.page.waitForTimeout(1_500);
  expect(t.requests()).toBe(before);
  await t.page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(t.requests, { timeout: 10_000 }).toBe(before + 1);
});

test("sign out, then sign in as someone ELSE in the same tab: the first person's remembered ids are not inherited", async ({ browser }) => {
  const t = await signedIn(browser, seed.ownerEmail);
  const ownerSeen = await storedSeen(t.page);
  expect(ownerSeen?.seen.length).toBeGreaterThan(0);
  const ownerOnly = ownerSeen!.seen;
  await t.page.getByRole("button", { name: "Open account menu" }).first().click();
  await t.page.getByRole("button", { name: "Sign out" }).first().click();
  await t.page.waitForURL(/\/login/, { timeout: 20_000 });
  // the same tab still holds the first person's set
  expect((await storedSeen(t.page))?.seen).toEqual(ownerSeen!.seen);

  await loginByMagicLink(t.page, memberEmail);
  await expect.poll(t.responses, { timeout: 20_000 }).toBeGreaterThan(1);
  await expectBoth(t.page, 4); // the member's own count: two studio-wide, their recipient cancellation, and the one after the outage
  const memberSeen = await storedSeen(t.page);
  expect(memberSeen?.viewer).not.toBe(ownerSeen?.viewer);
  // rows only the owner can see are not in the new person's set
  const ownerOnlyRows = await sql<{ id: string }>(
    `select id from public.practitioner_notifications where studio_id=$1 and (event_type='card_added' or practitioner_id=$2)`,
    [seed.studioId, ownerId],
  );
  for (const r of ownerOnlyRows) expect(memberSeen?.seen).not.toContain(r.id);
  expect(ownerOnly.length).toBeGreaterThan(memberSeen!.seen.length - 1);
});

test("the SERVER number wins: a mark-all-read that LOWERS the count after a poll had raised it shows the lower number at once", async ({ browser }) => {
  const own = await seedE2eStudio();
  const ownOwner = await getOwnerPractitionerId(own.studioId);
  await insertRow({ studioId: own.studioId, practitionerId: null, type: "new_booking" });
  const t = await signedIn(browser, own.ownerEmail);
  await expectBoth(t.page, 1);
  await insertRow({ studioId: own.studioId, practitionerId: null, type: "new_booking" });
  await insertRow({ studioId: own.studioId, practitionerId: ownOwner, type: "card_added" });
  await pollNow(t);
  await expectBoth(t.page, 3); // the POLL raised it above the server-rendered 1
  const polls = t.responses();
  await t.page.locator('[data-testid="nav-notifications"]:visible').click();
  await t.page.waitForURL(/\/notifications/, { timeout: 20_000 });
  await expectBoth(t.page, 3);
  await t.page.getByRole("button", { name: "Mark all read" }).click();
  // the action re-renders the shell with the server's number (0): that wins, with no poll needed
  await expectBoth(t.page, 0);
  expect(t.responses(), "the lower number came from the server render, not a poll").toBe(polls);
  await pollNow(t);
  await expectBoth(t.page, 0);
  const left = await sql<{ n: string }>("select count(*)::text as n from public.practitioner_notifications where studio_id=$1 and read_at is null", [own.studioId]);
  expect(left[0].n).toBe("0");
});

test("at 390 px both bell instances are in the DOM, one request on load, and the count updates once on both", async ({ browser }) => {
  const t = await signedIn(browser, seed.ownerEmail, { width: 390, height: 844 });
  await expect(bells(t.page)).toHaveCount(2);
  await t.page.waitForTimeout(2_000);
  expect(t.requests()).toBe(1);
  const before = (await labels(t.page))[0];
  expect((await labels(t.page))[1]).toBe(before);
  await insertRow({ studioId: seed.studioId, practitionerId: null, type: "new_booking", title: "Synthetic phone booking" });
  await pollNow(t);
  const after = await labels(t.page);
  expect(after[0]).toBe(after[1]);
  expect(after[0]).not.toBe(before);
  // exactly one of the two is the visible one
  await expect(t.page.locator('[data-testid="nav-notifications"]:visible')).toHaveCount(1);
});
