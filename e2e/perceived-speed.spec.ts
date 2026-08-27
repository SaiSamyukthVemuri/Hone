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
  opts: { blockPrefetch?: boolean; holdPrefetch?: boolean } = {},
) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  let prefetchesBlocked = 0;
  let prefetchesHeld = 0;

  await page.route(
    (url) => matches(url),
    async (route) => {
      const headers = route.request().headers();
      if (headers["next-router-prefetch"] === "1") {
        // SEGMENT CHANGES ONLY. Next AUTO-prefetches a <Link> when it enters
        // the viewport, and for a different pathname that prefetch can satisfy
        // the whole navigation — the click then issues NO request and there is
        // nothing to hold. A proof built on that window would be describing a
        // coincidence. So the speculative fetch has to be neutralised, and
        // there are two ways to do it. Query-only navigation needs neither: the
        // destination is the same pathname we are already on.
        //
        // ABORT leaves the router cache empty and, for the /clients/ segment
        // below, the tap then makes the cold request this gate holds.
        if (opts.blockPrefetch) {
          prefetchesBlocked += 1;
          await route.abort();
          return;
        }
        // HOLD does the same thing without failing anything, and it is what
        // UI-01C's destinations require. MEASURED on /calendar/<id>: with the
        // prefetch aborted, the tap did not make a client navigation at all —
        // two aborted prefetches, then a plain DOCUMENT request carrying no
        // `RSC` header, i.e. a full page load. There is no client transition in
        // that sequence, so there is nothing for any pending presentation to
        // report, and a test built on it would be asserting against a fallback
        // production never takes. Holding the speculative request keeps the
        // cache just as empty while leaving every request successful, so the
        // tap performs the ordinary soft navigation this file exists to observe.
        if (opts.holdPrefetch) {
          prefetchesHeld += 1;
          held += 1;
          await gate;
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
    prefetchesHeld: () => prefetchesHeld,
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
  const { appointmentId } = await seedE2eTodayAppointment(seed, {
    clientId: client.clientId,
    // Local morning + 90 minutes is still today in the seeded studio's
    // timezone, which is the same assumption dashboard-day-navigation makes.
    startsMinutesFromNow: 90,
    endsMinutesFromNow: 135,
    withService: true,
  });
  return { ...client, appointmentId };
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
 * Cases: (A) an ordinary navigation completes and leaves nothing behind,
 * (B) a held response shows pending BEFORE the destination. (C) is the negative
 * control, run by bypassing the presentation.
 *
 * There is no separate warm-cache case: on this route a tap always performs a
 * real navigation, for the reasons recorded at case A.
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

  await test.step("A: an ordinary navigation completes and leaves nothing behind", async () => {
    // Nothing held, nothing blocked — the everyday path.
    //
    // There is deliberately NO separate "warm cache serves this instantly" case
    // here, because on this route that scenario does not occur. Measured:
    //
    //   - the consultation CTA never produces its own `?tab=consultation`
    //     prefetch request. Prefetching for these client destinations is keyed
    //     by PATHNAME, so the neighbouring row action pointing at
    //     /clients/<id> already covers it;
    //   - and that pathname-level prefetch does not remove the click's real RSC
    //     navigation — the tap still fetches.
    //
    // So every tap here performs a genuine navigation, and whether the mark is
    // on screen long enough to notice is timing rather than contract. This step
    // therefore fixes NO minimum pending-display duration and asserts none. It
    // asserts only what must always hold: the destination arrives, and nothing
    // pending is left behind.
    await page.unrouteAll({ behavior: "wait" });
    await page.goto("/dashboard");

    const cta2 = page.getByTestId("today-consultation-notes").first();
    await expect(cta2).toBeVisible({ timeout: T });
    await cta2.click();

    await expect(
      page.getByRole("heading", { level: 1, name: client.name }),
    ).toBeVisible({ timeout: T });
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);
    // "Nothing is announcing", not "no region exists".
    //
    // The destination is the Client Profile, and since UI-01D its tab bar
    // mounts a live region AT ALL TIMES — a polite region has to exist before
    // its text changes, or the message it is inserted holding is not reliably
    // announced. So an empty `[role="status"]` on this page is correct, and a
    // count of zero would now be asserting the opposite of the contract.
    // `:not(:empty)` keeps the original claim intact and makes it stricter: a
    // stale "Opening…" left behind by any mechanism still fails here.
    await expect(page.locator('[role="status"]:not(:empty)')).toHaveCount(0);
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

// ===========================================================================
// UI-01C — the two surfaces UI-01A/B deliberately left behind
// ===========================================================================
//
// Both were known and both were postponed for a stated reason, not overlooked:
//
//   * THE APPOINTMENT ROW BODY (Dashboard -> /calendar/<id>) could not use the
//     shipped label form, because the row body is itself a flex container over
//     a fixed time cell and a `min-w-0 flex-1` text column, and that form wraps
//     children in one span — which would collapse both into a single track. It
//     now uses the CONTAINER form, whose entire claim is that it changes no
//     layout at all. That claim is what the geometry step below measures.
//
//   * THE CALENDAR TOOLBAR is the same family as the dashboard day nav: five
//     of its six controls change only the query on a pathname the practitioner
//     is already on, so no route boundary can render for them either.
//
// Same primitive, same `data-link-pending` hook, same live region. There is one
// pending-navigation mechanism in this app and these two surfaces joined it.

/**
 * The row body's own box, and the boxes of its IN-FLOW children.
 *
 * STRUCTURAL, not pixel-matched. A screenshot comparison of a clinical row
 * would fail on the scrim itself — which is the point of the feature — and
 * would say nothing about WHY. This reads the layout the browser actually
 * computed:
 *
 *   * `inFlowCount` is the direct test of the collapse the container form
 *     exists to avoid. Two children means the time cell and the text column
 *     are still two flex items; one would mean something wrapped them, and
 *     three would mean the acknowledgement became a track of its own.
 *   * child offsets are measured RELATIVE to the anchor, so page scroll cannot
 *     perturb the comparison — only real layout movement can.
 */
type RowGeometry = {
  display: string;
  inFlowCount: number;
  self: { w: number; h: number };
  children: Array<{ dx: number; dy: number; w: number; h: number }>;
};

async function rowBodyGeometry(row: Locator): Promise<RowGeometry> {
  return row.evaluate((el) => {
    const round = (n: number) => Math.round(n * 100) / 100;
    const origin = el.getBoundingClientRect();
    // Absolutely positioned children are not flex items and do not participate
    // in flex layout, which is exactly why the scrim and the live region may
    // live inside this anchor. Filtering on the COMPUTED position asserts that
    // property against the browser rather than against a class name.
    const inFlow = [...el.children].filter(
      (c) => getComputedStyle(c).position === "static",
    );
    return {
      display: getComputedStyle(el).display,
      inFlowCount: inFlow.length,
      self: { w: round(origin.width), h: round(origin.height) },
      children: inFlow.map((c) => {
        const r = c.getBoundingClientRect();
        return {
          dx: round(r.x - origin.x),
          dy: round(r.y - origin.y),
          w: round(r.width),
          h: round(r.height),
        };
      }),
    };
  });
}

/**
 * The shared body of the desktop and 390px row-body runs.
 *
 * A phone is where this matters most: the row body is the largest touch target
 * on the Dashboard and the one a practitioner reaches for while a client is in
 * front of her.
 */
async function provesTheRowBodyAcknowledges(
  page: Page,
  opts: { whilePending?: (page: Page) => Promise<void> } = {},
) {
  const seed = await seedE2eStudio();
  const client = await seedTodayVisit(seed, "Row Body");
  await loginAsOwner(page, seed);

  const appointmentPath = `/calendar/${client.appointmentId}`;

  // Installed BEFORE the dashboard renders, so the appointment detail is never
  // prefetched and the tap must issue a cold request this test controls.
  const gate = await holdNavigation(
    page,
    (url) => url.pathname === appointmentPath,
    { holdPrefetch: true },
  );

  await page.goto("/dashboard");

  const row = page.getByTestId("today-row-body").first();
  const dashboardHeading = page.getByRole("heading", {
    level: 1,
    name: "Dashboard",
  });
  await expect(row).toBeVisible({ timeout: T });
  await expect(dashboardHeading).toBeVisible();
  const dashboardUrl = page.url();

  // The live region exists and is empty before anything is pending.
  const liveRegion = row.locator('[role="status"]');
  await expect(liveRegion).toBeAttached();
  await expect(liveRegion).toHaveText("");

  const resting = await rowBodyGeometry(row);
  // The row body is the flex container the label form could not serve, and its
  // two children are the reason. If this ever stops being true the geometry
  // comparison below would be comparing something else.
  expect(resting.display).toBe("flex");
  expect(resting.inFlowCount).toBe(2);

  await row.click();

  await test.step("the row the finger is on acknowledges, before the appointment exists", async () => {
    await expect(tapAcknowledgement(row)).toBeVisible({ timeout: T });
    // Anti-vacuity: this destination really is in flight and this test really is
    // the thing holding it. Without that, "pending appeared" would be a claim
    // about a window that was never opened.
    expect(gate.held()).toBeGreaterThan(0);
    expect(gate.prefetchesHeld()).toBeGreaterThan(0);

    // The old Dashboard is still mounted, which is what leaves the row on
    // screen and able to speak.
    await expect(dashboardHeading).toBeVisible();
    // The transition has not committed, so the URL has not moved.
    expect(page.url()).toBe(dashboardUrl);

    // The request is described, never an outcome.
    await expect(liveRegion).toHaveText("Opening appointment…");

    // NOTHING WAS HIDDEN. A label may fade to opacity-0 because its accessible
    // name survives; a treatment row may not, because its content is the
    // client's name and the caution line. The row still reads, and still names
    // itself to a screen reader.
    await expect(row).toContainText(client.name);
    await expect(row).toHaveAccessibleName(new RegExp(client.name));

    if (opts.whilePending) await opts.whilePending(page);
  });

  await test.step("...and the pending presentation moved no layout at all", async () => {
    const pending = await rowBodyGeometry(row);
    // Still two flex items: the scrim did not become a track, and nothing
    // wrapped the children into one.
    expect(pending.inFlowCount).toBe(2);
    // Identical, not merely close — every number here is measured relative to
    // the anchor, so there is no legitimate source of drift between the two
    // reads. `toEqual` on the whole shape also catches a child that moved by
    // exactly as much as its sibling.
    expect(pending).toEqual(resting);
  });

  await test.step("the appointment arrives, exactly once, and the row returns to rest", async () => {
    gate.release();
    await expect(page).toHaveURL(new RegExp(`${appointmentPath}$`), {
      timeout: T,
    });
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);

    // EXACTLY ONE navigation. A pending presentation that also started a
    // navigation of its own — an onClick beside the anchor's own activation —
    // would push two entries, and Back would land on a second copy of the
    // appointment instead of on the Dashboard.
    await page.goBack();
    await expect(dashboardHeading).toBeVisible({ timeout: T });
  });
}

test.describe("UI-01C row body — desktop", () => {
  test("the appointment row acknowledges the tap without moving", async ({
    page,
  }) => {
    await provesTheRowBodyAcknowledges(page);
  });
});

test.describe("UI-01C row body — 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the same acknowledgement, and the same geometry, on a phone", async ({
    page,
  }) => {
    await provesTheRowBodyAcknowledges(page, {
      whilePending: async (p) => {
        // An overlay stretched over a control that was already sized to fit is
        // one way a loading state ships a horizontal scrollbar the resting page
        // never had.
        const doc = await p.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
      },
    });
  });
});

test.describe("UI-01C row body — keyboard", () => {
  test("Enter on the focused row is acknowledged and navigates once", async ({
    page,
  }) => {
    // A pending presentation built on a click handler would be silent here, and
    // one built on an overlay that swallowed events would break activation
    // outright. This is still a real anchor: it takes focus, Enter activates it,
    // and the same acknowledgement appears.
    const seed = await seedE2eStudio();
    const client = await seedTodayVisit(seed, "Row Keyboard");
    await loginAsOwner(page, seed);

    const appointmentPath = `/calendar/${client.appointmentId}`;
    const gate = await holdNavigation(
      page,
      (url) => url.pathname === appointmentPath,
      { holdPrefetch: true },
    );

    await page.goto("/dashboard");
    const row = page.getByTestId("today-row-body").first();
    await expect(row).toBeVisible({ timeout: T });

    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(tapAcknowledgement(row)).toBeVisible({ timeout: T });
    expect(gate.held()).toBeGreaterThan(0);
    await expect(row.locator('[role="status"]')).toHaveText(
      "Opening appointment…",
    );

    gate.release();
    await expect(page).toHaveURL(new RegExp(`${appointmentPath}$`), {
      timeout: T,
    });
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);
  });
});

/**
 * UI-01C — the CALENDAR TOOLBAR.
 *
 * Desktop only, and deliberately: on the week view the step nav is
 * `hidden md:flex`, because the mobile day view owns day navigation there. The
 * controls this test drives do not exist at 390px on that surface, so a phone
 * run would assert nothing.
 *
 * Date navigation is the regression risk here, not the acknowledgement — this
 * is the one surface where a wrong href silently shows the wrong week. So every
 * step reads the control's OWN href first and then asserts the URL it landed
 * on, which proves both that the destination is untouched and that the tap
 * navigated exactly once.
 */
async function provesTheToolbarAcknowledges(page: Page) {
  const seed = await seedE2eStudio();
  await loginAsOwner(page, seed);

  await page.goto("/calendar");
  const range = page.getByRole("heading", { level: 1 });
  await expect(range).toBeVisible({ timeout: T });

  const urlPath = () => {
    const u = new URL(page.url());
    return `${u.pathname}${u.search}`;
  };
  const thisWeekRange = (await range.textContent())!.trim();

  const next = page.getByTestId("calendar-next");
  const prev = page.getByTestId("calendar-prev");

  await test.step("full speed first: the step nav still navigates, and leaves nothing behind", async () => {
    // The normal-speed control. A mechanism that leaks pending UI fails here,
    // before anything is held — and this is also the date-navigation
    // regression check: one tap moves exactly one week, to the href the
    // toolbar itself was rendering.
    const nextHref = await next.getAttribute("href");
    expect(nextHref).toMatch(/^\/calendar\?week=\d{4}-\d{2}-\d{2}$/);
    await next.click();
    await expect(range).not.toHaveText(thisWeekRange, { timeout: T });
    expect(urlPath()).toBe(nextHref);
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);
  });

  const nextWeekRange = (await range.textContent())!.trim();
  const backHref = await prev.getAttribute("href");

  const gate = await holdNavigation(page, (url) => url.pathname === "/calendar");
  const restingBox = await prev.boundingBox();
  expect(restingBox).not.toBeNull();
  const liveRegion = prev.locator('[role="status"]');
  await expect(liveRegion).toHaveText("");

  await prev.click();

  await test.step("the arrow the finger is on says the calendar is loading", async () => {
    await expect(tapAcknowledgement(prev)).toBeVisible({ timeout: T });
    expect(gate.held()).toBeGreaterThan(0);

    // Still the old week. The acknowledgement is about the REQUEST and makes no
    // claim about which dates are arriving; the heading proves nothing moved.
    await expect(range).toHaveText(nextWeekRange);
    await expect(liveRegion).toHaveText("Loading calendar…");

    // The words that say what the control does survive the pending state, and
    // the arrow does not move under the finger — this is a segmented control
    // whose two arrows sit against each other inside one rounded border.
    await expect(prev).toHaveAccessibleName(/Previous/);
    expect(await prev.boundingBox()).toEqual(restingBox);
  });

  await test.step("the week arrives, on the href the control was rendering", async () => {
    gate.release();
    await expect(range).toHaveText(thisWeekRange, { timeout: T });
    expect(urlPath()).toBe(backHref);
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);
    await expect(liveRegion).toHaveText("");
  });

  await test.step("the view toggle acknowledges too, and keeps its own semantics", async () => {
    await page.unrouteAll({ behavior: "wait" });
    const monthGate = await holdNavigation(
      page,
      (url) => url.pathname === "/calendar",
    );
    const month = page.getByTestId("calendar-view-month");
    const monthHref = await month.getAttribute("href");
    await month.click();

    await expect(tapAcknowledgement(month)).toBeVisible({ timeout: T });
    expect(monthGate.held()).toBeGreaterThan(0);
    await expect(month.locator('[role="status"]')).toHaveText("Loading view…");
    // Still the week view underneath: the tab has not become current yet,
    // because the navigation has not committed.
    await expect(page.getByTestId("calendar-view-week")).toHaveAttribute(
      "aria-current",
      "page",
    );

    monthGate.release();
    await expect(month).toHaveAttribute("aria-current", "page", { timeout: T });
    expect(urlPath()).toBe(monthHref);
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);
  });

  await test.step("Upcoming is a SEGMENT change, and is acknowledged the same way", async () => {
    await page.unrouteAll({ behavior: "wait" });
    const upcomingGate = await holdNavigation(
      page,
      (url) => url.pathname === "/calendar/upcoming",
      { holdPrefetch: true },
    );
    await page.goto("/calendar");
    const upcoming = page.getByTestId("calendar-upcoming");
    await expect(upcoming).toBeVisible({ timeout: T });
    const beforeUrl = page.url();

    await upcoming.click();
    await expect(tapAcknowledgement(upcoming)).toBeVisible({ timeout: T });
    expect(upcomingGate.held()).toBeGreaterThan(0);
    await expect(upcoming.locator('[role="status"]')).toHaveText(
      "Opening upcoming…",
    );
    // The old calendar is still mounted and the URL has not moved.
    expect(page.url()).toBe(beforeUrl);

    upcomingGate.release();
    await expect(
      page.getByRole("heading", { level: 1, name: "Upcoming" }),
    ).toBeVisible({ timeout: T });
    await expect(page.locator("[data-link-pending]")).toHaveCount(0);
  });
}

