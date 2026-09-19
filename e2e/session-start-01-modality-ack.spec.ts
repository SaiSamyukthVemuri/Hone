import { test, expect, type Page } from "@playwright/test";

import { seedE2eStudio, seedE2eClient, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// SESSION-START-01 — the modality press, proved in a real browser.
//
// The source proof shows the picker routes through one form and useFormStatus.
// What it CANNOT show is the part the practitioner actually experiences:
//   * that the client island hydrates at all on a server-rendered clinical page;
//   * that the pressed card paints a pending state;
//   * that the sibling modality really becomes unpressable;
//   * that NEITHER card changes size while it happens.
//
// The last one is why this file exists. Geometry stability is a rendered
// property: a source test can assert the reserved slot's class and still miss a
// card that grows because of what went into it.

const T = 20_000;

/**
 * Holds the server action open so the pending state is GUARANTEED observable.
 *
 * This is the technique UI-04 established, and it is load-bearing here for a
 * second reason: SESSION-START-01's whole premise is that the real action is
 * slow, and SLICE 2 EXISTS TO MAKE IT FAST. A test that sampled the pending
 * state by racing a genuinely slow backend would pass today and fail the moment
 * the latency work lands — a test that depends on the defect it accompanies.
 *
 * Delaying the request ourselves removes the race instead of inheriting it, so
 * this proof keeps its meaning after the waterfall is cut.
 */
async function withSlowAction(
  page: Page,
  delayMs: number,
  body: () => Promise<void>,
): Promise<void> {
  const match = (url: URL) => url.pathname.startsWith("/clients");
  await page.route(match, async (route, request) => {
    if (request.method() === "POST") {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    await route.continue();
  });
  try {
    await body();
  } finally {
    await page.unroute(match);
  }
}

async function box(page: Page, modality: string) {
  const b = await page.locator(`[data-modality="${modality}"]`).boundingBox();
  if (!b) throw new Error(`no box for ${modality}`);
  return { w: Math.round(b.width), h: Math.round(b.height) };
}

async function openPicker(page: Page): Promise<{ seed: E2eSeed; clientId: string }> {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/sessions/new`);
  // WAIT FOR REAL HYDRATION, NOT FOR `toBeEnabled()`.
  //
  // The server-rendered submit button is enabled BEFORE this island hydrates,
  // so `toBeEnabled()` is not the precondition it looks like. A click landing
  // in that window submits the form NATIVELY: the session still starts and
  // nothing acknowledges, because no React is attached. Every case in this
  // file would then report an application regression for a harness race.
  //
  // `data-hydrated` is set by useSyncExternalStore's client snapshot, so it
  // appears only once the island is live. This is the precondition.
  await expect(page.locator("form[data-hydrated='true']")).toBeAttached({
    timeout: T,
  });
  return { seed, clientId };
}

test.describe("SESSION-START-01 — pressing a modality is acknowledged", () => {
  test("the hydration precondition is real: the SERVER does not send it", async ({
    page,
  }) => {
    // The precondition every other case in this file now depends on is
    // `data-hydrated`. If the server rendered it, waiting for it would pass
    // instantly and prove nothing — the races it exists to remove would come
    // straight back, invisibly, with the suite still green.
    //
    // So fetch the SAME url as raw HTML, through the authenticated context,
    // with no JavaScript involved. The attribute must be ABSENT there and
    // PRESENT in the live DOM. That pair is what makes the wait meaningful.
    const { clientId } = await openPicker(page);
    const html = await (
      await page.request.get(`/clients/${clientId}/sessions/new`)
    ).text();
    expect(
      html.includes("<form"),
      "sanity: the fetched document must actually be the picker page",
    ).toBe(true);
    expect(
      html.includes("data-hydrated"),
      "the server sent data-hydrated — the hydration wait is vacuous",
    ).toBe(false);
    await expect(page.locator("form[data-hydrated='true']")).toBeAttached();
  });

  test("idle: neither card claims to be working", async ({ page }) => {
    await openPicker(page);

    const electro = page.locator('[data-modality="electrolysis"]');
    const laser = page.locator('[data-modality="laser"]');

    await expect(electro).toBeVisible({ timeout: T });
    await expect(electro).toBeEnabled();
    await expect(laser).toBeEnabled();
    // The absence assertions matter: a card that shipped aria-busy="true"
    // permanently would satisfy every "pending is announced" check below.
    await expect(electro).not.toHaveAttribute("aria-busy", "true");
    await expect(laser).not.toHaveAttribute("aria-busy", "true");
  });

  test("pressed: the chosen card announces, the sibling locks, and nothing moves", async ({
    page,
  }) => {
    await openPicker(page);

    const electro = page.locator('[data-modality="electrolysis"]');
    const laser = page.locator('[data-modality="laser"]');
    await expect(electro).toBeVisible({ timeout: T });

    const electroBefore = await box(page, "electrolysis");
    const laserBefore = await box(page, "laser");

    await withSlowAction(page, 3_000, async () => {
      await electro.click();

      // THE ACKNOWLEDGEMENT. Before this slice nothing on the page could
      // change at all, so this is the assertion the whole change exists for.
      await expect(electro).toHaveAttribute("aria-busy", "true", { timeout: T });

      // NO DOUBLE SUBMIT — the pressed card cannot be pressed again.
      await expect(electro).toBeDisabled();

      // THE SIBLING. Not a nicety: without it a practitioner who saw nothing
      // happen can start the OTHER modality, and two start_session calls race.
      await expect(laser).toBeDisabled();
      // ...but the sibling must not claim to be working. A screen-reader user
      // should not hear that Laser is starting when they chose Electrolysis.
      await expect(laser).not.toHaveAttribute("aria-busy", "true");

      // GEOMETRY. A card that grows on press moves its sibling under the
      // thumb mid-action, on a surface used mid-treatment.
      const electroDuring = await box(page, "electrolysis");
      const laserDuring = await box(page, "laser");
      expect(electroDuring.h).toBe(electroBefore.h);
      expect(electroDuring.w).toBe(electroBefore.w);
      expect(laserDuring.h).toBe(laserBefore.h);
      expect(laserDuring.w).toBe(laserBefore.w);
    });

    // And it still does the thing: the press starts a session and lands on the
    // chart. An acknowledgement that broke the navigation would be worse than
    // no acknowledgement.
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/i, { timeout: T });
  });

  test("at 390px, where the cards stack, neither card changes size", async ({ page }) => {
    // THE CASE THE FIRST VERSION OF THIS FILE MISSED.
    //
    // The desktop test above passes against an implementation that swaps the
    // description for "Starting session…", because at two columns the
    // description happens to fit on one line either way. At 390px the grid
    // collapses to ONE column, the description wraps, and the pending text does
    // not — so the chosen card shortens and the sibling slides up under the
    // thumb, mid-treatment, on the narrowest surface.
    //
    // Codex raised exactly that as a P2 against the first implementation. This
    // case is why the description is now held in flow at opacity-0 rather than
    // replaced.
    await page.setViewportSize({ width: 390, height: 844 });
    await openPicker(page);

    const electro = page.locator('[data-modality="electrolysis"]');
    const laser = page.locator('[data-modality="laser"]');
    await expect(electro).toBeVisible({ timeout: T });

    const topOf = (m: string) =>
      page
        .locator(`[data-modality="${m}"]`)
        .evaluate((el) => Math.round(el.getBoundingClientRect().top));

    const electroBefore = await box(page, "electrolysis");
    const laserBefore = await box(page, "laser");
    const laserTopBefore = await topOf("laser");

    await withSlowAction(page, 3_000, async () => {
      await electro.click();
      await expect(electro).toHaveAttribute("aria-busy", "true", { timeout: T });

      const electroDuring = await box(page, "electrolysis");
      const laserDuring = await box(page, "laser");
      expect(electroDuring.h).toBe(electroBefore.h);
      expect(electroDuring.w).toBe(electroBefore.w);
      expect(laserDuring.h).toBe(laserBefore.h);

      // THE ASSERTION THIS CASE EXISTS FOR. In one column the failure mode is
      // not the card resizing in place — it is the card ABOVE shrinking and
      // pulling this one upward under the practitioner's thumb. Comparing the
      // sibling's top edge before and during is what measures that; asserting
      // only that a number came back would prove nothing at all.
      expect(await topOf("laser")).toBe(laserTopBefore);
    });

    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/i, { timeout: T });
  });

  // IMMEDIACY + TRUTHFULNESS, at both surfaces.
  //
  // The tests above prove the acknowledgement EXISTS. They cannot prove LAW 4,
  // whose claim is narrower and stronger: "a press is confirmed BEFORE ITS
  // RESULT ARRIVES". Every assertion above carries `timeout: T` (20s), so an
  // implementation that acknowledged three seconds after the press would
  // satisfy all of them while failing the law outright.
  //
  // MEASURED IN THE PAGE, NOT ACROSS THE WIRE. A Playwright-side stopwatch
  // measures the driver round trip as much as the application. A capture-phase
  // listener plus a MutationObserver timestamp the click dispatch and the
  // aria-busy commit against the SAME clock, inside the browser, so the number
  // is the application's own.
  //
  // The bound is deliberately of two kinds. RELATIONAL is the real proof and
  // owes nothing to hardware: the action is held open for a known interval, so
  // an acknowledgement inside a small fraction of it is confirmed before the
  // result by construction. The ABSOLUTE ceiling is the flake-resistant
  // sanity limit on top, not the definition of "immediate".
  for (const surface of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile 390px", width: 390, height: 844 },
  ] as const) {
    test(`${surface.name}: the press is confirmed before its result arrives`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: surface.width, height: surface.height });
      await openPicker(page);

      const electro = page.locator('[data-modality="electrolysis"]');
      await expect(electro).toBeVisible({ timeout: T });
      // Hydration is already established by openPicker via `data-hydrated`.
      // An earlier revision used `toBeEnabled()` here and described it as the
      // hydration precondition; it is not one, and Codex was right to say so.
      await expect(electro).toBeEnabled();

      await page.evaluate(() => {
        const el = document.querySelector('[data-modality="electrolysis"]');
        if (!el) throw new Error("no electrolysis card");
        const w = window as unknown as {
          __ack: { pressedAt: number | null; busyAt: number | null };
        };
        w.__ack = { pressedAt: null, busyAt: null };
        el.addEventListener(
          "click",
          () => {
            w.__ack.pressedAt = performance.now();
          },
          { capture: true, once: true },
        );
        const mo = new MutationObserver(() => {
          if (el.getAttribute("aria-busy") === "true" && w.__ack.busyAt === null) {
            w.__ack.busyAt = performance.now();
            mo.disconnect();
          }
        });
        mo.observe(el, { attributes: true, attributeFilter: ["aria-busy"] });
      });

      const HELD_MS = 3_000;
      await withSlowAction(page, HELD_MS, async () => {
        await electro.click();

        // TRUTHFUL, AND BOTH HALVES MATTER. Resolving the control BY ITS
        // ACCESSIBLE NAME and only then reading aria-busy proves in one
        // assertion that the card still says what it is while it says it is
        // busy. The earlier revision hid the description outright, which
        // collapsed the accessible name to empty for exactly the duration the
        // control was busy — announcing "busy" about a control that no longer
        // named itself. A bare attribute check cannot see that.
        await expect(
          page.getByRole("button", { name: /Electrolysis/i }),
        ).toHaveAttribute("aria-busy", "true", { timeout: T });

        const ack = await page.evaluate(() => {
          const w = window as unknown as {
            __ack: { pressedAt: number | null; busyAt: number | null };
          };
          return w.__ack;
        });
        expect(ack.pressedAt, "the press was never observed").not.toBeNull();
        expect(ack.busyAt, "aria-busy never committed").not.toBeNull();
        const elapsed = (ack.busyAt as number) - (ack.pressedAt as number);
        console.log(`[SESSION-START-01] ${surface.name} press -> aria-busy: ${elapsed.toFixed(1)}ms`);

        // THE GATE DETECTS A DEFECT CLASS. IT IS NOT A PERFORMANCE BUDGET.
        //
        // This asserted 250ms. On a shared runner `performance.now()` also
        // spans GC pauses and descheduling, so an otherwise instant React
        // commit can cross a fixed 250ms ceiling — and CI would then report a
        // RESOURCE result as an application regression. That failure mode is
        // recorded three separate times in CLAUDE.md, each time as a budget
        // problem read as a broken diff. Codex raised it here before it could
        // happen a fourth time.
        //
        // What the ceiling now catches is the regression that actually
        // matters: an acknowledgement that waits for the action instead of
        // preceding it. That shape lands at or beyond HELD_MS, so 1000ms
        // separates it by 3x while sitting two orders of magnitude above any
        // plausible GC pause.
        //
        // "Immediate" is established by MEASUREMENT, logged above and recorded
        // in the PR — 6.2ms desktop and 12.5ms at 390px, taken on a host under
        // load average 14 with two competing builds. The claim rests on those
        // numbers, not on this inequality.
        expect(
          elapsed,
          `press -> aria-busy took ${elapsed.toFixed(1)}ms — an acknowledgement that waits for its own result is the regression this catches`,
        ).toBeLessThan(1_000);

        // The VISUAL cue is present and is a cue only: aria-busy is the one
        // voice, so the overlay must not become a second one.
        const overlay = electro.locator('span[aria-hidden="true"]', {
          hasText: "Starting session",
        });
        await expect(overlay).toBeVisible();
      });

      await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/i, { timeout: T });
    });
  }

  test("the card is keyboard-reachable and shows its focus", async ({ page }) => {
    await openPicker(page);
    const electro = page.locator('[data-modality="electrolysis"]');
    await expect(electro).toBeVisible({ timeout: T });

    await electro.focus();
    const ring = await electro.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, shadow: cs.boxShadow };
    });
    expect(
      ring.shadow !== "none" || parseFloat(ring.width || "0") > 0,
      "the modality card must paint a visible focus ring",
    ).toBe(true);
  });
});
