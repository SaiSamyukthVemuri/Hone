import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #228: mobile/iPad UX stabilization pins. The behavior is proven
// by the browser lane (e2e/mobile-ux.spec.ts); these pins keep the
// load-bearing source properties from regressing in the fast lane.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const LAYOUT = read("app/(app)/layout.tsx");
const MENU = read("app/(app)/MobileMenu.tsx");
const DAY_COLUMN = read("app/(app)/calendar/DayColumn.tsx");
const CALENDAR_PAGE = read("app/(app)/calendar/page.tsx");
const GLOBALS = read("app/globals.css");

describe("app shell: responsive navigation", () => {
  it("the full nav row is desktop-only (hidden below md)", () => {
    expect(LAYOUT).toMatch(
      /<nav className="hidden items-center gap-0\.5 whitespace-nowrap text-sm md:flex/,
    );
  });

  it("the mobile menu is a client component with an accessible, stateful button", () => {
    expect(MENU).toMatch(/"use client"/);
    expect(MENU).toMatch(/aria-label="Open navigation menu"/);
    expect(MENU).toMatch(/aria-expanded=\{open\}/);
    expect(MENU).toMatch(/aria-label="Mobile navigation"/);
  });

  it("the mobile menu contains every destination plus Sign out, and closes on tap", () => {
    for (const dest of [
      '"/dashboard"',
      '"/clients"',
      '"/calendar"',
      '"/records"',
      '"/settings/profile"',
    ]) {
      expect(MENU).toContain(dest);
    }
    // Notifications moved to the header bell (PR #229).
    expect(MENU).not.toContain('"/notifications"');
    expect(MENU).toMatch(/Sign out/);
    expect(MENU).toMatch(/form action=\{signOut\}/);
    // PR #229: every link tap closes the menu; Escape closes too.
    expect(MENU).toMatch(/onClick=\{close\}/);
    expect(MENU).toMatch(/e\.key === "Escape"/);
    // PR #230: outside taps dismiss; the listener exists only while
    // the menu is open and checks containment against the root.
    expect(MENU).toMatch(/if \(!open\) return;[\s\S]*?onPointerDown/);
    expect(MENU).toMatch(/!rootRef\.current\.contains\(e\.target as Node\)/);
    expect(MENU).toMatch(/removeEventListener\("pointerdown", onPointerDown\)/);
  });

  it("the wordmark is an accessible Dashboard link (PR #230)", () => {
    expect(LAYOUT).toMatch(/aria-label="Go to Dashboard"/);
    expect(LAYOUT).toMatch(/href="\/dashboard"[\s\S]{0,200}Hone/);
  });

  it("the notifications bell carries the destination and the unread count", () => {
    expect(LAYOUT).toMatch(/function NotificationsBell/);
    expect(LAYOUT).toMatch(/Notifications, \$\{unread\} unread/);
    expect(LAYOUT).toMatch(/href="\/notifications"/);
    // Bell renders in BOTH the desktop group and the mobile group.
    expect((LAYOUT.match(/<NotificationsBell unread=\{unreadNotifications\} \/>/g) ?? []).length).toBe(2);
    // The old full-width Notifications tab is gone from the nav row.
    const navRow = LAYOUT.slice(LAYOUT.indexOf("<nav"), LAYOUT.indexOf("</nav>"));
    expect(navRow).not.toContain('"/notifications"');
  });

  it("no page-wide overflow-x-hidden band-aid was added", () => {
    expect(LAYOUT).not.toMatch(/overflow-x-hidden|overflow-x:\s*hidden/);
    expect(GLOBALS).not.toMatch(/overflow-x:\s*hidden/);
  });
});

describe("calendar touch safety", () => {
  it("drag/click-create is mouse-only at the pointer handler", () => {
    expect(DAY_COLUMN).toMatch(
      /if \(e\.pointerType !== "mouse"\) return;\s*\n\s*if \(e\.button !== 0\) return;/,
    );
  });

  it("the grid no longer blocks touch scrolling (touchAction is not none)", () => {
    expect(DAY_COLUMN).toMatch(/touchAction: "manipulation"/);
    expect(DAY_COLUMN).not.toMatch(/touchAction: "none"/);
  });

  it("touch devices get an explicit, coarse-pointer-only create button", () => {
    expect(DAY_COLUMN).toMatch(/aria-label=\{`Book on \$\{date\}`\}/);
    expect(DAY_COLUMN).toMatch(/\[@media\(pointer:coarse\)\]:flex/);
    expect(DAY_COLUMN).toMatch(/onClick=\{\(\) => openDraftAtY\(0\)\}/);
  });

  it("the week grid scrolls inside its own card on phones, not page-wide", () => {
    // The wrapper keeps overflow-x-auto; the grid rows get a phone
    // min-width so days stay readable instead of being chopped.
    expect(CALENDAR_PAGE).toMatch(/overflow-x-auto rounded-xl/);
    const gridCount = (
      CALENDAR_PAGE.match(
        /min-w-\[760px\] grid-cols-\[60px_repeat\(7,_minmax\(0,1fr\)\)\] md:min-w-0/g,
      ) ?? []
    ).length;
    expect(gridCount).toBe(2);
  });

  it("booking business rules and persistence are untouched", () => {
    // The interaction-layer change must not have touched the actions.
    expect(DAY_COLUMN).not.toMatch(/createAppointment|insert into/i);
  });
});

describe("e2e coverage exists for the mobile behavior", () => {
  it("the mobile spec asserts overflow, menu, touch inertness, and explicit create", () => {
    const spec = read("e2e/mobile-ux.spec.ts");
    expect(spec).toMatch(/scrollWidth/);
    expect(spec).toMatch(/Mobile navigation/);
    expect(spec).toMatch(/touch tap on empty grid does nothing/);
    expect(spec).toMatch(/touch drag does not open create flow/);
    expect(spec).toMatch(/explicit \+ Book button is the deliberate create path/);
    expect(spec).toMatch(/desktop: mouse drag-create still works/);
    expect(spec).toMatch(/iPad: calendar fits and touch drag stays inert/);
  });
});
