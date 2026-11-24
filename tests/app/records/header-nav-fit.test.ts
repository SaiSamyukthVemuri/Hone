import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// PR #209: header navigation fit. Nav label shortened to "Records"
// (route and page heading unchanged) + whitespace-nowrap on the nav
// so labels never split mid-word after Dashboard joined the header.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

// The header's right-hand controls moved out of layout.tsx into HeaderCluster.tsx (HON-40 shell step 0): the shell
// is the two files together.
const LAYOUT = read("app/(app)/layout.tsx") + "\n" + read("app/(app)/HeaderCluster.tsx");
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
    // NAV-ACK-02: bound to the ANCHOR, not to its tag name or to a character
    // distance. This read `href="/records"[\s\S]{0,200}>\s*Records\s*</Link>`,
    // which pinned two things nobody meant to freeze: that the element is
    // spelled `Link`, and that its href sits within 200 characters of its
    // label. Giving the tab its acknowledgement changed both, and the guard
    // failed on a change that does exactly what it asks for.
    //
    // The label, and the route it points at, are the properties. Located by
    // href and read to its own closing tag, so the element may be renamed and
    // may grow attributes — and an item relabelled or repointed still fails.
    const item = LAYOUT.match(
      /<(\w+)[^>]*href="\/records"[^>]*>([\s\S]*?)<\/\1>/,
    );
    expect(item).not.toBeNull();
    expect(item![2].trim()).toBe("Records");
    // The long label no longer renders in the header (it remains in
    // the explanatory comment only).
    expect(item![2]).not.toMatch(/Record Keeping/);
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
      expect(menu).toContain('"/settings"');
      expect(menu).toMatch(/Admin/);
      expect(menu).toMatch(/Sign out/);
    }
  });

  it("Business is an OWNER-ONLY menu on both breakpoints, listing Capacity, Statements and Analytics", () => {
    // OWNER-CAP follow-up, extended for the monthly statement. The browser spec proves what an owner and a practitioner each
    // actually SEE; this is the cheap source-level pin that the menu is role-gated at all, on both surfaces, and that both
    // surfaces take their destinations from ONE shared list. There is no /business hub.
    const MOBILE = read("app/(app)/MobileMenu.tsx");
    const LIST = read("lib/nav/business-menu.ts");
    expect(LAYOUT).toMatch(/\{practitioner\.role === "owner" && <BusinessMenu \/>\}/);
    expect(MOBILE).toMatch(/role === "owner" && \(\s*<div role="group"[\s\S]*?BUSINESS_MENU_ITEMS\.map/);
    expect(LIST).toContain('href: "/dashboard/capacity", label: "Capacity"');
    expect(LIST).toContain('href: "/financials/statement", label: "Statements"');
    expect(LIST).toContain('href: "/financials/analytics", label: "Analytics"');
    // UNCONDITIONAL would be the defect: neither shell file may name either route outside the gated branch, so neither names it at all.
    for (const [name, src] of [
      ["layout", LAYOUT],
      ["mobile menu", MOBILE],
    ] as const) {
      expect(src, `${name} must take the routes from the shared list`).not.toMatch(/"\/dashboard\/capacity"|"\/financials\/statement"|"\/financials\/analytics"/);
    }
    // No /business hub was invented to hold it.
    expect(existsSync(join(process.cwd(), "app/(app)/business"))).toBe(false);
    // ...and the role came from data the shell already had. A second practitioner/role lookup in the layout would be the extra
    // query this change promised not to add.
    expect(LAYOUT.match(/requirePractitionerWithStudio\(\)/g)?.length).toBe(1);
    expect(LAYOUT).not.toMatch(/getCurrentPractitioner\b/);
  });

  it("the header stays hidden in print mode for the print/export views", () => {
    expect(LAYOUT).toMatch(/<header className="[^"]*print:hidden[^"]*"/);
  });
});
