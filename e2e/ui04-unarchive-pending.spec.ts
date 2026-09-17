import { test, expect, type Page } from "@playwright/test";

import { seedE2eStudio, seedE2eClient, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// UI-04 — the two unarchive controls, proved in a real browser.
//
// The source proof shows each routes through PendingButton. What it cannot show
// is what a practitioner gets: a control on the touch floor, a focus ring, and
// an in-flight state that actually paints. Both surfaces are SERVER components,
// so this also confirms the client island really hydrates there.
//
// NOT claimed: real-device touch :active. touchscreen.tap() is atomic and a held
// CDP touchStart never sets :active, so REAL_DEVICE_TOUCH_ACTIVE stays
// UNVERIFIED and nothing here closes it.

const T = 20_000;

async function seedArchivedClient(page: Page): Promise<{ seed: E2eSeed; clientId: string }> {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  // archived_at non-null is what hides a client from active lists.
  await sql(`update public.clients set archived_at = now() where id = $1`, [clientId]);
  await loginAsOwner(page, seed);
  return { seed, clientId };
}

/**
 * Holds the server action open so the pending state is GUARANTEED observable.
 *
 * The first version of these tests sampled aria-busy immediately after the
 * click and fell back to `if (state === null) return` when the action had
 * already completed. Codex raised that as a P2 and was right: the fallback
 * meant the pending assertion COULD SILENTLY NEVER RUN, so the test reported
 * green while proving nothing about the very state it exists to check. A test
 * with an escape hatch around its own claim is the same defect class as a
 * proof that returns early and is recorded as passed.
 *
 * Delaying the request removes the race instead of tolerating it. Next server
 * actions POST back to the page's own URL, so that is what is intercepted; the
 * route is released after the assertions run.
 */
async function withSlowAction(
  page: Page,
  delayMs: number,
  body: () => Promise<void>,
): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/clients"),
    async (route, request) => {
      if (request.method() === "POST") {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      await route.continue();
    },
  );
  try {
    await body();
  } finally {
    await page.unroute((url) => url.pathname.startsWith("/clients"));
  }
}

const editUnarchive = (page: Page) =>
  page.getByRole("button", { name: /Unarchive client|Unarchiving/ });
const listUnarchive = (page: Page) =>
  page.getByRole("button", { name: /^Unarchive$|Unarchiving/ });

