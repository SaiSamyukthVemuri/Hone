import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  seedE2eDashboardClient,
  seedE2eStudio,
  seedE2eTodayAppointment,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// UI-01 — the perceived-speed floor, on the navigation nothing else can cover.
//
// The claim under test is about WHAT CHLOE SEES BETWEEN THE TAP AND THE PAGE,
// and nothing else. It is not a backend-speed claim: nothing here measures how
// long the server takes, and the only reason anything is slow in this file is
// that the TEST holds the response.
//
// WHY THE DAY NAVIGATION SPECIFICALLY
// -----------------------------------
// The obvious mechanism for "acknowledge a tap" in the App Router is a route
// `loading.tsx`. It cannot serve this surface: `/dashboard?day=A` ->
// `?day=B` changes only the query, so the SEGMENT is unchanged, React reuses
// the tree, and no route fallback ever renders. The page sits there — complete,
// stale and fully interactive — for as long as the server takes to re-run the
// heaviest briefing in the app. Only the control the finger is on can speak,
// which is exactly what PendingLink does.
//
// (A route-level boundary was built for the other half of this and withdrawn:
// placed above a segment reached by query-only navigation, it stalls that
// navigation outright. See the PR for the reproduction. PendingLink is not
// affected — it adds no Suspense boundary and no click handler, and every
// pre-existing dashboard-day-navigation test passes with it in place.)
//
// WHY THE DELAY LIVES IN THE TEST
// -------------------------------
// A pending state is only observable while something is pending, and a local
// stack answers fast enough that the window is a coin flip. The honest way to
// widen it is from outside the product: Playwright holds the RSC response at
// the network boundary, so the application code under test is byte-for-byte
// what production runs — no sleep, no test-only branch, no seam that exists
// only for this file.
//
// Every test asserts the ORDER, which is the whole product contract:
// acknowledgement is on screen BEFORE the destination exists, the destination
// then arrives, and the acknowledgement is gone. The last of those catches a
// mechanism that leaves stuck pending UI, so a normal-speed control runs too.

const T = 30_000;

/**
 * Hold every real RSC navigation whose URL matches, until released.
 *
 * Prefetches are deliberately NOT held. Next tags every RSC fetch `RSC: 1` and
 * additionally tags speculative ones `Next-Router-Prefetch: 1`; holding those
 * would stall work the user never asked for and would prove nothing about a
 * tap.
 *
 * `held()` is the anti-vacuity check: if the gate never intercepted anything,
 * the navigation was served from cache and every "pending appeared" assertion
 * below would be describing a window that was never opened.
 */
async function holdNavigation(
  page: Page,
  matches: (url: URL) => boolean,
  opts: { blockPrefetch?: boolean } = {},
) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  let prefetchesBlocked = 0;

  await page.route(
    (url) => matches(url),
    async (route) => {
      const headers = route.request().headers();
      if (headers["next-router-prefetch"] === "1") {
        // SEGMENT CHANGES ONLY. Next AUTO-prefetches a <Link> when it enters
        // the viewport, and for a different pathname that prefetch can satisfy
        // the whole navigation — the click then issues NO request and there is
        // nothing to hold. A proof built on that window would be describing a
        // coincidence. Blocking the speculative fetch leaves the cache empty so
        // the tap must make a cold request we control, which is also the only
        // case where perceived speed matters. Query-only navigation does not
        // need this: the destination is the same pathname we are already on.
        if (opts.blockPrefetch) {
          prefetchesBlocked += 1;
          await route.abort();
          return;
        }
      } else if (headers["rsc"] === "1") {
        held += 1;
        await gate;
      }
      await route.continue();
    },
  );

  return {
    held: () => held,
    prefetchesBlocked: () => prefetchesBlocked,
    /**
     * Let the held request through. Deliberately does NOT unroute: with the
     * gate open the handler is a pass-through, and removing interception in
     * the same call put a Playwright teardown between the released request and
     * its response, which stalls the navigation for reasons that have nothing
     * to do with the product.
     */
    release() {
      open();
    },
  };
}

