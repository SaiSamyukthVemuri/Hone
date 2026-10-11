import { test, expect, type Page } from "@playwright/test";

// Public marketing homepage smoke (copy deck v2.2, MKT-02B). The homepage is a
// static, public, server-rendered page (no auth/DB), so no seed or login is
// needed. Category: electrolysis practice software; differentiator: treatment
// memory; one conversion: the founder-led walkthrough (a "Request", never a
// "Book", because /demo is a lead-capture flow).
//
// The H1 is now the PROMISE, not the category — the category is the eyebrow
// directly above it. The film's own behaviour is proved separately, in
// marketing-homepage-film.spec.ts; this spec checks the page around it.

async function expectNoPageOverflow(page: Page, label: string) {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    widths.scrollWidth,
    `${label}: page must not scroll horizontally (scrollWidth ${widths.scrollWidth} vs clientWidth ${widths.clientWidth})`,
  ).toBeLessThanOrEqual(widths.clientWidth);
}

test.describe("marketing homepage (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("category hero, sections, CAD pricing, trust, walkthrough CTA", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Start the next treatment where the last one ended.",
        level: 1,
      }),
    ).toBeVisible();
    // The category is the eyebrow, and it is no longer duplicated in the H1.
    await expect(page.getByText("Electrolysis practice software").first()).toBeVisible();
    await expectNoPageOverflow(page, "homepage desktop");

    // Primary CTA is "Request …" (never "Book") and links to /demo. On this
    // page the header carries no copy of it, so the first is the opening's.
    const firstCta = page.getByRole("link", { name: "Request a walkthrough" }).first();
    await expect(firstCta).toBeVisible();
    expect(await firstCta.getAttribute("href")).toBe("/demo");
    await expect(page.getByText(/Book a walkthrough|Book the walkthrough/)).toHaveCount(0);

    // The deck's nine blocks, each by its heading, in the order they appear.
    for (const name of [
      "Before the client sits down",
      "Every area keeps its own history",
      "More than a note",
      "Know what was used, and when",
      "Your client records should stay yours.",
      "Simple plans, in Canadian dollars.",
      "See it with a returning client.",
    ]) {
      await expect(page.getByRole("heading", { name }), `missing: ${name}`).toBeVisible();
    }

    // The trust strip: four lines, one row, no heading.
    await expect(page.getByText("Records isolated by studio")).toBeVisible();
    await expect(
      page.getByText("Imported history stays marked as imported"),
    ).toBeVisible();

    // Signature product visual (anonymized demo data).
    await expect(page.getByText("Before today").first()).toBeVisible();
    await expect(page.getByText(/Maya R\./).first()).toBeVisible();

    // CAD pricing (not the old $19 pilot). No badge on any plan here — the
    // deck removed it from the homepage; /pricing owns plan emphasis.
    await expect(page.getByText("CAD $49")).toBeVisible();
    await expect(page.getByText("$19")).toHaveCount(0);

    // MKT-02D: NO TIER IS RECOMMENDED. This asserted "Most popular" was
    // VISIBLE. The badge is gone — along with the border, shadow and primary
    // CTA it drove — so the assertion is inverted rather than deleted: a
    // removed check would let the badge return without any browser-level
    // notice, which is the same gap that made this a required-suite failure in
    // the first place. #764 rebuilt this section and kept it badge-free; the
    // assertion still earns its place because nothing else would notice.
    await expect(page.getByText("Most popular")).toHaveCount(0);
    await expect(page.getByText(/recommended/i)).toHaveCount(0);

    // Ownership: evidence-backed claims + policy link. The export line names
    // its subset rather than claiming "full studio history" (TRUTH-01A).
    // #764's wording supersedes the old "Studio data stays isolated" line that
    // stood here; the claim moved, the check moves with it.
    await expect(page.getByText("Each studio's records are isolated")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Export your records as CSV, on every plan" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "privacy policy" })).toBeVisible();

    // Sign in reachable, links to /login.
    const signIn = page.getByRole("link", { name: "Sign in" }).first();
    await expect(signIn).toBeVisible();
    expect(await signIn.getAttribute("href")).toBe("/login");

    // The hero CTA navigates to the walkthrough page. Scoped to <main>, where
    // the request lives: this page's header carries no copy of it, and should
    // one come back, an unscoped .first() would click the HEADER and prove
    // nothing about the hero.
    await page
      .getByRole("main")
      .getByRole("link", { name: "Request a walkthrough" })
      .first()
      .click();
    await page.waitForURL(/\/demo/);
  });
});

