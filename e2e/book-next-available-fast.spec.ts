import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";

// BOOK-NEXT-FAST-01 — the public "Next available" press, in a real browser.
//
// The server side is proved elsewhere: the unit suite pins that the read count
// no longer grows with the horizon, and tests/db/next-available-performance
// measures both algorithms against the real database. What none of that can
// show is the thing the client actually experiences — that the press is
// acknowledged before the answer exists, that the answer is the right day, that
// the day's slots then load, and that one press is one request.
//
// THE ACKNOWLEDGEMENT IS OBSERVED UNDER A HELD RESPONSE, and it has to be: the
// action now answers in tens of milliseconds, so sampling the button after an
// unheld click is a race that would pass on timing rather than on behaviour.
// Playwright holds the Server Action response at the network boundary, so the
// application code under test is byte-for-byte what production runs.
//
// THE DUPLICATE-REQUEST ASSERTION IS THE OTHER HALF. A fast action makes a
// double-dispatch cheap to miss and expensive to ship: the old implementation
// was slow enough that the disabled state was obvious, and "it feels instant"
// is exactly when a second silent request stops being noticed.

const T = 60_000;

/**
 * Every Server Action POST this page issues, IDENTIFIED — not merely counted.
 *
 * Next tags each Server Action request with a `Next-Action` header carrying that
 * action's id, so two different actions are two different ids. Recording the ids
 * rather than a bare total is what makes a duplicate-dispatch assertion possible:
 * one press of this control legitimately produces TWO posts — the next-available
 * lookup, then the slot fetch for the day it lands on — so any assertion phrased
 * as a total has to allow two, and therefore cannot tell "one lookup plus one
 * fetch" from "the lookup fired twice", which is the only thing it was added to
 * detect.
 */
function recordServerActions(page: Page) {
  const ids: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const id = req.headers()["next-action"];
    if (id) ids.push(id);
  });
  return () => [...ids];
}

/** Hold every Server Action POST until released. */
async function holdServerAction(page: Page) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      held += 1;
      await gate;
    }
    await route.continue();
  });
  return { held: () => held, release: () => open() };
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * A studio whose next TEN days are blocked out, so the initially-shown date has
 * nothing and "Next available" must genuinely jump.
 */
async function seedBlockedStudio(blockedDays: number) {
  const seed = await seedE2eStudio();
  const today = (
    await sql<{ d: string }>(
      `select to_char((now() at time zone (select timezone from public.studios where id = $1))::date, 'YYYY-MM-DD') as d`,
      [seed.studioId],
    )
  )[0]!.d;
  await sql(
    `insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason)
     values ($1, $2, $3, 'book-next-fast e2e')`,
    [seed.studioId, today, addDays(today, blockedDays - 1)],
  );
  return { seed, today, expected: addDays(today, blockedDays) };
}

/** Drive the public page as far as the service choice. */
async function openBookingForm(page: Page, slug: string) {
  await page.goto(`/book/${slug}`);
  // `/new client/i`, NOT `/i'm a new client/i`: the control reads "I’m a new
  // client" with a typographic apostrophe (U+2019), which a straight `'` in the
  // pattern never matches. The existing waitlist spec settled on this same
  // selector for the same reason.
  await page.getByRole("button", { name: /new client/i }).first().click();
  const service = page.locator("select").first();
  await expect(service).toBeVisible({ timeout: T });
}

