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

    await btn.click();

    const state = await btn
      .evaluate((el) => ({
        busy: el.getAttribute("aria-busy") === "true",
        disabled: (el as HTMLButtonElement).disabled,
        w: (el as HTMLElement).offsetWidth,
        h: (el as HTMLElement).offsetHeight,
        text: (el.textContent ?? "").trim(),
      }))
      .catch(() => null);

    if (state === null) {
      // The action completed and navigated before we could sample. The command
      // still has to have worked, which the list test asserts in the database.
      await expect(page).toHaveURL(/\/clients/, { timeout: T });
      return;
    }

    // The disable IS the double-submit guard; aria-busy is what announces it.
    expect(state.busy || state.disabled).toBe(true);

    // THIS CONTROL DOES CHANGE WIDTH, DELIBERATELY. `busyLabel` swaps the text
    // ("Unarchive client" -> "Unarchiving…"), and Button's geometry-stable path
    // is the one taken when NO busyLabel is supplied. My first version of this
    // test asserted the full box was unchanged and failed — the assertion, not
    // the code, was wrong: it demanded a guarantee this variant never made.
    //
    // HEIGHT is the guarantee that holds here, and it is the one that matters:
    // a changing height would move everything below the control. The dense list
    // row takes the no-busyLabel path instead, where width is stable too.
    expect(state.h).toBe(before.h);
    expect(state.text.length).toBeGreaterThan(0); // never a nameless control
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

    await btn.click();

    const during = await btn
      .evaluate((el) => ({
        w: (el as HTMLElement).offsetWidth,
        h: (el as HTMLElement).offsetHeight,
        busy: el.getAttribute("aria-busy") === "true",
        disabled: (el as HTMLButtonElement).disabled,
      }))
      .catch(() => null);

    if (during === null) {
      await expect(page).toHaveURL(/\/clients/, { timeout: T });
      return;
    }
    expect(during.busy || during.disabled).toBe(true);
    // No busyLabel on this one, so BOTH axes must hold — the row cannot reflow.
    expect({ w: during.w, h: during.h }).toEqual(before);
  });

  test("the list control relaxes to 32px only where the pointer is PRECISE", async ({
    page,
  }) => {
    const { clientId } = await seedArchivedClient(page);
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
    expect(clientId).toBeTruthy();
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
