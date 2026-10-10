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

    // Primary CTA is "Request …" (never "Book") and links to /demo.
    const headerCta = page.getByRole("link", { name: "Request a walkthrough" }).first();
    await expect(headerCta).toBeVisible();
    expect(await headerCta.getAttribute("href")).toBe("/demo");
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

    // The hero CTA navigates to the walkthrough page. Scoped to <main>: v2.2
    // drops the duration from the label, so the hero and the sticky header now
    // share one accessible name and an unscoped .first() would click the
    // HEADER and prove nothing about the hero.
    await page
      .getByRole("main")
      .getByRole("link", { name: "Request a walkthrough" })
      .first()
      .click();
    await page.waitForURL(/\/demo/);
  });
});

// THE OPENING IS ONE GROUP (MKT-03 revision 2). Revision 1 split the headline
// from its sub and button into two desktop columns, under a header that carried
// a second filled copy of the same button. Measured, not read from classes: the
// four parts stack in reading order on one left edge, the film follows directly,
// and the header's request is the quiet outline.
for (const vp of [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "short laptop", width: 1280, height: 720, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true },
]) {
  test.describe(`homepage opening (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile });

    test("category, headline, sub and the one filled button read as one group, film directly below", async ({ page }) => {
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
      // Reading order, top to bottom, with no part beside another.
      expect(h.y).toBeGreaterThan(e.y + e.height - 1);
      expect(s.y).toBeGreaterThan(h.y + h.height - 1);
      expect(c.y).toBeGreaterThan(s.y + s.height - 1);
      // One left edge.
      for (const b of [h, s, c]) expect(Math.abs(b.x - e.x), "the opening is not one column").toBeLessThan(2);

      // Leading leaves room for the glyphs: at least 1.05x the font size.
      const lh = await parts.h1.evaluate((el) => {
        const st = getComputedStyle(el);
        return parseFloat(st.lineHeight) / parseFloat(st.fontSize);
      });
      expect(lh).toBeGreaterThanOrEqual(1.05);

      // The film follows the group directly and starts inside the first screen.
      const frame = await page.locator("main figure").first().boundingBox();
      expect(frame, "film frame has no box").not.toBeNull();
      expect(frame!.y).toBeGreaterThan(c.y + c.height);
      expect(frame!.y, "the film does not start in the first screen").toBeLessThan(vp.height);

      // The hero's request is filled; the header's (desktop) is the quiet outline.
      const filled = (l: typeof parts.cta) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(await filled(parts.cta)).not.toBe("rgba(0, 0, 0, 0)");
      if (!vp.mobile) {
        const headerCta = page.getByRole("banner").getByRole("link", { name: "Request a walkthrough" });
        await expect(headerCta).toBeVisible();
        expect(await filled(headerCta), "the header button is filled").toBe("rgba(0, 0, 0, 0)");
        expect(await headerCta.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
      }
    });
  });
}

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
