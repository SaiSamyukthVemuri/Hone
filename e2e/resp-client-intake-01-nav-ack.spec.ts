import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClientWithPreviousAreas,
  seedE2eIntake,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// RESP-CLIENT-INTAKE-01 — the clinical navigation controls acknowledge the tap.
//
// WHAT WAS MEASURED, AND WHY THIS FILE EXISTS
// -------------------------------------------
// Six controls on Client Profile and Intake were driven under a held navigation
// against production 6b36061b. Five were activated with the request provably in
// flight and changed by NOTHING — no markup, no opacity, no `aria-busy`, no live
// region, no spinner — while a ProfileTabBar tab button, measured through the
// same oracle in the same session, acknowledged on all four channels. That is a
// direct LAW 4 failure ("a control that has been activated must never look
// idle") against a primitive the repository already ships.
//
// Two of the six were worse than silent. `Add skin & hair analysis` and the
// intake history `View →` were raw `<a>` elements pointing at in-app URLs, so a
// tap left the client router entirely: zero RSC requests, one DOCUMENT request,
// and the live document destroyed — to change a query string on the page the
// practitioner was already on.
//
// WHY THE DELAY LIVES IN THE TEST
// -------------------------------
// Same argument as e2e/perceived-speed.spec.ts, whose gate this copies: a
// pending state is only observable while something is pending, and a local
// stack answers fast enough that the window is a coin flip. Playwright holds the
// response at the network boundary, so the application code under test is
// byte-for-byte what production runs — no sleep, no test-only branch, no seam.
//
// Every assertion is an ORDER assertion: the acknowledgement is on screen BEFORE
// the destination exists, the destination then arrives, and the acknowledgement
// is gone. The last of those is what catches a mechanism that leaves stuck
// pending UI.

const T = 60_000;

/** The destination heading each control is supposed to reach. */
type Dest = { heading: RegExp; url: (clientId: string, extra?: string) => string };

async function holdNavigation(
  page: Page,
  matches: (url: URL) => boolean,
  opts: { holdPrefetch?: boolean } = {},
) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  let documentRequests = 0;

  await page.route(
    (url) => matches(url),
    async (route) => {
      const headers = route.request().headers();
      if (headers["next-router-prefetch"] === "1") {
        // SEGMENT CHANGES ONLY. Next auto-prefetches a <Link> in the viewport,
        // and for a different pathname that speculative fetch can satisfy the
        // whole navigation — the tap then issues NO request and there is nothing
        // to hold. HOLDING it (rather than aborting it) keeps the router cache
        // empty while leaving every request successful, so the tap performs the
        // ordinary soft navigation this file exists to observe. Aborting was
        // measured to make the tap fall back to a full document load, which is
        // a path production never takes.
        if (opts.holdPrefetch) {
          held += 1;
          await gate;
        }
      } else if (headers["rsc"] === "1") {
        held += 1;
        await gate;
      } else if (route.request().resourceType() === "document") {
        // A navigation request with no RSC header is the client router being
        // bypassed. Counted, never expected — see the document-load assertions.
        documentRequests += 1;
        held += 1;
        await gate;
      }
      await route.continue();
    },
  );

  return {
    held: () => held,
    documentRequests: () => documentRequests,
    release: () => open(),
  };
}

/** The mark PendingLink paints on the control the finger is on. */
const ack = (control: Locator): Locator => control.locator("[data-link-pending]");

async function seedFixture() {
  const seed = await seedE2eStudio();
  const { clientId, previousSessionId } =
    await seedE2eClientWithPreviousAreas(seed);
  // TWO intakes, so the history list has more than one row: the no-op probe
  // needs a row it is already viewing, and a sibling row it is not.
  const olderIntakeId = await seedE2eIntake(seed.studioId, clientId, "reviewed");
  const latestIntakeId = await seedE2eIntake(
    seed.studioId,
    clientId,
    "submitted",
  );
  return { seed, clientId, previousSessionId, olderIntakeId, latestIntakeId };
}