// THE OPENING IS ONE ROW (MKT-03 revision 3). Revision 2 stacked the category,
// headline, sub and button in one left column: the right half of the first
// screen stood empty and the film began 506px down at 1440x900. On a desktop
// the category and headline now sit on the left, the sub and the one button on
// the right, the two sides sharing a bottom edge, and the film starts directly
// below, inside 280px. The header drops its own request on this page, so the
// opening holds the only one. On a phone the same four parts stack in reading
// order. Measured, not read from classes, at the four sizes it was judged at.
for (const vp of [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "short laptop", width: 1280, height: 720, mobile: false },
  { name: "wide desktop", width: 1920, height: 1080, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true },
]) {
  test.describe(`homepage opening (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile });

    test(
      vp.mobile
        ? "category, headline, sub and button stack in reading order, and the film follows inside the first screen"
        : "headline left, sub and the one button right on one bottom edge, and the film starts inside 280px",
      async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await page.evaluate(() => document.fonts.ready);
        const main = page.getByRole("main");
        const parts = {
          eyebrow: main.getByText("Electrolysis practice software").first(),
          h1: main.getByRole("heading", { level: 1 }),
          sub: main.getByText(/^Each treated area keeps its own history\./),
          cta: main.getByRole("link", { name: "Request a walkthrough" }).first(),
        };
        const box = async (l: (typeof parts)[keyof typeof parts]) => {
          const b = await l.boundingBox();
          expect(b, "an opening part has no box").not.toBeNull();
          return b!;
        };
        const [e, h, s, c] = [await box(parts.eyebrow), await box(parts.h1), await box(parts.sub), await box(parts.cta)];

        // The headline: leading with room for the glyphs everywhere, and on a
        // desktop 48-52px on no more than two lines.
        const type = await parts.h1.evaluate((el) => {
          const st = getComputedStyle(el);
          const size = parseFloat(st.fontSize);
          const lh = parseFloat(st.lineHeight);
          return { size, ratio: lh / size, lines: Math.round(el.getBoundingClientRect().height / lh) };
        });
        expect(type.ratio).toBeGreaterThanOrEqual(1.08);
        if (!vp.mobile) {
          expect(type.size).toBeGreaterThanOrEqual(48);
          expect(type.size).toBeLessThanOrEqual(52);
          expect(type.lines, "the headline wraps past two lines").toBeLessThanOrEqual(2);
        }

        // The category sits directly above the headline, and the button
        // directly under the sub, each pair on one left edge.
        expect(h.y).toBeGreaterThan(e.y + e.height - 1);
        expect(Math.abs(h.x - e.x)).toBeLessThan(2);
        expect(c.y).toBeGreaterThan(s.y + s.height - 1);
        expect(Math.abs(c.x - s.x)).toBeLessThan(2);

        if (vp.mobile) {
          // Stacked in reading order on one left edge, and the button is a
          // full-width target that meets the 44px floor (DESIGN LAW 5).
          expect(s.y).toBeGreaterThan(h.y + h.height - 1);
          expect(Math.abs(s.x - h.x)).toBeLessThan(2);
          expect(c.height).toBeGreaterThanOrEqual(44);
          expect(c.width).toBeGreaterThanOrEqual(s.width - 1);
        } else {
          // One row: the sub and button beside the headline, not under it,
          // and the two sides sharing a bottom edge.
          expect(s.x, "the sub is not beside the headline").toBeGreaterThan(h.x + h.width);
          expect(s.y, "the sub has dropped below the headline").toBeLessThan(h.y + h.height);
          expect(
            Math.abs(c.y + c.height - (h.y + h.height)),
            "the row's two sides do not share a bottom edge",
          ).toBeLessThan(3);
        }

        // The film follows directly, starts high, and shows the product: at
        // least half of it is in the first screen, which is also what starts it.
        const frameBox = await page.locator("main figure > div").first().boundingBox();
        expect(frameBox, "film frame has no box").not.toBeNull();
        const frame = frameBox!;
        const rowBottom = Math.max(c.y + c.height, h.y + h.height);
        expect(frame.y).toBeGreaterThan(rowBottom);
        expect(frame.y - rowBottom, "a gap opened between the opening and the film").toBeLessThanOrEqual(40);
        if (!vp.mobile) expect(frame.y, `the film starts ${frame.y}px down`).toBeLessThanOrEqual(280);
        const shown = (Math.min(frame.y + frame.height, vp.height) - frame.y) / frame.height;
        expect(shown, "less than half the film is in the first screen").toBeGreaterThanOrEqual(0.5);

        // ONE request in the opening, filled, and none in this page's header.
        expect(await parts.cta.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
        if (!vp.mobile) {
          await expect(page.getByRole("banner").getByRole("link", { name: "Request a walkthrough" })).toHaveCount(0);
        }
        const onFirstScreen = await page.getByRole("link", { name: "Request a walkthrough" }).evaluateAll(
          (els) =>
            els.filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && !el.closest("[inert]");
            }).length,
        );
        expect(onFirstScreen, "the first screen does not hold exactly one walkthrough request").toBe(1);
        await expectNoPageOverflow(page, `homepage opening (${vp.name})`);
      },
    );
  });
}

// THE HEADER DROPS ITS REQUEST ON THE HOMEPAGE ONLY. Everywhere else it is the
// way back to the request, so it must still be there.
test.describe("header request on the other pages (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("pricing, a feature page and the privacy policy keep the header's request", async ({ page }) => {
    for (const path of ["/pricing", "/features/treatment-memory", "/privacy"]) {
      await page.goto(path);
      const headerCta = page.getByRole("banner").getByRole("link", { name: "Request a walkthrough" });
      await expect(headerCta, `${path} lost the header's request`).toBeVisible();
      expect(await headerCta.getAttribute("href")).toBe("/demo");
      expect(await headerCta.evaluate((el) => getComputedStyle(el).backgroundColor), "the header button is filled").toBe(
        "rgba(0, 0, 0, 0)",
      );
    }
  });
});

