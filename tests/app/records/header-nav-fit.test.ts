import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #209: header navigation fit. Nav label shortened to "Records"
// (route and page heading unchanged) + whitespace-nowrap on the nav
// so labels never split mid-word after Dashboard joined the header.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const LAYOUT = read("app/(app)/layout.tsx");
const RECORDS_PAGE = read("app/(app)/records/page.tsx");

describe("header fit", () => {
  it("nav links cannot wrap mid-label", () => {
    expect(LAYOUT).toMatch(/<nav className="[^"]*whitespace-nowrap[^"]*"/);
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

  it("the header stays hidden in print mode for the print/export views", () => {
    expect(LAYOUT).toMatch(/<header className="[^"]*print:hidden[^"]*"/);
  });
});
