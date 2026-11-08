import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: (p: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: p.href, className: p.className }, p.children as never),
}));
const { ContactSidebar } = await import("@/app/(app)/clients/[id]/_profile/ContactSidebar");

type Props = Parameters<typeof ContactSidebar>[0];
const html = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(createElement(ContactSidebar, { clientId: "c1", phone: null, email: null, address: null, ...over }));

describe("the contact column", () => {
  it("phone and email are real tel:/mailto: links; address is plain text; Edit goes to the edit page", () => {
    const out = html({ phone: "(416) 555-0142", email: "a@example.test", address: "1 Main St\nToronto" });
    expect(out).toContain('href="tel:4165550142"');
    expect(out).toContain('href="mailto:a@example.test"');
    expect(out).toContain("1 Main St");
    expect(out).toContain('href="/clients/c1/edit"');
    expect(out).toContain('data-testid="client-profile-contact"');
  });
  it("a missing value is absent, and an empty contact says so", () => {
    expect(html({ phone: "5551234567" })).not.toContain("mailto:");
    expect(html()).toContain("Not recorded");
  });
  it("controls meet the 44px touch floor on phones", () => {
    expect(html({ phone: "5551234567", email: "a@example.test" })).toMatch(/min-h-\[44px\]/);
  });
});

describe("the page puts the contact column beside every tab and the header keeps no duplicate", () => {
  const PAGE = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
  it("one two-column layout after the tab bar wraps all tab blocks", () => {
    const bar = PAGE.indexOf("<ProfileTabBar");
    const layout = PAGE.indexOf('data-testid="profile-layout"');
    const overview = PAGE.indexOf('{activeTab === "overview" && (');
    expect(bar).toBeGreaterThan(-1);
    expect(layout).toBeGreaterThan(bar);
    expect(overview).toBeGreaterThan(layout);
    expect(PAGE).toMatch(/md:grid-cols-\[206px_minmax\(0,1fr\)\]/);
  });
  it("the header no longer repeats phone and email, and carries its test id", () => {
    const header = PAGE.slice(PAGE.indexOf('data-testid="client-profile-header"'), PAGE.indexOf("<ProfileTabBar"));
    expect(header).not.toMatch(/client\.phone|client\.email/);
    expect(header).toContain("client-profile-avatar");
  });
});
