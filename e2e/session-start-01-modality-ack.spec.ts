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
  return { seed, clientId };
}

test.describe("SESSION-START-01 — pressing a modality is acknowledged", () => {
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