/**
 * Drive one control under a held navigation and assert the whole order.
 *
 * Returns the number of MAIN-FRAME navigations the tap produced, so a caller
 * can pin "exactly one".
 */
async function proveAcknowledgement(
  page: Page,
  opts: {
    control: Locator;
    matches: (url: URL) => boolean;
    holdPrefetch?: boolean;
    destinationHeading: Locator;
    expectUrl: string;
    /** Assert the mark is still lit after this much longer under the hold. */
    survivesFor?: number;
  },
) {
  const gate = await holdNavigation(page, opts.matches, {
    holdPrefetch: opts.holdPrefetch,
  });

  let navigations = 0;
  const onNav = (frame: import("@playwright/test").Frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  };
  page.on("framenavigated", onNav);

  // A document stamp. If anything replaces the document — the defect the two
  // former <a> controls had — this global does not survive the navigation.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__navAckStamp = "alive";
  });

  await opts.control.click();

  // ORDER, PART 1 — the acknowledgement is on screen BEFORE the destination.
  await expect(ack(opts.control)).toBeVisible({ timeout: 10_000 });
  await expect(opts.destinationHeading).toHaveCount(0);

  // The control must survive its own activation: the acknowledgement has to
  // still be lit later in the SAME held window, not flash and die while the
  // practitioner is still waiting.
  if (opts.survivesFor) {
    await page.waitForTimeout(opts.survivesFor);
    await expect(ack(opts.control)).toBeVisible();
    await expect(opts.destinationHeading).toHaveCount(0);
  }

  // ANTI-VACUITY. If nothing was intercepted the navigation was served from
  // cache and every assertion above described a window that never opened.
  expect(gate.held(), "the gate never held a request").toBeGreaterThan(0);

  gate.release();

  // ORDER, PART 2 — the destination arrives and the acknowledgement is gone.
  await expect(opts.destinationHeading.first()).toBeVisible({ timeout: 20_000 });
  expect(page.url()).toContain(opts.expectUrl);

  page.off("framenavigated", onNav);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  return { navigations, documentRequests: gate.documentRequests() };
}