/** The mark PendingLink paints on the control the finger is on. */
function tapAcknowledgement(control: Locator): Locator {
  return control.locator("[data-link-pending]");
}

async function seedTodayVisit(seed: E2eSeed, label: string) {
  const client = await seedE2eDashboardClient(seed, { label });
  await seedE2eTodayAppointment(seed, {
    clientId: client.clientId,
    // Local morning + 90 minutes is still today in the seeded studio's
    // timezone, which is the same assumption dashboard-day-navigation makes.
    startsMinutesFromNow: 90,
    endsMinutesFromNow: 135,
    withService: true,
  });
  return client;
}

/**
 * The shared body of the desktop and 390px runs.
 *
 * Both viewports must prove the SAME contract — a phone is where a dead-feeling
 * tap is least forgivable, and it is also where the day nav is most used — so
 * the assertions live in one place and the viewport is the only variable.
 */
async function provesTheTappedControlAcknowledges(
  page: Page,
  opts: { whilePending?: (page: Page) => Promise<void> } = {},
) {
  const seed = await seedE2eStudio();
  await seedTodayVisit(seed, "Perceived Speed");
  await loginAsOwner(page, seed);

  await page.goto("/dashboard");
  const today = page.getByRole("heading", {
    level: 2,
    name: "Today",
    exact: true,
  });
  const tomorrow = page.getByRole("heading", {
    level: 2,
    name: "Tomorrow",
    exact: true,
  });
  await expect(today).toBeVisible({ timeout: T });

  // Step off Today at FULL SPEED first. This is the normal-speed control —
  // nothing is held, so a mechanism that leaves pending UI behind fails right
  // here — and it is also what turns the Today segment into a link: on Today it
  // is deliberately inert, so it marks where you are without moving the arrows
  // under the thumb.
  await page.getByTestId("dashboard-next-day").click();
  await expect(tomorrow).toBeVisible({ timeout: T });
  await expect(page.locator("[data-link-pending]")).toHaveCount(0);

  // `dashboard-today` is the only day-nav control with NO aria-label, so its
  // accessible name IS its visible label. That makes it the one control here
  // that can prove the label was FADED and not REMOVED: `visibility:hidden`
  // would drop it from the accessibility tree and collapse the name to
  // "Loading day…", and an aria-labelled control would mask exactly that bug.
  const todayLink = page.getByTestId("dashboard-today");
  await expect(todayLink).toBeVisible();

  // The live region must already EXIST, and be empty, before anything is
  // pending. A polite region inserted already containing its message is not
  // reliably announced, so a conditionally-rendered one leaves the pending
  // state silent for screen-reader users — who get no other signal, since the
  // mark is aria-hidden and the label change is purely visual.
  const liveRegion = todayLink.locator('[role="status"]');
  await expect(liveRegion).toBeAttached();
  await expect(liveRegion).toHaveText("");

  const resting = await todayLink.boundingBox();
  expect(resting).not.toBeNull();
  // The 44px interaction floor is a property of the RESTING control.
  expect(resting!.height).toBeGreaterThanOrEqual(44);

  const gate = await holdNavigation(
    page,
    (url) => url.pathname === "/dashboard",
  );
  await todayLink.click();

  await test.step("the segment the thumb is on says the day is loading", async () => {
    await expect(tapAcknowledgement(todayLink)).toBeVisible({ timeout: T });
    expect(gate.held()).toBeGreaterThan(0);

    // Still the old day. The acknowledgement is about the REQUEST; it makes no
    // claim about which day is on screen, and the heading proves the page has
    // not moved.
    await expect(tomorrow).toBeVisible();

    // The SAME region that was already mounted now carries the message — it
    // was not created for the occasion.
    await expect(liveRegion).toHaveText("Loading day…");

    // The words that say WHERE the control goes survive the pending state.
    await expect(todayLink).toHaveAccessibleName(/Today/);

    // And it must not move under the finger: the mark is positioned, the label
    // only fades. The day nav is a segmented control whose arrows are
    // deliberately kept still between days; a pending state that resized it
    // would undo that.
    expect(await todayLink.boundingBox()).toEqual(resting);

    if (opts.whilePending) await opts.whilePending(page);
  });

  await test.step("the day arrives and the control returns to rest", async () => {
    gate.release();
    await expect(today).toBeVisible({ timeout: T });
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);
    // The region stays mounted and goes quiet, ready for the next tap.
    await expect(page.getByTestId("dashboard-next-day").locator('[role="status"]')).toHaveText("");
  });
}

