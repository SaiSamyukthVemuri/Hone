import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, seedE2eDashboardMemoryClient } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Dashboard memory visibility (Chloe production feedback) — real browser, real
// local stack.
//
// REPRODUCED DEFECT. The Today appointment card clipped the two lines Chloe
// reads before a client sits down, twice over: a 70-character JS cap on the
// Remember note AND Tailwind's `truncate` (overflow:hidden; text-overflow:
// ellipsis; white-space:nowrap) on BOTH that line and the latest-settings line.
// At 390px the usable text column is ~246px, so the CSS clamp bit at roughly
// 30-35 characters — long before the 70-character cap. The full text was
// already in the payload; only the render threw it away.
//
// These specs assert the rendered text at iPhone width, not the source: the
// note must appear IN FULL, wrap onto multiple lines, and never overlap the
// row's action controls.

const T = 20_000;

// Deliberately long, multi-line, and containing an unbroken token — the three
// things that could break the layout once the clamp is removed. Clinical
// wording only; no client name, nothing from the reporter's screenshots.
const LONG_NOTE_LINE_1 =
  "Upper lip: drop to energy level 8 next visit and re-check tolerance after the first pass.";
const LONG_NOTE_LINE_2 = "Numbing applied 30 minutes ahead; client preferred shorter passes.";
const LONG_NOTE = `${LONG_NOTE_LINE_1}\n${LONG_NOTE_LINE_2}`;

async function openDashboard(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByText("Before today").first()).toBeVisible({ timeout: T });
}

function rememberLine(page: Page) {
  return page.locator("span").filter({ hasText: /^Remember: / }).first();
}

function setupLine(page: Page) {
  return page.locator("span").filter({ hasText: /^Latest setup: / }).first();
}

test.describe("iPhone profile", () => {
  // ENGINE NOTE: iPhone dimensions on the Chromium engine (the repo E2E engine),
  // not real iOS Safari/WebKit.
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the Remember note and latest-settings line show in FULL at 390px", async ({ page }) => {
    const seed = await seedE2eStudio();
    await seedE2eDashboardMemoryClient(seed, { cautionNote: LONG_NOTE });
    await loginAsOwner(page, seed);
    await openDashboard(page);

    await test.step("the WHOLE note is rendered — no ellipsis, nothing dropped", async () => {
      const text = await rememberLine(page).innerText();
      expect(text).toContain(LONG_NOTE_LINE_1);
      expect(text).toContain(LONG_NOTE_LINE_2);
      expect(text).not.toContain("…");
      // Longer than the old 70-character cap, so a regression is unmissable.
      expect(text.length).toBeGreaterThan(70);
    });

    await test.step("it WRAPS instead of being clipped to one line", async () => {
      const el = rememberLine(page);
      const metrics = await el.evaluate((node) => {
        const cs = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          whiteSpace: cs.whiteSpace,
          textOverflow: cs.textOverflow,
          overflow: cs.overflow,
          lineHeight: parseFloat(cs.lineHeight) || 16,
          height: rect.height,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        };
      });
      expect(metrics.whiteSpace).toBe("pre-wrap"); // intentional line breaks kept
      expect(metrics.textOverflow).not.toBe("ellipsis");
      expect(metrics.overflow).not.toBe("hidden");
      // Multiple visual lines: taller than a single line box.
      expect(metrics.height).toBeGreaterThan(metrics.lineHeight * 1.5);
      // Nothing is horizontally clipped inside the element.
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    });

    await test.step("the latest-settings line is complete too", async () => {
      const text = await setupLine(page).innerText();
      expect(text).not.toContain("…");
      const metrics = await setupLine(page).evaluate((node) => ({
        whiteSpace: getComputedStyle(node).whiteSpace,
        textOverflow: getComputedStyle(node).textOverflow,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }));
      expect(metrics.whiteSpace).toBe("pre-wrap");
      expect(metrics.textOverflow).not.toBe("ellipsis");
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    });

    await test.step("the page does not scroll sideways", async () => {
      const w = await page.evaluate(() => ({
        s: document.documentElement.scrollWidth,
        c: document.documentElement.clientWidth,
      }));
      expect(w.s, `no horizontal overflow (${w.s} vs ${w.c})`).toBeLessThanOrEqual(w.c);
    });

    await test.step("the long note never covers the row's action controls", async () => {
      const noteEl = rememberLine(page);
      const note = await noteEl.boundingBox();
      expect(note).not.toBeNull();
      // Only controls that are NOT ancestors of the note itself — the row is
      // wrapped in a Link that legitimately contains it.
      const overlaps = await noteEl.evaluate((el) => {
        const nb = el.getBoundingClientRect();
        const hits: string[] = [];
        document
          .querySelectorAll('ul li a[href^="/calendar/"], ul li button, ul li a[href*="/clients/"]')
          .forEach((node, i) => {
            if (node.contains(el)) return; // an ancestor of the note, not an overlap
            const b = node.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) return;
            if (
              b.left < nb.right &&
              b.right > nb.left &&
              b.top < nb.bottom &&
              b.bottom > nb.top
            ) {
              hits.push(`${i}:${(node.textContent ?? "").trim().slice(0, 24)}`);
            }
          });
        return hits;
      });
      expect(overlaps, `controls overlapping the note: ${overlaps.join(", ")}`).toEqual([]);
    });
  });

  test("an unbroken token wraps rather than pushing the layout sideways", async ({ page }) => {
    const seed = await seedE2eStudio();
    await seedE2eDashboardMemoryClient(seed, {
      cautionNote: `Lot ${"A".repeat(90)}`,
    });
    await loginAsOwner(page, seed);
    await openDashboard(page);

    const w = await page.evaluate(() => ({
      s: document.documentElement.scrollWidth,
      c: document.documentElement.clientWidth,
    }));
    expect(w.s, "an unbroken 90-character token must not widen the page").toBeLessThanOrEqual(w.c);
    const wordBreak = await rememberLine(page).evaluate(
      (node) => getComputedStyle(node).overflowWrap || getComputedStyle(node).wordWrap,
    );
    expect(wordBreak).toBe("break-word");
  });

  test("the no-history and no-note states are unchanged", async ({ page }) => {
    const seed = await seedE2eStudio();
    await seedE2eDashboardMemoryClient(seed, { cautionNote: null });
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");
    // History exists (a charted block) but no watch/plan note was recorded.
    await expect(page.getByText("No watch/plan note.").first()).toBeVisible({ timeout: T });
  });
});

test.describe("desktop is unaffected", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the full note renders and keeps its hover title", async ({ page }) => {
    const seed = await seedE2eStudio();
    await seedE2eDashboardMemoryClient(seed, { cautionNote: LONG_NOTE });
    await loginAsOwner(page, seed);
    await openDashboard(page);

    const el = rememberLine(page);
    await expect(el).toContainText(LONG_NOTE_LINE_1);
    await expect(el).toContainText(LONG_NOTE_LINE_2);
    await expect(el).toHaveAttribute("title", new RegExp(LONG_NOTE_LINE_1.slice(0, 30)));
  });
});
