import { test, expect, type Locator, type Page } from "@playwright/test";

import { seedE2eClient, seedE2eStudio } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// UI-R02 — the DANGER family's press, proved in a real browser.
//
// WHY THIS FILE EXISTS
// --------------------
// UI-R01 shipped `danger` with its own third colour step
// (danger 600 -> 700 -> 800) and could only ever CLASS-PROVE it: the standing
// caveat was "danger press is class-proved, not browser-proved", because no
// shipped surface put a solid-danger control on a route the harness could
// reach. ArchiveClientControl now does, so the caveat is closeable here.
//
// This reuses ui-r01-interaction-foundations.spec.ts's helpers verbatim rather
// than inventing a second measurement vocabulary — the same `scale` reader and
// the same layout-box geometry, for the same reasons recorded there.
//
// WHAT IS STILL NOT PROVED: REAL_DEVICE_TOUCH_ACTIVE. `touchscreen.tap()` is
// atomic and a held CDP touchStart never sets :active, so a held-press proof
// here uses the MOUSE. A finger on real glass remains unverified and nothing in
// this file should be quoted as closing it.

const T = 20_000;

/**
 * Reads the live computed `scale`. NOT `transform` — Tailwind v4 compiles
 * `active:scale-[0.98]` to the standalone `scale` property, so `transform`
 * stays "none" forever and a proof written against it passes for the wrong
 * reason. Recorded in the UI-R01 spec; repeated here so this file cannot drift.
 */
async function computedScale(control: Locator): Promise<string> {
  return control.evaluate((el) => getComputedStyle(el).scale);
}

