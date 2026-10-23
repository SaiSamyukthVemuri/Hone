import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio } from "./helpers/seed";
import {
  errorEvents,
  eventTexts,
  markSentryEgress,
  readSentryEgress,
  waitForSentryEgress,
  type EgressMark,
  type EgressRecord,
} from "./helpers/sentry-egress";

// SENTRY-BOOKING-ERR-01. The public booking page's own error boundary
// (app/book/[slug]/error.tsx), proved in a real browser against the real
// production build and the real local stack.
//
// Two failures a visitor can actually meet, each injected at the NETWORK
// boundary so the application code under test is byte-for-byte what production
// runs:
//
//   1. a Server Action request that never completes (the connection drops);
//   2. a Server Action id the server does not recognise, which is what a tab
//      opened before a deploy sends after it. The server answers 404 with
//      x-nextjs-action-not-found and the browser raises UnrecognizedActionError.
//
// The booking form awaits its actions inside transitions, and React 19 rethrows
// a rejected transition into the nearest boundary. Before this boundary existed
// that was app/global-error.tsx, which replaces the whole document. The
// server-RENDER flavour of the same family, a studio read that does not
// complete, is proved at the page level in
// tests/app/book/public-booking-read-failure.test.ts.
//
// SENTRY. What these cases report is read back from the lane's egress guard
// (e2e/helpers/sentry-egress.ts): it travels the real path, browser SDK ->
// same-origin /monitoring tunnel -> this server, and the guard holds it there,
// so nothing reaches the operational project.

// React's fixed stand-in for a server error message in a production build. It
// would only appear here if a server-raised error were reported a second time.
const REACT_ELISION = "The specific message is omitted in production builds";

// The id-less message Next throws for a multipart POST that carries NO
// Next-Action header (SENTRY-BOOKING-ERR-01 group A). A stale tab never sends
// that shape, so it must never raise this server-side.
const MPA_ACTION_NOT_FOUND =
  "Failed to find Server Action. This request might be from an older or newer deployment.";

function boundary(page: Page) {
  return page.getByTestId("public-booking-error-boundary");
}

/** Browser-raised events of one exception type. */
function browserEventsOfType(records: EgressRecord[], type: string) {
  return errorEvents(records).filter(
    (e) =>
      e.item.platform === "javascript" &&
      (e.item.exceptions ?? []).some((x) => x.type === type),
  );
}

/** Server-raised events whose message contains `text`. */
function serverEventsCarrying(records: EgressRecord[], text: string) {
  return errorEvents(records).filter(
    (e) => e.item.platform === "node" && eventTexts(e.item).some((t) => t.includes(text)),
  );
}

/**
 * The boundary reports from the browser exactly once. Waits for the event,
 * then gives a late duplicate time to arrive before counting.
 */
async function expectReportedOnceFromBrowser(page: Page, since: EgressMark, type: string) {
  await waitForSentryEgress((records) => browserEventsOfType(records, type)[0], { since });
  await page.waitForTimeout(2_000);
  const records = readSentryEgress(since);
  expect(browserEventsOfType(records, type), `${type} reported from the browser`).toHaveLength(1);
  expect(
    errorEvents(records).filter((e) => eventTexts(e.item).some((t) => t.includes(REACT_ELISION))),
    "a server error was reported a second time from the browser",
  ).toEqual([]);
}

/**
 * Break the FIRST Server Action request the page makes, and only that one, so
 * Try again has a working server to come back to.
 */
async function breakFirstServerAction(
  page: Page,
  how: "drop-connection" | "unrecognised-id",
): Promise<() => { broken: number; status: number | null; notFoundHeader: string | null }> {
  let broken = 0;
  let status: number | null = null;
  let notFoundHeader: string | null = null;
  await page.route("**/book/**", async (route) => {
    const request = route.request();
    const actionId = request.headers()["next-action"];
    if (request.method() !== "POST" || !actionId || broken > 0) {
      return route.continue();
    }
    broken += 1;
    if (how === "drop-connection") return route.abort("connectionreset");
    // A well-formed id (same length and leading type byte) that this build
    // does not have: exactly what a stale tab sends after a deploy.
    const staleId = actionId.slice(0, 2) + "f".repeat(actionId.length - 2);
    const response = await route.fetch({
      headers: { ...request.headers(), "next-action": staleId },
    });
    status = response.status();
    notFoundHeader = response.headers()["x-nextjs-action-not-found"] ?? null;
    return route.fulfill({ response });
  });
  return () => ({ broken, status, notFoundHeader });
}

