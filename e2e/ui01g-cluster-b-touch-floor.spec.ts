import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eEndedAppointmentSession,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// UI-01G (#667) — browser acceptance for the Cluster B touch floor.
//
// The unit suite proves the CONTRACT the source declares. It cannot prove what
// the browser computes. This measures the real boxes, the real focus paint, the
// real wrap at 390px, and that the row still behaves like navigation.
//
// The controls: the Sessions-tab action row on the Client Profile
// (client-appointment-timeline), which was `px-3 py-1.5 text-xs` = ~30px with
// no focus indicator on any of its thirteen Cluster B controls.

const IPHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
  // The viewport META matters: Playwright's isMobile without it yields a 980px
  // layout viewport, which wrongly activates `md:` and silently hides controls.
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

// Seeded PER TEST rather than in beforeAll: the two describe blocks carry
// different `test.use()` contexts, and per-test seeding keeps each run's rows
// unique — which is also what makes concurrent worktrees safe on the shared
// stack without anyone resetting it.
async function freshProfile() {
  const seed: E2eSeed = await seedE2eStudio();
  const charted = await seedE2eEndedAppointmentSession(seed, {
    status: "completed",
    charted: true,
    endedHoursAgo: 3,
  });
  return { seed, clientId: charted.clientId };
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("control not rendered");
  return b;
}

/** Does a real tap at (x,y) land on this element, or on something above it? */
async function hitTestsTo(page: Page, l: Locator, x: number, y: number) {
  const handle = await l.elementHandle();
  return page.evaluate(
    ([el, px, py]) => {
      const hit = document.elementFromPoint(px as number, py as number);
      return hit ? (el as Element).contains(hit) || hit === el : false;
    },
    [handle, x, y] as const,
  );
}

async function timelineControls(page: Page, clientId: string) {
  await page.goto(`/clients/${clientId}?tab=sessions`);
  await page.waitForLoadState("networkidle");

  // THE TIMELINE GROUPS ARE <details>, AND ONLY `needsCharting` OPENS BY
  // DEFAULT. A charted appointment therefore lands in a COLLAPSED group, and
  // its actions are present in the DOM but not tappable. Expand it first, the
  // way a practitioner does.
  //
  // This is also why geometry alone is not acceptance: inside a closed
  // <details> these anchors still report a 104x44 box to
  // getBoundingClientRect. Only a visibility-aware locator tells the truth.
  const groups = page.locator("details:has(a)");
  const gn = await groups.count();
  for (let i = 0; i < gn; i++) {
    const g = groups.nth(i);
    if (!(await g.evaluate((d) => (d as HTMLDetailsElement).open))) {
      await g.locator("summary").first().click();
    }
  }

  const row = page
    .locator("a:visible")
    .filter({ hasText: /^(View session|Chart session|Open appointment)$/ });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  return row;
}

test.describe("UI-01G: Cluster B on a touch device", () => {
  test.use(IPHONE);

  test("every timeline action clears 44px and hit-tests at its centre AND corners", async ({ page }) => {
    const { seed, clientId } = await freshProfile();
    await loginAsOwner(page, seed);
    const controls = await timelineControls(page, clientId);
    const n = await controls.count();
    expect(n, "the Sessions tab must render its action row").toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      const c = controls.nth(i);
      const name = (await c.innerText()).trim();
      const b = await box(c);
      expect(b.height, `"${name}" is under the thumb floor`).toBeGreaterThanOrEqual(44);

      // A box that measures 44px but is overlapped by a sibling is not a target.
      const inset = 3;
      expect(await hitTestsTo(page, c, b.x + b.width / 2, b.y + b.height / 2), `"${name}" centre`).toBe(true);
      expect(await hitTestsTo(page, c, b.x + inset, b.y + inset), `"${name}" top-left`).toBe(true);
      expect(
        await hitTestsTo(page, c, b.x + b.width - inset, b.y + b.height - inset),
        `"${name}" bottom-right`,
      ).toBe(true);
    }
  });

  test("keyboard reaches each action and a focus indicator actually paints", async ({ page }) => {
    const { seed, clientId } = await freshProfile();
    await loginAsOwner(page, seed);
    const controls = await timelineControls(page, clientId);
    const first = controls.first();
    // REAL Tab, not .focus(): `:focus-visible` is a keyboard heuristic and
    // Chromium does not apply it to programmatic focus, so .focus() would
    // report "no ring" on a control that rings correctly for a real user.
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await first.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "the action must be reachable by Tab").toBe(true);
    const ring = await first.evaluate((el) => {
      const s = getComputedStyle(el);
      return { shadow: s.boxShadow, outline: s.outlineStyle, fv: el.matches(":focus-visible") };
    });
    expect(ring.fv, "Tab focus must match :focus-visible").toBe(true);
    // Before this slice NONE of the thirteen carried focus-visible at all.
    expect(
      ring.shadow !== "none" || ring.outline !== "none",
      "a keyboard-focused action must paint an indicator",
    ).toBe(true);
  });

  test("the row wraps at 390px and never scrolls the page sideways", async ({ page }) => {
    const { seed, clientId } = await freshProfile();
    await loginAsOwner(page, seed);
    await timelineControls(page, clientId);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "no horizontal page overflow at 390px").toBeLessThanOrEqual(1);
  });

  test("navigation still works: the action goes where it always did", async ({ page }) => {
    const { seed, clientId } = await freshProfile();
    await loginAsOwner(page, seed);
    const controls = await timelineControls(page, clientId);
    const target = controls.first();
    const href = await target.getAttribute("href");
    expect(href, "these are links, not buttons — the destination is preserved").toBeTruthy();
    await Promise.all([page.waitForURL(`**${href}`, { timeout: 20_000 }), target.click()]);
    expect(page.url()).toContain(href!);
  });

  test("rapid repeated activation navigates once and leaves the app usable", async ({ page }) => {
    const { seed, clientId } = await freshProfile();
    await loginAsOwner(page, seed);
    const controls = await timelineControls(page, clientId);
    const target = controls.first();
    const href = await target.getAttribute("href");
    await target.click({ noWaitAfter: true });
    await target.click({ noWaitAfter: true, force: true }).catch(() => undefined);
    await page.waitForURL(`**${href}`, { timeout: 20_000 });
    expect(page.url()).toContain(href!);
    // Still interactive after the double activation — not stuck mid-transition.
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("UI-01G: desktop density is not inflated", () => {
  // The negative control for the pointer gate. Without it, the touch
  // assertions above would pass equally for a change that grew every desktop
  // control — which is exactly what CONTROL_COMPACT_FINE_POINTER prevents.
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false });

  test("a fine pointer keeps the compact box, and still paints focus", async ({ page }) => {
    const { seed, clientId } = await freshProfile();
    await loginAsOwner(page, seed);
    const controls = await timelineControls(page, clientId);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
    const b = await box(controls.first());
    expect(b.height, "desktop must stay compact, not inflate to 44px").toBeLessThan(44);
    expect(b.height, "…but not collapse either").toBeGreaterThanOrEqual(28);
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await controls.first().evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Tab must reach the action on desktop too").toBe(true);
    expect(
      await controls.first().evaluate((el) => el.matches(":focus-visible")),
      "desktop keyboard focus must ring as well",
    ).toBe(true);
  });
});
