import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/booking/new-client-admission", () => ({ getNewClientAdmissionMode: vi.fn() }));
vi.mock("@/lib/booking/new-client-waitlist-durability-bridge", () => ({
  newClientWaitlistCommitIsDurable: vi.fn(),
}));
vi.mock("@/lib/waitlist/operator-queue-presence", () => ({ hasActiveWaitlistEntries: vi.fn() }));

import { SETTINGS_NAV } from "@/lib/settings/nav-registry";
import {
  activeSettingsLocation,
  currentSettingsRailId,
  type SettingsNavItem,
} from "@/lib/settings/nav";

// The FULL rail an owner can see: every registry entry and every child, with no
// visibleWhen filtering (a hidden entry cannot be current, so the full map is the
// strictest case for "exactly one").
const items: SettingsNavItem[] = SETTINGS_NAV.map((e) => ({
  id: e.id,
  group: e.group,
  label: e.label,
  href: e.children?.[0]?.href ?? e.href,
  base: e.href,
  children: (e.children ?? []).map((c) => ({ id: c.id, label: c.label, href: c.href })),
}));

// Every selectable rail id: a child, or a flat entry.
const selectable = items.flatMap((i) => (i.children.length ? i.children.map((c) => c.id) : [i.id]));

const routes = items.flatMap((i) => (i.children.length ? i.children.map((c) => c.href) : [i.href]));

describe("exactly one current rail item per route (Sam's walkthrough, 1 Nov)", () => {
  it("the rail has no duplicate ids or hrefs, so a route can only match one entry", () => {
    expect(new Set(selectable).size).toBe(selectable.length);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it.each(routes)("%s selects its own item and no other", (route) => {
    const current = currentSettingsRailId(items, route);
    expect(current).not.toBeNull();
    const owners = items.flatMap((i) =>
      i.children.length
        ? i.children.filter((c) => c.href === route).map((c) => c.id)
        : i.href === route
          ? [i.id]
          : [],
    );
    expect(owners).toEqual([current]);
    // The ids that would take aria-current in the rail, counted the way the shell renders them.
    const marked = selectable.filter((id) => id === current);
    expect(marked).toHaveLength(1);
  });

  it("/settings/data selects Data and never Booking", () => {
    expect(currentSettingsRailId(items, "/settings/data")).toBe("data");
    expect(activeSettingsLocation(items, "/settings/data")?.item.id).toBe("data");
  });

  it("Google Calendar selects itself and never Text-message setup", () => {
    expect(currentSettingsRailId(items, "/settings/integrations/google-calendar")).toBe(
      "integrations-google",
    );
    expect(currentSettingsRailId(items, "/settings/integrations/text-messaging")).toBe(
      "integrations-sms",
    );
  });

  it("a return URL under a group selects no item (the group opens, nothing is selected)", () => {
    expect(currentSettingsRailId(items, "/settings/payments/return")).toBeNull();
    expect(activeSettingsLocation(items, "/settings/payments/return")?.item.id).toBe("payments");
  });

  it("a sub-route of a view keeps that view selected", () => {
    expect(currentSettingsRailId(items, "/settings/payments/fees/extra")).toBe("payments-fees");
  });

  it("a route outside the rail selects nothing", () => {
    expect(currentSettingsRailId(items, "/settings/unknown")).toBeNull();
    expect(currentSettingsRailId(items, "/dashboard")).toBeNull();
  });

  it("a flat entry's name is not a prefix trap for another (Data vs Booking, Import vs Integrations)", () => {
    for (const flat of items.filter((i) => i.children.length === 0)) {
      expect(currentSettingsRailId(items, flat.href)).toBe(flat.id);
    }
  });
});