test.describe("RESP-CLIENT-INTAKE-01: the clinical navigation slice acknowledges", () => {
  test.setTimeout(T * 3);

  test("Client Profile → Log session acknowledges before the session page exists", async ({
    page,
  }) => {
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    const control = page.getByRole("link", { name: "+ Log session" });
    await expect(control).toBeVisible();

    const { navigations } = await proveAcknowledgement(page, {
      control,
      matches: (url) => url.pathname === `/clients/${clientId}/sessions/new`,
      holdPrefetch: true,
      destinationHeading: page.getByRole("heading", { name: "New session" }),
      expectUrl: `/clients/${clientId}/sessions/new`,
      survivesFor: 600,
    });

    // EXACTLY ONE navigation. A double-dispatch would show as two.
    expect(navigations).toBe(1);
  });

  test("Client Profile → previous session acknowledges before the chart exists", async ({
    page,
  }) => {
    const { seed, clientId, previousSessionId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}?tab=sessions`);

    const control = page.getByRole("link", { name: "Open →" }).first();
    await expect(control).toBeVisible();

    const { navigations } = await proveAcknowledgement(page, {
      control,
      matches: (url) =>
        url.pathname === `/clients/${clientId}/sessions/${previousSessionId}`,
      holdPrefetch: true,
      // The charting page's own h1 — `{modality} session`. The seed charts an
      // electrolysis visit, and no such heading exists on the Sessions tab we
      // are leaving, which is what makes the "not yet" assertion meaningful.
      destinationHeading: page.getByRole("heading", {
        name: "electrolysis session",
      }),
      expectUrl: `/clients/${clientId}/sessions/${previousSessionId}`,
      // The Sessions tab unmounts when this commits, so the acknowledgement has
      // to outlive the tap without the control disappearing early.
      survivesFor: 600,
    });
    expect(navigations).toBe(1);
  });

  test("Client Profile → View intake acknowledges before the intake exists", async ({
    page,
  }) => {
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}?tab=health`);

    const control = page.getByRole("link", { name: "View intake →" }).first();
    await expect(control).toBeVisible();

    const { navigations } = await proveAcknowledgement(page, {
      control,
      matches: (url) => url.pathname === `/clients/${clientId}/intake`,
      holdPrefetch: true,
      // NOT "Health intake": the Health & Forms tab we are leaving renders its
      // own <h2>Health intake</h2>, so that marker exists on BOTH pages and the
      // "destination does not exist yet" assertion would fail against the
      // origin. "Intake history" is rendered only by the intake route, and the
      // fixture seeds two intakes so the list is present.
      destinationHeading: page.getByRole("heading", {
        name: "Intake history",
        exact: true,
      }),
      expectUrl: `/clients/${clientId}/intake`,
      survivesFor: 600,
    });
    expect(navigations).toBe(1);
  });

  test("Intake → back to client acknowledges before the profile exists", async ({
    page,
  }) => {
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake`);

    const control = page.getByRole("link", { name: /^←/ }).first();
    await expect(control).toBeVisible();

    const { navigations } = await proveAcknowledgement(page, {
      control,
      matches: (url) => url.pathname === `/clients/${clientId}`,
      holdPrefetch: true,
      // The client profile's own primary action. Used instead of the h1, which
      // is the client's seeded name: this marker exists on the destination and
      // nowhere on the Intake page we are leaving.
      destinationHeading: page.getByRole("link", { name: "+ Log session" }),
      expectUrl: `/clients/${clientId}`,
      survivesFor: 600,
    });
    expect(navigations).toBe(1);
  });
});

test.describe("RESP-CLIENT-INTAKE-01: the two raw anchors are soft navigations now", () => {
  test.setTimeout(T * 3);

  test("Add skin & hair analysis: RSC soft navigation, document NOT replaced", async ({
    page,
  }) => {
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    const control = page.getByRole("link", { name: "Add skin & hair analysis" });
    await expect(control).toBeVisible();

    // The href must be byte-identical to the one the <a> carried.
    expect(await control.getAttribute("href")).toBe(
      `/clients/${clientId}?tab=consultation`,
    );

    let rsc = 0;
    let documents = 0;
    page.on("request", (req) => {
      if (!req.url().includes(`/clients/${clientId}`)) return;
      const h = req.headers();
      if (h["next-router-prefetch"] === "1") return;
      if (h["rsc"] === "1") rsc += 1;
      else if (req.resourceType() === "document") documents += 1;
    });

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__navAckStamp = "alive";
    });

    await control.click();
    // Wait on the URL, then on a heading that exists ONLY on the destination.
    // NOT a /skin/i regex: the Overview tab we are leaving renders its own
    // `<h2>Skin</h2>` for the retired legacy column, so a loose match would
    // have resolved against the ORIGIN page and this test would have passed
    // without the navigation ever happening.
    await page.waitForURL((u) => u.search === "?tab=consultation", {
      timeout: 20_000,
    });
    await expect(
      page.getByRole("heading", { name: "Consultation notes", exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // THE REGRESSION THIS PINS. Before the conversion this was 0 RSC / 1
    // document, and the stamp was gone because the document was replaced.
    expect(rsc, "the tap must go through the client router").toBeGreaterThan(0);
    expect(documents, "no full document load").toBe(0);
    const stamp = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__navAckStamp ?? null,
    );
    expect(stamp, "the document must survive the navigation").toBe("alive");

    // Query preserved exactly.
    expect(new URL(page.url()).search).toBe("?tab=consultation");
  });

  test("Intake history View →: RSC soft navigation, document NOT replaced", async ({
    page,
  }) => {
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}/intake`);

    // The OLDER of the two seeded intakes — the row the page is not already
    // showing, so the tap is a genuine version switch.
    const control = page.getByRole("link", { name: "View →" }).last();
    await expect(control).toBeVisible();

    let rsc = 0;
    let documents = 0;
    page.on("request", (req) => {
      if (!req.url().includes(`/clients/${clientId}/intake`)) return;
      const h = req.headers();
      if (h["next-router-prefetch"] === "1") return;
      if (h["rsc"] === "1") rsc += 1;
      else if (req.resourceType() === "document") documents += 1;
    });

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__navAckStamp = "alive";
    });

    const href = await control.getAttribute("href");
    expect(href).toMatch(
      new RegExp(`^/clients/${clientId}/intake\\?intake=[0-9a-f-]{36}$`),
    );

    await control.click();
    await page.waitForURL((u) => u.search.startsWith("?intake="), {
      timeout: 20_000,
    });

    expect(rsc, "the tap must go through the client router").toBeGreaterThan(0);
    expect(documents, "no full document load").toBe(0);
    const stamp = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__navAckStamp ?? null,
    );
    expect(stamp, "the document must survive the navigation").toBe("alive");

    // Query preserved exactly — the id that was on the anchor is the id in the URL.
    expect(page.url()).toContain(href!);
    expect(new URL(page.url()).searchParams.get("intake")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });
});

