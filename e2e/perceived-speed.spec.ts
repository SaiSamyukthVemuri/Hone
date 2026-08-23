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
async function holdNavigation(page: Page, matches: (url: URL) => boolean) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;

  await page.route(
    (url) => matches(url),
    async (route) => {
      const headers = route.request().headers();
      const isNavigation =
        headers["rsc"] === "1" && headers["next-router-prefetch"] !== "1";
      if (isNavigation) {
        held += 1;
        await gate;
      }
      await route.continue();
    },
  );

  return {
    held: () => held,
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
  });
}

test.describe("UI-01 perceived speed — desktop", () => {
  test("a held day navigation is acknowledged on the tapped control, and clears when it lands", async ({
    page,
  }) => {
    await provesTheTappedControlAcknowledges(page);
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