test.describe("UI-01 perceived speed — desktop", () => {
  test("a held day navigation is acknowledged on the tapped control, and clears when it lands", async ({
    page,
  }) => {
    await provesTheTappedControlAcknowledges(page);
  });
});

/**
 * UI-01B — SEGMENT-CHANGING navigation (Dashboard -> Client Profile).
 *
 * Different mechanism from the day nav above, same primitive. A segment change
 * has no route boundary in this app (there are zero loading.tsx files, and one
 * cannot be added: above a query-navigated segment it stalls that navigation —
 * see PR #624). So React keeps the OLD page mounted until the destination
 * commits, which is precisely why the tapped control is still there to speak.
 *
 * Cases: (A) normal speed completes, (B) held response shows pending before the
 * destination, (D) warm prefetch leaves nothing stuck. (C) is the negative
 * control, run by bypassing the presentation.
 */
async function provesSegmentChangeIsAcknowledged(page: Page) {
  const seed = await seedE2eStudio();
  const client = await seedTodayVisit(seed, "Segment Change");
  await loginAsOwner(page, seed);

  // Installed BEFORE the dashboard renders so the destination is never
  // prefetched and the click must issue a cold request we hold.
  const gate = await holdNavigation(
    page,
    (url) => url.pathname.startsWith("/clients/"),
    { blockPrefetch: true },
  );

  await page.goto("/dashboard");

  const cta = page.getByTestId("today-consultation-notes").first();
  const dashboardHeading = page.getByRole("heading", { level: 1, name: "Dashboard" });
  const destination = page.getByRole("heading", { level: 1, name: client.name });

  await expect(cta).toBeVisible({ timeout: T });
  await expect(dashboardHeading).toBeVisible();
  const dashboardUrl = page.url();

  // The live region exists and is empty before anything is pending.
  const liveRegion = cta.locator('[role="status"]');
  await expect(liveRegion).toBeAttached();
  await expect(liveRegion).toHaveText("");

  const resting = await cta.boundingBox();
  expect(resting).not.toBeNull();
  expect(resting!.height).toBeGreaterThanOrEqual(44);

  await cta.click();

  await test.step("B: the tap is acknowledged before the destination exists", async () => {
    await expect(tapAcknowledgement(cta)).toBeVisible({ timeout: T });
    expect(gate.held()).toBeGreaterThan(0);
    expect(gate.prefetchesBlocked()).toBeGreaterThan(0);

    // The old Dashboard is still mounted — this is what a segment change does
    // WITHOUT a route boundary, and what makes the control available to speak.
    await expect(dashboardHeading).toBeVisible();
    await expect(cta).toBeVisible();

    // The destination does not exist yet.
    await expect(destination).toHaveCount(0);

    // The request is described, never an outcome.
    await expect(liveRegion).toHaveText("Opening client…");

    // Accessible name survives; the control neither moves nor resizes.
    await expect(cta).toHaveAccessibleName(/consultation notes/i);
    expect(await cta.boundingBox()).toEqual(resting);

    // The transition has not committed, so the URL has not moved.
    expect(page.url()).toBe(dashboardUrl);
  });

  await test.step("B: release -> destination renders, pending clears globally", async () => {
    gate.release();
    await expect(destination).toBeVisible({ timeout: T });
    const landed = new URL(page.url());
    expect(landed.pathname).toBe(`/clients/${client.clientId}`);
    // The requested tab is preserved — the acknowledgement changed no semantics.
    expect(landed.searchParams.get("tab")).toBe("consultation");
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);
    await expect(liveRegion).toHaveCount(0);
  });

  await test.step("A + D: normal speed on a PROVEN-warm cache, nothing stuck", async () => {
    // Nothing held and nothing blocked, against a cache proven warm below.
    // Whether the mark paints here is timing, not contract: this step fixes no
    // minimum display duration and asserts none. What it does assert is that
    // the navigation completes and leaves no residue.
    //
    // But "warm" has to be ESTABLISHED, not hoped for. Link visibility only
    // makes a prefetch ELIGIBLE; on a busy runner the click can beat it, and
    // this step would silently become a second cold navigation that passes
    // while proving nothing about the warm path. So we watch for a COMPLETED
    // prefetch response and refuse to click until one has landed.
    await page.unrouteAll({ behavior: "wait" });

    let prefetchesCompleted = 0;
    let coldNavigations = 0;
    const countTraffic = (response: import("@playwright/test").Response) => {
      const req = response.request();
      const h = req.headers();
      if (!new URL(req.url()).pathname.startsWith("/clients/")) return;
      if (h["next-router-prefetch"] === "1") {
        if (response.ok()) prefetchesCompleted += 1;
      } else if (h["rsc"] === "1") {
        coldNavigations += 1;
      }
    };
    page.on("response", countTraffic);

    await page.goto("/dashboard");
    const warmCta = page.getByTestId("today-consultation-notes").first();
    await expect(warmCta).toBeVisible({ timeout: T });
    // Make the prefetch eligible at every viewport — at 390px the control may
    // start below the fold, where it would never be prefetched at all.
    await warmCta.scrollIntoViewIfNeeded();

    // THE PRECONDITION. Without this the step is vacuous.
    await expect
      .poll(() => prefetchesCompleted, { timeout: T })
      .toBeGreaterThan(0);

    const navigationsBeforeClick = coldNavigations;
    await warmCta.click();
    await expect(
      page.getByRole("heading", { level: 1, name: client.name }),
    ).toBeVisible({ timeout: T });

    // MEASURED, and it corrects an assumption worth writing down.
    //
    // A completed AUTO prefetch does NOT satisfy this navigation: the tap still
    // issues its own RSC request. That is consistent with what the prefetch
    // actually contains — for a dynamic route with no loading.tsx there is no
    // page data to cache, so there is nothing for the click to be served from.
    // An earlier reading of "no request on click" was in-flight request DEDUPE
    // (clicking while the speculative fetch was still open), not a warm cache
    // serving the navigation.
    //
    // So on this route "warm" buys a head start, not an instant commit, and the
    // mark can legitimately paint here too. This step therefore claims only
    // what is true of BOTH timings: the navigation completes and leaves nothing
    // behind. It fixes no minimum display duration in either direction.
    expect(coldNavigations).toBeGreaterThan(navigationsBeforeClick);

    // No residue specific to an instantly-satisfied navigation.
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);
    await expect(
      page.getByTestId("today-consultation-notes"),
    ).toHaveCount(0);

    page.off("response", countTraffic);
  });
}

test.describe("UI-01B segment change — desktop", () => {
  test("Dashboard -> Client Profile is acknowledged on the tapped control", async ({
    page,
  }) => {
    await provesSegmentChangeIsAcknowledged(page);
  });
});

test.describe("UI-01B segment change — 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("the same acknowledgement on a phone", async ({ page }) => {
    await provesSegmentChangeIsAcknowledged(page);
  });
});

test.describe("UI-01 perceived speed — 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the same acknowledgement appears on a phone, without pushing the page sideways", async ({
    page,
  }) => {
    await provesTheTappedControlAcknowledges(page, {
      whilePending: async (p) => {
        // A pending mark is an element added to a control that was already
        // sized to fit, which is one way a loading state ships a horizontal
        // scrollbar the resting page never had.
        const doc = await p.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
      },
    });
  });
});