test.describe("UI-01C calendar toolbar — desktop", () => {
  test("every toolbar navigation acknowledges the tap, and moves no dates it should not", async ({
    page,
  }) => {
    await provesTheToolbarAcknowledges(page);
  });
});

// ===========================================================================
// UI-01D — the Client Profile tab bar
// ===========================================================================
//
// WHAT THIS ADDS THAT tests/components/profile-tab-bar.test.ts CANNOT
// -------------------------------------------------------------------
// That file pins the state machine by rendering the component with the
// transition forced, which is precise but is not a navigation. This one holds
// a REAL query-only RSC request and asserts the three things only a browser
// can show: that the acknowledgement is on screen before the destination
// exists, that `aria-current` does not move until the transition commits, and
// that keyboard focus survives the pending window.
//
// That last one is the regression with teeth. The tab bar used to set
// `disabled={pending && !isActive}`, and a browser blurs an element the moment
// it becomes disabled — so pressing Enter on a tab dropped focus to <body> and
// Tab restarted from the top of the page. No render assertion sees that; it is
// a live-DOM behaviour.
//
// WHY THE TAB BAR NEEDS THIS FILE'S GATE AND NOT A ROUTE BOUNDARY
// ---------------------------------------------------------------
// `?tab=` changes only the query, so the segment is unchanged, React reuses
// the tree, and no route fallback can render — the same structural reason
// UI-01A gave for the day navigation. Query-only navigation also needs neither
// `blockPrefetch` nor `holdPrefetch`: the destination is the pathname we are
// already on.