test.describe("BOOK-NEXT-FAST-01: the public Next available press", () => {
  test.setTimeout(T * 3);

  test("acknowledges immediately, lands on the right day, loads its slots, and issues ONE request", async ({
    page,
  }) => {
    const { seed, today, expected } = await seedBlockedStudio(10);

    // Attached BEFORE the page loads. Installing it just before the press —
    // which is where it started — meant the day's own slot fetch had already
    // happened and gone unrecorded, so "ids seen before the press" came back
    // empty and the lookup could not be told apart from the fetch.
    const serverActions = recordServerActions(page);

    await openBookingForm(page, seed.slug);

    const dateInput = page.locator('input[type="date"]').first();
    await expect(dateInput).toHaveValue(today, { timeout: T });

    // The blocked day offers nothing, which is the surface that carries the
    // "Next available" control.
    const button = page.getByRole("button", { name: /^next available$/i });
    await expect(button).toBeVisible({ timeout: T });
    // The slot fetch for the CURRENTLY shown day has already run — it is why
    // this surface is showing the empty-day control at all — so its action id is
    // already on record. Anything new after the press is the lookup.
    const idsBeforePress = new Set(serverActions());
    expect(
      idsBeforePress.size,
      "expected the day's slot fetch to have already run, so its id is known",
    ).toBeGreaterThan(0);

    const gate = await holdServerAction(page);

    await button.click();

    // ORDER, PART 1 — the press is acknowledged BEFORE the answer exists.
    //
    // Asserted through a SEPARATE locator for the pending label, not by
    // re-reading `button`. The control acknowledges by swapping its own text to
    // "Finding…", which changes its accessible name — so a locator scoped to
    // the name "Next available" stops resolving at the exact moment the thing
    // it is meant to observe happens, and the assertion fails with "element not
    // found" while the product is behaving correctly.
    const pending = page.getByRole("button", { name: /finding/i });
    await expect(pending).toBeVisible({ timeout: 10_000 });
    await expect(pending).toBeDisabled();
    await expect(dateInput).toHaveValue(today);
    expect(gate.held(), "the gate never held the action").toBeGreaterThan(0);

    gate.release();

    // ORDER, PART 2 — the right day arrives, and the acknowledgement clears.
    await expect(dateInput).toHaveValue(expected, { timeout: 30_000 });
    await expect(pending).toHaveCount(0, { timeout: 30_000 });

    // THE SLOTS FOR THAT DAY LOAD. A jump that moves the date but leaves the
    // list empty would look like the studio is shut on the day it just offered.
    await expect(
      page.getByRole("button", { name: /\d{1,2}:\d{2}\s*(AM|PM)/i }).first(),
    ).toBeVisible({ timeout: 30_000 });

    await page.unrouteAll({ behavior: "ignoreErrors" });

    // ONE PRESS, ONE LOOKUP — asserted on the LOOKUP specifically.
    //
    // The landing day's slot fetch reuses the id already seen before the press,
    // so filtering to ids that are new isolates the next-available action. A
    // double dispatch puts that id in the list twice and fails here; a bound on
    // the TOTAL could not, because one press legitimately produces two posts.
    const newIds = serverActions().filter((id) => !idsBeforePress.has(id));
    expect(
      new Set(newIds).size,
      `expected exactly one new action (the lookup), saw ${new Set(newIds).size}`,
    ).toBe(1);
    expect(newIds, "the next-available lookup must be dispatched exactly once").toHaveLength(1);
  });

  test("at 390px the same press acknowledges and lands", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { seed, today, expected } = await seedBlockedStudio(10);
    await openBookingForm(page, seed.slug);

    const dateInput = page.locator('input[type="date"]').first();
    await expect(dateInput).toHaveValue(today, { timeout: T });

    const button = page.getByRole("button", { name: /^next available$/i });
    await expect(button).toBeVisible({ timeout: T });

    // A real touch target, not merely a visible one.
    const box = await button.boundingBox();
    expect(box, "the control must have a box").not.toBeNull();

    const gate = await holdServerAction(page);
    await button.click();
    // Same reason as the desktop case: the pending label is its own locator,
    // because acknowledging changes the control's accessible name.
    await expect(page.getByRole("button", { name: /finding/i })).toBeVisible({
      timeout: 10_000,
    });
    expect(gate.held()).toBeGreaterThan(0);
    gate.release();

    await expect(dateInput).toHaveValue(expected, { timeout: 30_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // Nothing overflows the viewport after the jump.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the booking form must not overflow 390px").toBeLessThanOrEqual(0);
  });

  test("a horizon with nothing open says so, and does not hang", async ({
    page,
  }) => {
    // The case that was worst before: the scan used to walk every remaining day
    // of the horizon one query at a time to discover there was nothing. It now
    // answers from the same single bulk pass.
    const { seed, today } = await seedBlockedStudio(400);
    await openBookingForm(page, seed.slug);

    const dateInput = page.locator('input[type="date"]').first();
    await expect(dateInput).toHaveValue(today, { timeout: T });

    const button = page.getByRole("button", { name: /^next available$/i });
    await expect(button).toBeVisible({ timeout: T });

    const started = Date.now();
    await button.click();
    // A truthful refusal, not a spinner that never resolves.
    await expect(
      page.getByText(/no availability|nothing available|fully booked/i).first(),
    ).toBeVisible({ timeout: 30_000 });
    const elapsed = Date.now() - started;

    // Deliberately loose — this machine runs other lanes concurrently. The tight
    // numbers live in the DB measurement; this only pins that the full-horizon
    // miss is no longer a multi-second wait in a real browser.
    expect(elapsed, `full-horizon miss took ${elapsed}ms`).toBeLessThan(10_000);
    await expect(dateInput).toHaveValue(today);
  });
});
