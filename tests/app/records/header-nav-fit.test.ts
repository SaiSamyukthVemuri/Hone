import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// PR #209: header navigation fit. Nav label shortened to "Records"
// (route and page heading unchanged) + whitespace-nowrap on the nav
// so labels never split mid-word after Dashboard joined the header.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const LAYOUT = read("app/(app)/layout.tsx");
const RECORDS_PAGE = read("app/(app)/records/page.tsx");

// THE BREAKPOINT CONTRACT — compact shell below 1024px, full desktop from
// 1024px — is pinned ONCE, in tests/app/mobile-ux.test.ts ("EVERY header-mode
// class switches at lg"). It is deliberately not restated here: a pin copied
// into a second file is how this repository previously ended up sweeping 18
// files for one change. The browser proof of the same contract, width by
// width, is the matrix in e2e/owner-practice-capacity.spec.ts.
describe("header fit", () => {
  it("nav links cannot wrap mid-label", () => {
    // `[^>]*` rather than a literal `<nav className=`: the primary nav now
    // also carries an accessible name, and the ORIGINAL regex pinned attribute
    // ADJACENCY, not the property this test is about. It would have gone red on
    // an aria-label — a strictly better nav — while a nav that genuinely lost
    // whitespace-nowrap could still have satisfied it by keeping the class
    // first. This matches the opening tag however its attributes are ordered.
    expect(LAYOUT).toMatch(/<nav[^>]*className="[^"]*whitespace-nowrap[^"]*"/);
  });

  it("the two nav landmarks are individually named", () => {
    // Two <nav> elements exist in the authenticated shell. Unlabelled, a screen
    // reader announces "navigation" twice with nothing to tell them apart; it
    // is also what let a browser test bind to a nav by DOM position rather than
    // by which navigation it actually is.
    expect(LAYOUT).toMatch(/aria-label="Primary navigation"/);
    expect(read("app/(app)/MobileMenu.tsx")).toMatch(
      /aria-label="Mobile navigation"/,
    );
  });

  it("the Records nav item renders the short label to /records", () => {
    expect(LAYOUT).toMatch(/href="\/records"[\s\S]{0,200}>\s*Records\s*<\/Link>/);
    // The long label no longer renders in the header (it remains in
    // the explanatory comment only).
    expect(LAYOUT).not.toMatch(/>\s*Record Keeping\s*<\/Link>/);
  });

  it("the page heading still says Record Keeping", () => {
    expect(RECORDS_PAGE).toMatch(/>\s*\n?\s*Record Keeping\s*\n?\s*<\/h1>/);
  });

  it("Dashboard, Settings, Admin, account, and sign out remain reachable", () => {
    // PR #231 moved Settings/Admin/Sign out from the layout's nav row
    // into the account dropdown (desktop) and the account section of
    // the mobile menu; Dashboard stays in the primary nav. The
    // destinations remain reachable, just from the menu components.
    const ACCOUNT = read("app/(app)/AccountMenu.tsx");
    const MOBILE = read("app/(app)/MobileMenu.tsx");
    expect(LAYOUT).toMatch(/>\s*Dashboard\s*</);
    expect(LAYOUT).toMatch(/<AccountMenu/);
    for (const menu of [ACCOUNT, MOBILE]) {
      expect(menu).toContain('"/settings/profile"');
      expect(menu).toMatch(/Admin/);
      expect(menu).toMatch(/Sign out/);
    }
  });

  it("Business is an OWNER-ONLY nav entry on both breakpoints, to /business", () => {
    // OWNER-CAP follow-up, RETARGETED BY FIN-01A. The destination moved from
    // /dashboard/capacity to /business: this entry pointed straight at capacity
    // while capacity was the ONLY owner surface, and a hub in front of one
    // destination is a click that buys nothing. Financials makes it two, so the
    // word now has somewhere of its own to mean — and the assertion that no
    // /business hub existed, which was correct when written, is inverted here
    // rather than deleted.
    //
    // Everything else this test guarded is UNCHANGED and still guarded: the
    // entry is role-gated on both surfaces, the route is linked exactly once
    // so an unconditional link cannot slip in, and the role still comes from
    // the lookup the shell already performed.
    const MOBILE = read("app/(app)/MobileMenu.tsx");
    expect(LAYOUT).toMatch(
      /\{practitioner\.role === "owner" && \(\s*<Link\s+href="\/business"[\s\S]{0,200}>\s*Business\s*<\/Link>/,
    );
    expect(MOBILE).toMatch(
      /role === "owner"\s*\?\s*\[\{ href: "\/business", label: "Business" \}\]/,
    );
    // UNCONDITIONAL would be the defect, so assert the gate is the ONLY way
    // either file mentions the route: exactly one occurrence each, and both
    // inside the role branches pinned above.
    for (const [name, src] of [
      ["layout", LAYOUT],
      ["mobile menu", MOBILE],
    ] as const) {
      expect(
        src.match(/"\/business"/g)?.length,
        `${name} must link the owner surface exactly once`,
      ).toBe(1);
    }
    // The header no longer reaches capacity directly — it is reached THROUGH
    // Business, by the shared subnav.
    for (const [name, src] of [
      ["layout", LAYOUT],
      ["mobile menu", MOBILE],
    ] as const) {
      expect(src.match(/"\/dashboard\/capacity"/g) ?? [], name).toEqual([]);
    }
    // The hub now exists, and it is owner-gated in its own right.
    expect(existsSync(join(process.cwd(), "app/(app)/business"))).toBe(true);
    // ...and the role came from data the shell already had. A second
    // practitioner/role lookup in the layout would be the extra query this
    // change promised not to add.
    expect(LAYOUT.match(/requirePractitionerWithStudio\(\)/g)?.length).toBe(1);
    expect(LAYOUT).not.toMatch(/getCurrentPractitioner\b/);
  });

  it("the header stays hidden in print mode for the print/export views", () => {
    expect(LAYOUT).toMatch(/<header className="[^"]*print:hidden[^"]*"/);
  });
});
