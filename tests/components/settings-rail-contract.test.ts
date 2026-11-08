import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
/* eslint-disable react/no-children-prop */
import { describe, expect, it, vi } from "vitest";

// The rail's DOM CONTRACT (Sam, 2 Nov; agreed with Photos so the probe measures
// the right thing):
//   every rail link/button  data-rail-item=<id>  data-rail-kind=flat|group|child
//   data-rail-state         selected (the ONE aria-current item) | idle
//                           expanded | collapsed (groups only)
//   * a flat entry is its own selected item and has NO parent: there is nothing to
//     be "distinct from", so a parent-vs-selected probe does not apply to it;
//   * an expanded group is data-rail-state=expanded, never aria-current, never the
//     selected style (no fill, no accent bar, no heavier weight).

const nav = vi.hoisted(() => ({ pathname: "/settings/team" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ href, children, ...rest }: Record<string, unknown>) => {
    delete rest.pendingLabel;
    return createElement("a", { href, ...rest }, children as never);
  },
}));

import { SettingsShell } from "@/components/settings/settings-shell";
import type { SettingsNavItem } from "@/lib/settings/nav";

const items: SettingsNavItem[] = [
  { id: "profile", group: "personal", label: "Profile", href: "/settings/profile", base: "/settings/profile", children: [] },
  {
    id: "booking",
    group: "studio",
    label: "Booking",
    href: "/settings/booking/link",
    base: "/settings/booking",
    children: [
      { id: "booking-link", label: "Booking link", href: "/settings/booking/link" },
      { id: "booking-window", label: "Booking window", href: "/settings/booking/window" },
    ],
  },
  { id: "team", group: "studio", label: "Team", href: "/settings/team", base: "/settings/team", children: [] },
  { id: "data", group: "studio", label: "Data", href: "/settings/data", base: "/settings/data", children: [] },
];

function render(pathname: string) {
  nav.pathname = pathname;
  return renderToStaticMarkup(
    createElement(SettingsShell, { items, account: { name: "A", roleLabel: "Owner" }, children: null }, createElement("p", null, "x")),
  );
}
const tags = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[0]);
const railTags = (html: string) => tags(html, /<(?:a|button)\b[^>]*data-rail-item="[^"]+"[^>]*>/g);
const SELECTED_STYLE = /bg-neutral-100|font-medium|before:bg-neutral-900/;

describe("rail DOM contract: parent vs selected", () => {
  it("a flat route has exactly one selected item and NO parent element at all", () => {
    for (const route of ["/settings/team", "/settings/data", "/settings/profile"]) {
      const rail = railTags(render(route));
      const selected = rail.filter((t) => t.includes('data-rail-state="selected"'));
      expect(selected, route).toHaveLength(1);
      expect(selected[0]).toContain('aria-current="page"');
      expect(selected[0]).toContain('data-rail-kind="flat"');
      expect(rail.filter((t) => t.includes('data-rail-state="expanded"')), route).toHaveLength(0);
    }
  });

  it("a group route: one selected CHILD, one expanded PARENT, and the parent never takes the selected look", () => {
    const html = render("/settings/booking/window");
    const rail = railTags(html);
    const selected = rail.filter((t) => t.includes('data-rail-state="selected"'));
    const parent = rail.filter((t) => t.includes('data-rail-state="expanded"'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('data-rail-item="booking-window"');
    expect(selected[0]).toContain('data-rail-kind="child"');
    expect(selected[0]).toContain('aria-current="page"');
    expect(selected[0]).toMatch(SELECTED_STYLE);
    expect(parent).toHaveLength(1);
    expect(parent[0]).toContain('data-rail-kind="group"');
    expect(parent[0]).not.toContain("aria-current");
    expect(parent[0]).not.toMatch(SELECTED_STYLE);
    // Distinct, quieter: the parent has its own (text-colour only) style.
    expect(parent[0]).toContain("text-neutral-900");
    expect(parent[0]).not.toContain("text-neutral-700");
    expect(parent[0]).not.toEqual(selected[0]);
  });

  it("exactly one aria-current item on every route and no group is ever aria-current", () => {
    for (const route of ["/settings/profile", "/settings/booking/link", "/settings/booking/window", "/settings/team", "/settings/data"]) {
      const html = render(route);
      expect((html.match(/aria-current="page"/g) ?? []).filter(Boolean).length - (html.includes('<li aria-current="page">') ? 1 : 0), route).toBe(1);
      for (const t of railTags(html).filter((x) => x.includes('data-rail-kind="group"'))) expect(t).not.toContain("aria-current");
    }
  });

  it("a collapsed group is idle-styled and marked collapsed", () => {
    const rail = railTags(render("/settings/team"));
    const group = rail.find((t) => t.includes('data-rail-kind="group"'))!;
    expect(group).toContain('data-rail-state="collapsed"');
    expect(group).toContain("text-neutral-700");
  });
});