test.describe("UI-01D Client Profile tabs — desktop", () => {
  test("a held tab change acknowledges the target without making it current", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const client = await seedE2eDashboardClient(seed, { label: "Tab Nav" });
    await loginAsOwner(page, seed);

    await page.goto(`/clients/${client.clientId}`);

    const tabRow = page.getByRole("navigation", {
      name: "Client profile sections",
    });
    const overview = tabRow.getByRole("button", { name: "Overview" });
    const sessions = tabRow.getByRole("button", { name: "Sessions" });
    const liveRegion = tabRow.locator('[role="status"]');

    await expect(overview).toBeVisible({ timeout: T });
    await expect(overview).toHaveAttribute("aria-current", "page");
    await expect(sessions).not.toHaveAttribute("aria-current", "page");
    // Mounted before it has anything to say — a polite region inserted
    // already holding its message is not reliably announced.
    await expect(liveRegion).toBeAttached();
    await expect(liveRegion).toHaveText("");

    const resting = await sessions.boundingBox();
    expect(resting).not.toBeNull();

    const gate = await holdNavigation(
      page,
      (url) => url.pathname === `/clients/${client.clientId}`,
    );

    // Activate from the KEYBOARD, so the focus assertion below is about a real
    // keyboard journey rather than a synthetic click.
    await sessions.focus();
    await page.keyboard.press("Enter");

    await test.step("pending: the target is busy, the current tab is still current", async () => {
      await expect(sessions).toHaveAttribute("aria-busy", "true");
      expect(gate.held()).toBeGreaterThan(0);

      // The contract, in two assertions: the tab being LEFT is still the
      // current one, and the tab being OPENED has not become current.
      await expect(overview).toHaveAttribute("aria-current", "page");
      await expect(sessions).not.toHaveAttribute("aria-current", "page");

      // No tab is disabled. This is what keeps focus where the practitioner
      // put it, and what lets them change their mind mid-flight.
      await expect(sessions).toBeEnabled();
      await expect(overview).toBeEnabled();
      await expect(
        tabRow.locator("button[disabled]"),
      ).toHaveCount(0);

      // Focus never left the control that was activated.
      await expect(sessions).toBeFocused();

      // The request is described, never an outcome.
      await expect(liveRegion).toHaveText("Opening Sessions…");

      // Accessible name survives the fade; the tab neither moves nor resizes.
      await expect(sessions).toHaveAccessibleName(/Sessions/);
      expect(await sessions.boundingBox()).toEqual(resting);

      // Query-only navigation invents no route-level loading state: the tab
      // bar is still mounted and the URL has not moved.
      await expect(tabRow).toBeVisible();
      expect(new URL(page.url()).searchParams.get("tab")).toBeNull();
    });

    await test.step("commit: the target becomes current and pending clears", async () => {
      gate.release();
      await expect(sessions).toHaveAttribute("aria-current", "page", {
        timeout: T,
      });
      expect(new URL(page.url()).searchParams.get("tab")).toBe("sessions");
      await expect(overview).not.toHaveAttribute("aria-current", "page");
      await expect(tabRow.locator("[aria-busy]")).toHaveCount(0);
      await expect(liveRegion).toHaveText("");
    });

    await test.step("a second, unheld tab change leaves nothing behind", async () => {
      await page.unrouteAll({ behavior: "wait" });
      const personal = tabRow.getByRole("button", { name: "Personal Notes" });
      await personal.click();
      await expect(personal).toHaveAttribute("aria-current", "page", {
        timeout: T,
      });
      await expect(tabRow.locator("[aria-busy]")).toHaveCount(0);
      await expect(liveRegion).toHaveText("");
    });
  });
});