test.describe("UI-04 unarchive reports its own progress", () => {
  test("edit page: the control is on the touch floor and shows a focus ring", async ({
    page,
  }) => {
    const { clientId } = await seedArchivedClient(page);
    await page.goto(`/clients/${clientId}/edit`);

    const btn = editUnarchive(page);
    await expect(btn).toBeVisible({ timeout: T });

    // 44px floor. Before UI-04 this was px-3 py-2 text-sm — about 36px.
    const box = await btn.evaluate((el) => ({
      w: (el as HTMLElement).offsetWidth,
      h: (el as HTMLElement).offsetHeight,
    }));
    expect(box.h).toBeGreaterThanOrEqual(44);

    // focus-visible, not focus: a mouse click must not paint the ring.
    await btn.focus();
    const ring = await btn.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, shadow: cs.boxShadow };
    });
    expect(
      ring.shadow !== "none" || parseFloat(ring.width || "0") > 0,
      `focus produced no visible ring: ${JSON.stringify(ring)}`,
    ).toBe(true);
  });

  test("edit page: busy is announced, and the label swap is the ONLY change", async ({
    page,
  }) => {
    const { clientId } = await seedArchivedClient(page);
    await page.goto(`/clients/${clientId}/edit`);

    const btn = editUnarchive(page);
    await expect(btn).toBeVisible({ timeout: T });

    const before = await btn.evaluate((el) => ({
      w: (el as HTMLElement).offsetWidth,
      h: (el as HTMLElement).offsetHeight,
    }));

    await withSlowAction(page, 1_500, async () => {
      await btn.click();

      // NO FALLBACK. The action is held open, so the busy state must be there.
      // aria-busy is what announces it; the disable IS the double-submit guard.
      await expect(btn).toHaveAttribute("aria-busy", "true", { timeout: T });
      await expect(btn).toBeDisabled();

      const during = await btn.evaluate((el) => ({
        w: (el as HTMLElement).offsetWidth,
        h: (el as HTMLElement).offsetHeight,
        text: (el.textContent ?? "").trim(),
      }));

      // THIS CONTROL CHANGES WIDTH, DELIBERATELY: `busyLabel` swaps the text,
      // and Button's geometry-stable path is the one taken when no busyLabel is
      // supplied. HEIGHT is the guarantee that holds here, and it is the one
      // that matters — a changing height moves everything below the control.
      expect(during.h).toBe(before.h);
      // The accessible name must never empty out mid-flight.
      expect(during.text).toBe("Unarchiving…");
    });

    // And the command still completes.
    await expect
      .poll(
        async () => {
          const rows = await sql<{ archived_at: string | null }>(
            `select archived_at from public.clients where id = $1`,
            [clientId],
          );
          return rows[0]?.archived_at;
        },
        { timeout: T },
      )
      .toBeNull();
  });

  test("list row: the busy state cannot change the control's box at all", async ({
    page,
  }) => {
    const { clientId } = await seedArchivedClient(page);
    await page.goto("/clients?view=archived");

    const btn = listUnarchive(page).first();
    await expect(btn).toBeVisible({ timeout: T });

    const before = await btn.evaluate((el) => ({
      w: (el as HTMLElement).offsetWidth,
      h: (el as HTMLElement).offsetHeight,
    }));

    await withSlowAction(page, 1_500, async () => {
      await btn.click();
      await expect(btn).toHaveAttribute("aria-busy", "true", { timeout: T });
      await expect(btn).toBeDisabled();

      // No busyLabel on this one, so BOTH axes must hold — a dense row must not
      // reflow mid-action.
      const during = await btn.evaluate((el) => ({
        w: (el as HTMLElement).offsetWidth,
        h: (el as HTMLElement).offsetHeight,
      }));
      expect(during).toEqual(before);
    });

    // THE COMMAND, not a truthy id. A presentation slice must not break it.
    await expect
      .poll(
        async () => {
          const rows = await sql<{ archived_at: string | null }>(
            `select archived_at from public.clients where id = $1`,
            [clientId],
          );
          return rows[0]?.archived_at;
        },
        { timeout: T },
      )
      .toBeNull();
  });

  test("the list control relaxes to 32px only where the pointer is PRECISE", async ({
    page,
  }) => {
    await seedArchivedClient(page);
    await page.goto("/clients?view=archived");
    const btn = listUnarchive(page).first();
    await expect(btn).toBeVisible({ timeout: T });

    // CONTROL_COMPACT_FINE_POINTER is `pointer-fine:min-h-8`, and its stated
    // contract is "44px on every touch device; 32px only where the pointer is
    // precise". My first version asserted >=44 here and failed at 32 — on a
    // desktop Chromium, which IS a fine pointer, so the code was right and the
    // assertion contradicted the primitive it was testing.
    //
    // Both halves of that contract are asserted, each under the input mode it
    // actually describes. Asserting only one would let the other regress.
    const fine = await btn.evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(fine).toBe(32);
    // No filler assertion here. The earlier version ended with
    // `expect(clientId).toBeTruthy()`, added only to consume an otherwise-unused
    // variable — a fake assertion written to satisfy a linter, which Codex
    // rightly flagged. A truthy UUID proves nothing about this control; the
    // height above is the entire claim, and the mutation is asserted in the
    // tests that actually perform it.
  });

  test("390px: the list control does not overflow the row", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedArchivedClient(page);
    await page.goto("/clients?view=archived");

    const btn = listUnarchive(page).first();
    await expect(btn).toBeVisible({ timeout: T });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

// The touch half of CONTROL_COMPACT_FINE_POINTER's contract. `pointer-fine:` is
// a media query, so it can only be exercised by changing the emulated input
// mode — which needs a separate context, hence a separate describe with
// test.use rather than a viewport change inside a test.
test.describe("UI-04 on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the list control reaches the 44px floor where the pointer is COARSE", async ({
    page,
  }) => {
    await seedArchivedClient(page);
    await page.goto("/clients?view=archived");

    const btn = listUnarchive(page).first();
    await expect(btn).toBeVisible({ timeout: T });

    // Confirm the emulation actually took, so a silently-fine context cannot
    // make this pass for the wrong reason.
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    expect(coarse, "touch emulation must be in effect").toBe(true);

    const h = await btn.evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(h).toBeGreaterThanOrEqual(44);
  });
});