/** Choosing a client type is what starts the first slot fetch. */
async function chooseNewClient(page: Page) {
  // `/new client/i`: the control reads "I’m a new client" with a typographic
  // apostrophe, which a straight `'` in the pattern would never match.
  await page.getByRole("button", { name: /new client/i }).first().click();
}

async function expectContainedInBookingBoundary(page: Page) {
  await expect(boundary(page)).toBeVisible({ timeout: 20_000 });
  await expect(
    boundary(page).getByRole("heading", { name: "Booking is unavailable right now", level: 1 }),
  ).toBeVisible();
  await expect(boundary(page).getByRole("button", { name: "Try again" })).toBeVisible();
  // NOT the last-resort document: global-error's own recovery control.
  await expect(page.getByRole("button", { name: "Reload the page" })).toHaveCount(0);

  const contained = await boundary(page).innerText();
  expect(contained).not.toContain(REACT_ELISION);
  expect(contained).not.toMatch(/\bat\s+\w+\s+\(/);
  expect(contained).not.toContain("undefined");
  // A browser-raised failure has no server digest, so no reference line.
  expect(contained).not.toContain("Reference");
}

async function expectTryAgainRecovers(page: Page, studioName: string) {
  await boundary(page).getByRole("button", { name: "Try again" }).click();
  await expect(boundary(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: studioName, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /new client/i }).first()).toBeVisible();
}

test.describe("public booking error containment", () => {
  test("a Server Action whose connection drops is contained, reported once, and recovers", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const injected = await breakFirstServerAction(page, "drop-connection");

    await page.goto(`/book/${seed.slug}`);
    await expect(page.getByRole("heading", { name: seed.studioName, level: 1 })).toBeVisible();
    const since = markSentryEgress();
    await chooseNewClient(page);

    await expectContainedInBookingBoundary(page);
    expect(injected().broken, "the injected failure never fired").toBe(1);
    // Reported from the browser exactly because onRequestError never saw it.
    await expectReportedOnceFromBrowser(page, since, "TypeError");

    await expectTryAgainRecovers(page, seed.studioName);
  });

  test("a stale Server Action id after a deploy lands in the same boundary, raises nothing server-side, and recovers", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const injected = await breakFirstServerAction(page, "unrecognised-id");

    await page.goto(`/book/${seed.slug}`);
    await expect(page.getByRole("heading", { name: seed.studioName, level: 1 })).toBeVisible();
    const since = markSentryEgress();
    await chooseNewClient(page);

    await expectContainedInBookingBoundary(page);
    // The server's half of deployment skew: a 404 the client router recognises,
    // NOT a thrown "Failed to find Server Action" 500.
    expect(injected()).toEqual({ broken: 1, status: 404, notFoundHeader: "1" });
    await expectReportedOnceFromBrowser(page, since, "UnrecognizedActionError");
    expect(
      serverEventsCarrying(readSentryEgress(since), "Failed to find Server Action"),
      "a stale tab raised a server-side Sentry event",
    ).toEqual([]);

    // CONTROL for the absence above: the guard does record the id-less server
    // event, and a raw multipart POST with no Next-Action header is what makes
    // it. That is the shape SENTRY-BOOKING-ERR-01 group A turned out to be.
    const control = markSentryEgress();
    const raw = await page.request.post(`/book/${seed.slug}`, { multipart: { probe: "a" } });
    expect(raw.status()).toBe(500);
    await waitForSentryEgress(
      (records) => serverEventsCarrying(records, MPA_ACTION_NOT_FOUND)[0],
      { since: control },
    );

    await expectTryAgainRecovers(page, seed.studioName);
  });
});
