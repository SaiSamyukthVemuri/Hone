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
const ACCOUNT = read("app/(app)/AccountMenu.tsx");
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
    // PR #231: Getting Started joins the account actions; the
    // profile/studio/role block sits at the top of the panel.
    expect(MENU).toContain('"/getting-started"');
    expect(MENU).toMatch(/role === "owner" \? "Owner" : "Practitioner"/);
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

describe("desktop account dropdown (PR #231)", () => {
  it("is a client dropdown with the same dismissal model as the mobile menu", () => {
    expect(ACCOUNT).toMatch(/"use client"/);
    expect(ACCOUNT).toMatch(/aria-label="Open account menu"/);
    expect(ACCOUNT).toMatch(/aria-expanded=\{open\}/);
    expect(ACCOUNT).toMatch(/e\.key === "Escape"/);
    expect(ACCOUNT).toMatch(/!rootRef\.current\.contains\(e\.target as Node\)/);
    expect(ACCOUNT).toMatch(/onClick=\{close\}/);
  });

  it("contains the account destinations, the profile block, and Sign out", () => {
    expect(ACCOUNT).toContain('"/settings/profile"');
    expect(ACCOUNT).toContain('"/getting-started"');
    expect(ACCOUNT).toMatch(/form action=\{signOut\}/);
    expect(ACCOUNT).toMatch(/Sign out/);
    expect(ACCOUNT).toMatch(/\{studioName\} · \{roleLabel\}/);
  });

  it("the primary nav row is the four working surfaces; Settings/Admin moved into the dropdown", () => {
    const navRow = LAYOUT.slice(LAYOUT.indexOf("<nav"), LAYOUT.indexOf("</nav>"));
    for (const dest of ['"/dashboard"', '"/clients"', '"/calendar"', '"/records"']) {
      expect(navRow).toContain(dest);
    }
    expect(navRow).not.toContain('"/settings/profile"');
    expect(navRow).not.toContain('"/admin"');
    expect(LAYOUT).toMatch(/<AccountMenu/);
  });
});