async function computedBg(control: Locator): Promise<string> {
  return control.evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** Layout box, transform-independent. See the UI-R01 spec for why not boundingBox(). */
async function layoutBox(control: Locator) {
  return control.evaluate((el) => {
    const e = el as HTMLElement;
    return { w: e.offsetWidth, h: e.offsetHeight };
  });
}

/**
 * Presses and HOLDS without ever completing a click, so a destructive control
 * can be measured mid-press without being invoked. Release happens far away
 * from the control, which is what stops the click from firing.
 */
/**
 * Holds the press and POLLS until the predicate holds, returning the last
 * reading either way.
 *
 * A single read immediately after mouse.down() is wrong, and quietly so.
 * PRESS_TRANSITION animates `scale` over 120ms, so a read at t=0 returns the
 * value the control is transitioning FROM — 1 — not the pressed value. The
 * UI-R01 spec records the same trap and solves it with expect.poll; this is
 * that, wrapped so the press can be held across the polling window.
 *
 * It also fixes a VACUOUS assertion of my own: the reduced-motion test asserted
 * `scale === "1"`, which a mid-transition read satisfies just as well as real
 * suppression does. That test could not tell the two apart, so it proved
 * nothing. It now watches a full window and asserts 0.98 is NEVER reached.
 */
async function pollWhileHeld<T>(
  page: Page,
  control: Locator,
  read: () => Promise<T>,
  until: (v: T) => boolean,
  windowMs = 2_000,
): Promise<T> {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  if (!box) throw new Error("control has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    const deadline = Date.now() + windowMs;
    let last = await read();
    while (!until(last) && Date.now() < deadline) {
      await page.waitForTimeout(25);
      last = await read();
    }
    return last;
  } finally {
    await page.mouse.move(2, 2);
    await page.mouse.up();
  }
}

async function measureWhileHeld<T>(
  page: Page,
  control: Locator,
  read: () => Promise<T>,
): Promise<T> {
  // MUST scroll first. Locator.click() auto-scrolls; page.mouse.down() does
  // NOT, and boundingBox() returns viewport-relative coordinates. The archive
  // control sits at the foot of a long edit form, so the first version of this
  // helper pressed a point outside the viewport and :active never applied —
  // the computed scale read "none" and the failure looked like a broken press
  // primitive rather than a broken measurement.
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  if (!box) throw new Error("control has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    return await read();
  } finally {
    await page.mouse.move(2, 2);
    await page.mouse.up();
  }
}

/**
 * Navigates by SEEDED ID, not by clicking through the roster.
 *
 * The first draft of this helper clicked the client's name on /clients and
 * waited for a URL match. Both tests then hit the 2-minute timeout: the roster
 * row is not a plain text link, so the click never navigated and the wait never
 * resolved. Every other spec in this directory seeds an id and goes straight
 * there, which is both faster and immune to roster markup changing — so this
 * follows the house pattern rather than keeping a bespoke one.
 */
async function gotoClientEdit(page: Page) {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}/edit`);
  return { seed, clientId };
}

test.describe("UI-R02 danger press", () => {
  test("the disarmed trigger is on the touch floor and acknowledges a press", async ({ page }) => {
    // BOTH motion states are emulated EXPLICITLY in this file — `no-preference`
    // here, `reduce` in the test below — so neither result depends on the host.
    //
    // This is deliberately stricter than the UI-R01 spec, which asserts
    // `scale === "0.98"` with no emulation at all (line ~184). That passes in
    // CI, where headless Chromium reports no-preference, and returns "1" on a
    // workstation that has reduced motion enabled — which is exactly what
    // happened while writing this file. The assertion was reading the HOST's
    // accessibility setting as though it were a property of the control. Not
    // fixed here: that file belongs to UI-R01, which is review-clean at its
    // exact head, and reaching into it from UI-R02 would invalidate that.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await gotoClientEdit(page);
    const trigger = page.getByRole("button", { name: "Archive client" }).first();
    await expect(trigger).toBeVisible({ timeout: T });

    // 44px floor. Before UI-R02 this was px-3 py-2 text-sm — about 36px — on
    // the one control whose job is to stop a misclick.
    const box = await layoutBox(trigger);
    expect(box.h).toBeGreaterThanOrEqual(44);

    // At rest there is no scale; held, the leaf layer applies.
    const restBg = await computedBg(trigger);
    expect(await computedScale(trigger)).toBe("none");

    const held = await pollWhileHeld(
      page,
      trigger,
      async () => ({
        scale: await computedScale(trigger),
        bg: await computedBg(trigger),
        reduceMatches: await trigger.evaluate(
          () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      }),
      (v) => v.scale === "0.98",
    );
    expect(
      held.scale,
      `held scale=${held.scale} reduceMatches=${held.reduceMatches}`,
    ).toBe("0.98");
    expect(held.reduceMatches, "no-preference must be in effect here").toBe(false);

    // The COLOUR is the load-bearing half: LEAF_CONTROL_PRESS carries none of
    // its own, so a caller that supplied no active: colour would ship nothing
    // at all to a reduced-motion user. Held background must differ from rest.
    expect(held.bg).not.toBe(restBg);

    // Nothing was archived — the press never completed a click.
    await expect(trigger).toBeVisible();
  });

  test("the SOLID danger submit paints its own third step, not a repeat of hover", async ({ page }) => {
    await gotoClientEdit(page);
    await page.getByRole("button", { name: "Archive client" }).first().click();

    // Armed. The submit is the only solid-danger control on the surface.
    const submit = page.locator('form button[type="submit"]', { hasText: "Archive client" }).first();
    await expect(submit).toBeVisible({ timeout: T });

    const box = await layoutBox(submit);
    expect(box.h).toBeGreaterThanOrEqual(44);

    const restBg = await computedBg(submit);
    const hoverBg = await submit.hover().then(() => computedBg(submit));
    const heldBg = await measureWhileHeld(page, submit, () => computedBg(submit));

    // This is the assertion UI-R01 could not make in a browser: three DISTINCT
    // colours. The earlier implementation repeated the hover fill in active:,
    // so a hovering user with reduced motion pressed a button that was already
    // painted and saw nothing change.
    expect(heldBg).not.toBe(restBg);
    expect(heldBg).not.toBe(hoverBg);

    // Still armed, still not submitted.
    await expect(submit).toBeVisible();
  });

  test("with motion reduced, the danger press is still visible — colour carries it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoClientEdit(page);
    await page.getByRole("button", { name: "Archive client" }).first().click();
    const submit = page.locator('form button[type="submit"]', { hasText: "Archive client" }).first();
    await expect(submit).toBeVisible({ timeout: T });

    const restBg = await computedBg(submit);
    const restScale = await computedScale(submit);

    // Watch the FULL window rather than sampling once. `until` never returns
    // true on purpose, so this polls to the deadline and records whether the
    // tactile scale was EVER applied. A single t=0 read would report "1" even
    // when suppression was broken, because that is also the pre-transition
    // value — which is precisely how the first version of this test passed
    // while proving nothing.
    const seen = new Set<string>();
    const held = await pollWhileHeld(
      page,
      submit,
      async () => {
        const scale = await computedScale(submit);
        seen.add(scale);
        return { scale, bg: await computedBg(submit) };
      },
      () => false,
      600,
    );
    expect([...seen].sort(), `scales seen while held: ${[...seen].join(",")}`).not.toContain("0.98");

    // `motion-reduce:active:scale-100` computes to "1" — an EXPLICIT identity
    // scale — not to "none". "none" is the value at REST, when no scale is set
    // at all. The first version of this assertion expected "none" and failed
    // while the mechanism was working correctly: it was asserting the absence of
    // a declaration when the claim is that the declaration is neutralised.
    // Distinguishing the two is the whole point, because "none" would ALSO be
    // what a completely unstyled control reports.
    expect(held.scale).toBe("1");
    expect(restScale).toBe("none");

    // The colour is therefore the only acknowledgement a reduced-motion user
    // gets. If this assertion ever fails, that user presses a destructive
    // control and sees nothing at all.
    expect(held.bg).not.toBe(restBg);
  });

  test("pressing a destructive control cannot reflow the form around it", async ({ page }) => {
    await gotoClientEdit(page);
    await page.getByRole("button", { name: "Archive client" }).first().click();
    const submit = page.locator('form button[type="submit"]', { hasText: "Archive client" }).first();
    await expect(submit).toBeVisible({ timeout: T });

    // The NEIGHBOUR is what a reflow moves. Cancel sits beside the submit.
    const cancel = page.getByRole("button", { name: "Cancel" }).first();
    const before = await cancel.evaluate((el) => (el as HTMLElement).offsetLeft);
    const during = await measureWhileHeld(page, submit, () =>
      cancel.evaluate((el) => (el as HTMLElement).offsetLeft),
    );
    expect(during).toBe(before);
  });
});
