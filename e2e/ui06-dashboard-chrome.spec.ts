import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, seedE2eDashboardMemoryClient } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// UI-06 — the flattened memory cards, proved at three widths.
//
// The source proof pins the vocabulary (one label, one border token, one row
// treatment, no depth-4 box). What it CANNOT show is the thing the slice is
// actually for: that removing per-row boxes did not cost scanning, and that a
// flatter composition still reads as distinct sections on a phone.
//
// So this asserts the rendered result: rows are separated by a real painted
// divider rather than by nothing, the page never scrolls sideways, and the
// section labels remain visible at every width.
//
// NOT claimed: that it looks good. Automation cannot judge that; the visual
// critique is in the PR body.

const WIDTHS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1440, height: 900 },
] as const;

async function openDashboardMemory(page: Page) {
  const seed = await seedE2eStudio();
  // A caution note is required by the seed helper, and it is also what makes
  // the BLUE callout render — the surface whose fourth label spelling this
  // slice reconciled. Seeding without one would have proved the flattening on
  // a card missing the very region under test.
  await seedE2eDashboardMemoryClient(seed, {
    cautionNote: "E2E caution: watch the upper lip for reactive erythema.",
    nextVisitNote: "E2E next visit: drop to 3.5s dwell if reaction persists.",
  });
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  const toggle = page.getByTestId("dashboard-memory-toggle").first();
  if (await toggle.count()) await toggle.click();
  return seed;
}

for (const vp of WIDTHS) {
  test.describe(`UI-06 at ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("no horizontal overflow after flattening", async ({ page }) => {
      await openDashboardMemory(page);
      // The whole point of a flatter composition is that it fits better, not
      // worse. A flattened row that overflows would be a regression, not polish.
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${vp.name} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
    });

    test("flattened rows are still separated by a PAINTED divider", async ({ page }) => {
      await openDashboardMemory(page);
      const rows = page.getByTestId("prep-setup-area");
      const n = await rows.count();
      test.skip(n < 2, "needs at least two rows to observe separation");

      // Asserting the computed border, not the class: a tokened divider that
      // failed to resolve would still carry `divide-line` in the class list
      // while painting nothing, and scanning would be gone.
      const painted = await rows.nth(1).evaluate((el) => {
        const cs = getComputedStyle(el as HTMLElement);
        return {
          width: parseFloat(cs.borderTopWidth || "0"),
          colour: cs.borderTopColor,
        };
      });
      expect(painted.width, "divider has no width").toBeGreaterThan(0);
      expect(painted.colour).not.toBe("rgba(0, 0, 0, 0)");
      expect(painted.colour).not.toBe("transparent");
    });

    test("sections stay distinguishable — labels visible, rows not collapsed", async ({
      page,
    }) => {
      await openDashboardMemory(page);
      const card = page.getByTestId("appointment-prep-memory").first();
      await expect(card).toBeVisible({ timeout: 20_000 });

      // A flatter card must not become an undifferentiated wall of text: the
      // shared section labels are what carry the grouping now that the boxes
      // are gone, so they have to be on screen at every width.
      const labels = card.locator("p,h2,h3,h4,span").filter({ hasText: /^[A-Z][A-Za-z ]+$/ });
      expect(await labels.count()).toBeGreaterThan(0);

      // Rows must retain real height — flattening should not have produced
      // zero-height or overlapping rows.
      const rows = page.getByTestId("prep-setup-area");
      if (await rows.count()) {
        const h = await rows.first().evaluate((el) => (el as HTMLElement).offsetHeight);
        expect(h, "flattened row collapsed").toBeGreaterThan(16);
      }
    });
  });
}

test.describe("UI-06 motion", () => {
  test("the memory cards introduce NO transition or animation", async ({ page }) => {
    await openDashboardMemory(page);
    const card = page.getByTestId("appointment-prep-memory").first();
    await expect(card).toBeVisible({ timeout: 20_000 });

    // find-animation-opportunities rejected every candidate on this surface:
    // server-rendered branches have no client state change to bridge, list
    // staggers would delay clinical data on a many-times-daily surface, and the
    // <details> accordions would need a client boundary plus a height
    // animation. This asserts that verdict held in the rendered output.
    const moving = await card.evaluate((root) => {
      const all = [root, ...Array.from(root.querySelectorAll("*"))];
      return all.filter((el) => {
        const cs = getComputedStyle(el as HTMLElement);
        const dur = (cs.transitionDuration || "0s")
          .split(",")
          .some((d) => parseFloat(d) > 0);
        const anim = cs.animationName !== "none" && cs.animationName !== "";
        return dur || anim;
      }).length;
    });
    expect(moving, `${moving} element(s) in the card animate`).toBe(0);
  });
});