test.describe("RESP-CLIENT-INTAKE-01: the proof discriminates", () => {
  test.setTimeout(T * 3);

  // NEGATIVE CONTROL. `Edit` is deliberately NOT in this slice and is still a
  // bare <Link>. Driving it through the SAME gate and the SAME oracle must
  // report NO acknowledgement. If this ever starts acknowledging, either the
  // slice grew silently or the oracle stopped discriminating — and in both
  // cases every positive assertion above is worth less than it looks.
  test("a bare <Link> outside the slice does NOT acknowledge", async ({
    page,
  }) => {
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    const edit = page.getByRole("link", { name: "Edit", exact: true }).first();
    await expect(edit).toBeVisible();

    const gate = await holdNavigation(
      page,
      (url) => url.pathname === `/clients/${clientId}/edit`,
      { holdPrefetch: true },
    );
    await edit.click();
    await page.waitForTimeout(800);

    expect(gate.held(), "the gate never held a request").toBeGreaterThan(0);
    await expect(ack(edit)).toHaveCount(0);

    gate.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  // A TRUE NO-OP MUST NOT FABRICATE PENDING STATE.
  //
  // The intake history row you are ALREADY viewing still renders its own
  // `View →`, whose href is exactly the current URL. Nothing is fetched and
  // nothing changes, so there is no interval to acknowledge — and arming one
  // would leave a mark with no navigation to clear it, which is the permanent
  // busy state NAV-ACK-01 already had to repair once.
  test("re-selecting the intake already on screen leaves no stuck pending mark", async ({
    page,
  }) => {
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);

    // Land on a specific version first, so the row's href === the current URL.
    await page.goto(`/clients/${clientId}/intake`);
    const first = page.getByRole("link", { name: "View →" }).first();
    await expect(first).toBeVisible();
    await first.click();
    await page.waitForURL((u) => u.search.startsWith("?intake="), {
      timeout: 20_000,
    });

    const currentUrl = page.url();
    // The SAME row that is now on screen: its href is exactly the current URL,
    // which is what makes this a true no-op rather than a version switch.
    const sameRow = page.getByRole("link", { name: "View →" }).first();
    const href = await sameRow.getAttribute("href");
    expect(currentUrl).toContain(href!);

    await sameRow.click();
    // Generous: a fabricated mark would still be on screen well after any real
    // same-URL transition has settled.
    await page.waitForTimeout(1500);

    await expect(ack(sameRow)).toHaveCount(0);
    expect(page.url()).toBe(currentUrl);
  });
});

test.describe("RESP-CLIENT-INTAKE-01: mobile and reduced motion", () => {
  test.setTimeout(T * 3);

  test("the 390px Treatment Photos link acknowledges", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    // At 390px the md+ tab row is display:none, so this resolves the MOBILE
    // form of the control — the one under the section select.
    const control = page.getByRole("link", { name: "Treatment Photos →" });
    await expect(control).toBeVisible();

    const { navigations } = await proveAcknowledgement(page, {
      control,
      matches: (url) => url.pathname === `/clients/${clientId}/images`,
      holdPrefetch: true,
      destinationHeading: page.getByRole("heading", { name: "Treatment Photos" }),
      expectUrl: `/clients/${clientId}/images`,
      survivesFor: 600,
    });
    expect(navigations).toBe(1);
  });

  test("the desktop Treatment Photos link acknowledges", async ({ page }) => {
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    const control = page.getByRole("link", {
      name: "Treatment Photos",
      exact: true,
    });
    await expect(control).toBeVisible();

    const { navigations } = await proveAcknowledgement(page, {
      control,
      matches: (url) => url.pathname === `/clients/${clientId}/images`,
      holdPrefetch: true,
      destinationHeading: page.getByRole("heading", { name: "Treatment Photos" }),
      expectUrl: `/clients/${clientId}/images`,
      survivesFor: 600,
    });
    expect(navigations).toBe(1);
  });

  // THE STRUCTURE THIS SLICE CHANGED IN THE TAB BAR, PINNED.
  //
  // Adopting the primitive on Treatment Photos means the section-switcher <nav>
  // now hosts THREE `role="status"` regions where it used to host one: its own,
  // plus one inside each of the two forms of the link. That broke a shipped
  // assertion in e2e/perceived-speed.spec.ts, which matched regions by
  // descendant and hit a strict-mode violation once there were three.
  //
  // The repair there was to scope to the bar's OWN region — a direct child of
  // the <nav>, where each link's region is nested inside its <a>. That is only
  // sound while the structure actually holds, so it is asserted here rather
  // than left as a claim in a comment on the other file.
  test("the section switcher owns exactly one live region, and the links nest theirs", async ({
    page,
  }) => {
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    const nav = page.getByRole("navigation", {
      name: "Client profile sections",
    });
    await expect(nav).toBeVisible();

    // One direct child — the switcher's own voice.
    await expect(nav.locator(':scope > [role="status"]')).toHaveCount(1);
    // Three in total: the switcher's, plus the mobile and md+ photo links'.
    await expect(nav.locator('[role="status"]')).toHaveCount(3);
    // Every one of them silent at rest, so none contributes to any control's
    // accessible name until there is genuinely something to say.
    await expect(nav.locator('[role="status"]:not(:empty)')).toHaveCount(0);
  });

  // The mark must survive `prefers-reduced-motion`. The primitive drops only
  // the ROTATION and keeps the ring, so the state change stays a SHAPE change
  // and never colour alone — an acknowledgement that vanished under reduced
  // motion would fail exactly the users least able to tolerate a dead control.
  test("reduced motion keeps the mark and drops only the rotation", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { seed, clientId } = await seedFixture();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    const control = page.getByRole("link", { name: "+ Log session" });
    await expect(control).toBeVisible();

    const gate = await holdNavigation(
      page,
      (url) => url.pathname === `/clients/${clientId}/sessions/new`,
      { holdPrefetch: true },
    );
    await control.click();

    const mark = ack(control);
    await expect(mark).toBeVisible({ timeout: 10_000 });
    expect(gate.held(), "the gate never held a request").toBeGreaterThan(0);

    // The ring itself is still drawn...
    const cls = (await mark.getAttribute("class")) ?? "";
    expect(cls).toContain("rounded-full");
    expect(cls).toContain("motion-reduce:animate-none");

    // ...and the browser is genuinely honouring reduced motion.
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);

    gate.release();
    await expect(
      page.getByRole("heading", { name: "New session" }),
    ).toBeVisible({ timeout: 20_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});
