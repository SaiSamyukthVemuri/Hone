import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUSINESS_MENU_ITEMS, BUSINESS_MENU_LABEL, isBusinessPath } from "@/lib/nav/business-menu";
import { matchNavEntries, NAV_ENTRIES, NON_SEARCHABLE_ROUTES, type NavSearchContext } from "@/lib/search/navigation-registry";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// The owner's Business menu: Capacity, Statements and Analytics. Presentation only; the pages keep their own owner checks.

describe("the Business menu's destinations", () => {
  it("has exactly four items, in order: Overview, Capacity, Statements, then Analytics, each pointing at its existing page", () => {
    expect(BUSINESS_MENU_LABEL).toBe("Business");
    expect(BUSINESS_MENU_ITEMS.map((i) => [i.label, i.href])).toEqual([
      ["Overview", "/financials/overview"],
      ["Capacity", "/dashboard/capacity"],
      ["Statements", "/financials/statement"],
      ["Analytics", "/financials/analytics"],
    ]);
  });

  it("the menu reads as current on each page and its subtree, and on nothing else", () => {
    expect(isBusinessPath("/financials/overview")).toBe(true);
    expect(isBusinessPath("/financials/overview-archive")).toBe(false);
    expect(isBusinessPath("/dashboard/capacity")).toBe(true);
    expect(isBusinessPath("/dashboard/capacity/")).toBe(true);
    expect(isBusinessPath("/financials/statement")).toBe(true);
    expect(isBusinessPath("/financials/analytics")).toBe(true);
    expect(isBusinessPath("/financials/analytics/")).toBe(true);
    expect(isBusinessPath("/financials/analytics/clients")).toBe(true);
    expect(isBusinessPath("/financials/analytics/print")).toBe(true);
    expect(isBusinessPath("/financials/analytics-archive")).toBe(false);
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

  it("the phone sheet lists the same items for the owner role only, with a Business heading", () => {
    const mobile = read("app/(app)/MobileMenu.tsx");
    expect(mobile).toMatch(/BUSINESS_MENU_ITEMS\.map\(\(item\) => workItem\(item, true\)\)/);
    // The heading labels a real group (role=group + aria-labelledby), rendered only for the owner role.
    expect(mobile).toMatch(/role === "owner" && \(\s*<div role="group" aria-labelledby="mobile-nav-business-heading"/);
    expect(mobile).toContain('id="mobile-nav-business-heading"');
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
  it("closes when focus leaves it, and is keyed to the path it was opened on", () => {
    expect(menu).toContain("onBlur=");
    // ...but NOT by the click itself for another page: that would unmount the link carrying its "Opening…" mark. The mounted test
    // (business-menu-mounted.test.ts) pins the behaviour; this pins that the open state is keyed to the path it was opened on.
    expect(menu).toContain("openedOn === pathname");
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
