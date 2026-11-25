import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsShell } from "@/components/settings/settings-shell";
import type { OverviewSection } from "@/lib/settings/overview";

const nav = vi.hoisted(() => ({ pathname: "/settings" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ href, children, ...rest }: Record<string, unknown>) =>
    createElement("a", { href, ...Object.fromEntries(Object.entries(rest).filter(([key]) => key !== "pendingLabel")) }, children as never),
}));

const sections: OverviewSection[] = [
  { name: "Booking & availability", links: [
    { label: "Booking link", href: "/settings/booking/link", keywords: "" },
    { label: "Booking window", href: "/settings/booking/window", keywords: "" },
  ] },
  { name: "My profile", links: [
    { label: "Personal details", href: "/settings/profile", keywords: "" },
  ] },
];

function render(pathname: string, visible = sections, reachable: {href: string; label: string}[] = []) {
  nav.pathname = pathname;
  const props = { sections: visible, reachable, studioName: "Test studio", roleLabel: "Practitioner", children: null };
  return renderToStaticMarkup(createElement(SettingsShell, props));
}

describe("Settings category navigation", () => {
  it("opens the first editor directly and marks the selected tab on a detail route", () => {
    const html = render("/settings/booking/window");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/settings\/booking\/window"[^>]*aria-current="page"/);
    expect(html).toMatch(/href="\/settings\/booking\/link"[^>]*aria-current="location"/);
    expect(html).toContain('aria-label="Settings sections"');
  });

  it("marks the overview as current without showing detail tabs", () => {
    const html = render("/settings");
    expect(html).toMatch(/href="\/settings"[^>]*aria-current="page"/);
    expect(html).not.toContain('aria-label="Settings sections"');
    expect(html).toContain("Test studio");
  });

  it("shows a reachable hidden route only when open and leaves unknown routes unselected", () => {
    const extra = [{ label: "Waitlist", href: "/settings/waitlist" }];
    expect(render("/settings/profile", sections, extra)).not.toContain("/settings/waitlist");
    expect(render("/settings/waitlist", sections, extra)).toMatch(/href="\/settings\/waitlist"[^>]*aria-current="page"/);
    const unknown = render("/settings/unknown");
    expect(unknown).not.toContain('aria-current="page"');
    expect(unknown).toContain('aria-label="Breadcrumb"');
  });

  it("renders only the role-visible groups and their destinations", () => {
    const html = render("/settings/profile", sections.slice(1));
    expect(html).toContain("Personal settings");
    expect(html).toContain("Personal details");
    expect(html).not.toContain("/settings/booking");
    expect(html).not.toContain(">Studio settings<");
  });
});