test.describe("marketing homepage (mobile)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("fits the phone; menu exposes the CTA and sign in", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Start the next treatment where the last one ended.",
        level: 1,
      }),
    ).toBeVisible();
    await expectNoPageOverflow(page, "homepage mobile");

    // Product visual stacks under the copy and fits the phone.
    await expect(page.getByText("Before today").first()).toBeVisible();

    // The menu exposes the walkthrough CTA and Sign in.
    await page.getByRole("button", { name: "Menu" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: "Request a walkthrough" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expectNoPageOverflow(page, "homepage mobile menu open");
  });

  test("the menu takes focus, gives it back on Escape, and its links go where they say", async ({ page }) => {
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "Menu" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Site navigation" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

    // Closed is INERT, not merely faded: Playwright counts an opacity-0 element
    // as visible, and what matters is that nothing in it can be reached.
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveAttribute("inert", "");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();

    // Every target in the open menu meets the 44px floor (DESIGN LAW 5).
    await trigger.click();
    for (const link of await dialog.getByRole("link").all()) {
      const b = await link.boundingBox();
      expect(b!.height, `${await link.textContent()} is under 44px`).toBeGreaterThanOrEqual(44);
    }
    await dialog.getByRole("link", { name: "Pricing" }).click();
    await page.waitForURL(/\/pricing$/);
    await expect(page.getByRole("heading", { level: 1, name: "Simple plans, in Canadian dollars." })).toBeVisible();
  });
});
