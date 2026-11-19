import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUSINESS_MENU_ITEMS, BUSINESS_MENU_LABEL, isBusinessPath } from "@/lib/nav/business-menu";
import { matchNavEntries, NAV_ENTRIES, NON_SEARCHABLE_ROUTES, type NavSearchContext } from "@/lib/search/navigation-registry";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// The owner's Business menu: Capacity and Monthly statement. Presentation only; the pages keep their own owner checks.

describe("the Business menu's destinations", () => {
  it("has exactly two items, in order: Capacity, then Monthly statement, each pointing at its existing page", () => {
    expect(BUSINESS_MENU_LABEL).toBe("Business");
    expect(BUSINESS_MENU_ITEMS.map((i) => [i.label, i.href])).toEqual([
      ["Capacity", "/dashboard/capacity"],
      ["Monthly statement", "/financials/statement"],
    ]);
  });

  it("the menu reads as current on either page and its subtree, and on nothing else", () => {
    expect(isBusinessPath("/dashboard/capacity")).toBe(true);
    expect(isBusinessPath("/dashboard/capacity/")).toBe(true);
    expect(isBusinessPath("/financials/statement")).toBe(true);
    expect(isBusinessPath("/dashboard")).toBe(false);
    expect(isBusinessPath("/financials")).toBe(false);
    expect(isBusinessPath("/financials/statement-archive")).toBe(false);
    expect(isBusinessPath(null)).toBe(false);
  });
});

describe("who sees the menu (presentation only)", () => {
  it("the desktop shell renders it for the owner role only, from the role it already resolved", () => {
    const layout = read("app/(app)/layout.tsx");
    expect(layout).toMatch(/\{practitioner\.role === "owner" && <BusinessMenu \/>\}/);
    expect(layout.match(/<BusinessMenu/g)).toHaveLength(1);
  });

  it("the phone sheet lists the same two items for the owner role only, with a Business heading", () => {
    const mobile = read("app/(app)/MobileMenu.tsx");
    expect(mobile).toMatch(/role === "owner"\s*\?\s*BUSINESS_MENU_ITEMS\.map/);
    expect(mobile).toContain("groupHeading: n === 0 ? BUSINESS_MENU_LABEL : undefined");
    // A practitioner's branch is the empty array: no Business item of any kind.
    expect(mobile).toMatch(/BUSINESS_MENU_ITEMS\.map[\s\S]*?:\s*\[\]\)/);
  });

  it("the page's own server-side owner check is untouched and still comes before any read", () => {
    const page = read("app/(app)/financials/statement/page.tsx");
    expect(page).toContain('practitioner.role !== "owner"');
    expect(page.indexOf('practitioner.role !== "owner"')).toBeLessThan(page.indexOf("await searchParams"));
  });
});

describe("the desktop menu is keyboard accessible", () => {
  const menu = read("app/(app)/BusinessMenu.tsx");
  it("is a real button with aria-expanded, that Escape closes and returns focus from", () => {
    expect(menu).toMatch(/<button[\s\S]*?type="button"/);
    expect(menu).toContain("aria-expanded={open}");
    expect(menu).toContain('e.key === "Escape"');
    expect(menu).toContain("buttonRef.current?.focus()");
  });
  it("closes when focus leaves it and when a link is chosen", () => {
    expect(menu).toContain("onBlur=");
    expect(menu).toContain("onClick={() => setOpen(false)}");
  });
  it("links with ordinary anchors in tab order (no roving tabindex, no div links)", () => {
    expect(menu).not.toContain("tabIndex");
    expect(menu).toContain("<PendingLink");
  });
});

describe("global search advertises the statement to owners only", () => {
  const OWNER: NavSearchContext = { isOwner: true, googleCalendarEnabled: false };
  const PRACTITIONER: NavSearchContext = { isOwner: false, googleCalendarEnabled: false };

  it("is a real owner-only navigation entry, registered like Capacity, and no longer listed as unadvertised", () => {
    const entry = NAV_ENTRIES.find((e) => e.href === "/financials/statement");
    expect(entry?.visibility).toBe("owner");
    expect(entry?.category).toBe("Navigation");
    expect(NAV_ENTRIES.find((e) => e.href === "/dashboard/capacity")?.visibility).toBe("owner");
    expect(NON_SEARCHABLE_ROUTES.some((r) => r.route === "/financials/statement")).toBe(false);
    // /financials itself (no money question yet) stays unadvertised.
    expect(NON_SEARCHABLE_ROUTES.some((r) => r.route === "/financials")).toBe(true);
  });

  it("an owner finds it by name; a practitioner finds nothing for the same words", () => {
    expect(matchNavEntries("monthly statement", OWNER).some((m) => m.entry.href === "/financials/statement")).toBe(true);
    for (const q of ["monthly statement", "statement", "money statement", "month end"]) {
      expect(matchNavEntries(q, PRACTITIONER).some((m) => m.entry.href === "/financials/statement"), q).toBe(false);
    }
  });
});