describe("Daily Prep Brief V1 (PR #241)", () => {
  it("the card wraps cleanly on phones (no nowrap, no fixed widths)", () => {
    const CARD = read("app/(app)/dashboard/daily-prep-brief.tsx");
    expect((CARD.match(/break-words/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(CARD).not.toMatch(/whitespace-nowrap|w-\[\d/);
  });

  it("the e2e specs assert the brief renders with recorded memory", () => {
    expect(read("e2e/mobile-ux.spec.ts")).toMatch(/Daily prep brief/);
    expect(read("e2e/core-memory-loop.spec.ts")).toMatch(/Daily prep brief/);
  });
});

describe("Before Today hierarchy (PR #237)", () => {
  it("chips wrap and long notes break instead of overflowing on phones", () => {
    const CARD = read("components/before-today-card.tsx");
    expect(CARD).toMatch(/flex flex-wrap gap-1\.5/);
    expect((CARD.match(/break-words/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(CARD).toMatch(/whitespace-pre-wrap break-words/);
    // No fixed widths or nowrap that could push the client page wide.
    expect(CARD).not.toMatch(/whitespace-nowrap|w-\[\d/);
  });

  it("the e2e mobile spec checks the card and overflow on the client page", () => {
    const spec = read("e2e/mobile-ux.spec.ts");
    expect(spec).toMatch(/Remember today/);
    expect(spec).toMatch(/client page Before Today/);
  });
});

describe("mobile charting comfort (PR #235)", () => {
  it("the risks/aftercare stamp is markable on the session page via the SAME action", () => {
    const SESSION_PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
    expect(SESSION_PAGE).toMatch(/Risks &amp; aftercare/);
    expect(SESSION_PAGE).toMatch(/<AftercareExplainedToggle/);
    expect(SESSION_PAGE).toMatch(/action=\{markAftercareExplainedAction\}/);
    // No new write path: the records action is reused as-is.
    expect(SESSION_PAGE).toMatch(/from "@\/app\/\(app\)\/records\/actions"/);
  });

  it("side chips are comfortable touch targets", () => {
    const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
    expect(FORM).toMatch(/rounded-full border px-3 py-1\.5 text-xs/);
    expect(FORM).not.toMatch(/rounded-full border px-2\.5 py-1 text-xs/);
  });

  it("the e2e mobile spec charts at phone width", () => {
    const spec = read("e2e/mobile-ux.spec.ts");
    expect(spec).toMatch(/mobile charting: comfortable and complete at 390px/);
    expect(spec).toMatch(/iPad charting page/);
  });
});

describe("mobile sheets (PR #234)", () => {
  it("mobile search and menu panels are viewport-fixed sheets, not icon-anchored dropdowns", () => {
    const SEARCH = read("app/(app)/GlobalSearch.tsx");
    expect(SEARCH).toMatch(/fixed inset-x-3 top-16 z-40 max-h-\[75vh\]/);
    expect(SEARCH).not.toMatch(/absolute right-0 top-full[^"]*w-\[calc\(100vw/);
    expect(MENU).toMatch(/fixed inset-x-3 top-16 z-40/);
    expect(MENU).not.toMatch(/absolute right-0 z-40 mt-2 flex w-60/);
  });

  it("a long email is never the bold menu headline", () => {
    expect(MENU).toMatch(/displayName\.includes\("@"\) \? "My account" : displayName/);
  });

  it("no profile/logo upload was introduced", () => {
    const LAYOUT_ALL = LAYOUT + MENU + read("app/(app)/AccountMenu.tsx");
    expect(LAYOUT_ALL).not.toMatch(/upload|avatar|profile.photo/i);
  });
});

describe("client page mobile polish (PR #233)", () => {
  it("tabs: select on phones (PR #238), contained one-row scroller on md+, never a wrapping grid", () => {
    const TABBAR = read("components/profile-tab-bar.tsx");
    // PR #238 (Chloe pilot): the phone scroller moved under the
    // finger and felt unstable; phones get a native select instead.
    expect(TABBAR).toMatch(/<select/);
    expect(TABBAR).toMatch(/md:hidden/);
    // md+ keeps the underlined row, hidden on phones.
    expect(TABBAR).toMatch(/hidden gap-x-5 overflow-x-auto whitespace-nowrap/);
    expect(TABBAR).toMatch(/md:flex/);
    expect(TABBAR).not.toMatch(/flex-wrap/);
  });

  it("client header is compact on phones with paired actions", () => {
    const CLIENT_PAGE = read("app/(app)/clients/[id]/page.tsx");
    expect(CLIENT_PAGE).toMatch(/text-2xl font-semibold tracking-tight md:text-3xl/);
    // Actions sit together in one row (stacked on phones).
    expect(CLIENT_PAGE).toMatch(/flex flex-col gap-2 sm:flex-row sm:items-center/);
    expect(CLIENT_PAGE).toMatch(/\+ Log session/);
    expect(CLIENT_PAGE).toMatch(/<BookAppointment/);
    // The oversized centered button + detached booking block are gone.
    expect(CLIENT_PAGE).not.toMatch(/px-5 py-3 text-base font-medium text-white/);
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
    // PR B: the wrapper is now height-bounded and scrolls INTERNALLY on both
    // axes (max-h + overflow-y-auto + overflow-x-auto), so the calendar body
    // scrolls inside its card instead of forcing the whole page to scroll. The
    // grid rows keep a phone min-width so days stay readable.
    expect(CALENDAR_PAGE).toMatch(
      /max-h-\[calc\(100dvh-13rem\)\] overflow-x-auto overflow-y-auto rounded-xl/,
    );
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
    expect(spec).toMatch(/desktop: header nav, account dropdown, wordmark, drag-create/);
    expect(spec).toMatch(/iPad: calendar fits and touch drag stays inert/);
  });
});
