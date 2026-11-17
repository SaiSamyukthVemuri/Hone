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

describe("the profile header name", () => {
  const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
  it("breaks an unbroken long word anywhere, so it never widens the page (HON-69)", () => {
    const h1 = page.match(/<h1 className="([^"]*)"/)?.[1] ?? "";
    expect(h1).toContain("[overflow-wrap:anywhere]");
    expect(h1).toContain("min-w-0");
    // break-words alone (overflow-wrap: break-word) does not shrink a flex item's minimum width
    expect(h1).not.toMatch(/(^|\s)break-words(\s|$)/);
  });
  it("the layout comment states where the contact card sits on phones", () => {
    expect(page).not.toContain("stacked above the content on phones");
    expect(page).toContain("the tab's content comes first and the contact card follows it");
  });
  it("the contact card's real class string puts it last on phones and in DOM order from md up", () => {
    const aside = readFileSync("app/(app)/clients/[id]/_profile/ContactSidebar.tsx", "utf8").match(/<aside[\s\S]*?>/)?.[0] ?? "";
    expect(aside).toMatch(/className="[^"]*\border-last\b[^"]*"/);
    expect(aside).toMatch(/className="[^"]*\bmd:order-none\b[^"]*"/);
  });
});

describe("every paragraph on a profile tab that prints the client's name breaks an unbroken long word (HON-69)", () => {
  // Photos measured the Overview and Billing tabs scrolling sideways at 390 with a 105-character single word: the consent paragraph ("Forms <name> has
  // signed...") ran 684px. The same name is printed by the payment-card (Billing) and portal-messages paragraphs. Each must carry the rule the header has.
  const ON_PROFILE_TABS = ["components/consent-signatures-card.tsx", "components/payment-method-card.tsx", "components/portal-messages-card.tsx"];
  // Components that print {clientName} but are dialogs or other pages, not profile tabs (they are not in the page this PR measures).
  const NOT_A_PROFILE_TAB = ["components/quick-checkout-modal.tsx", "components/waitlist/decline-follow-up-section.tsx", "components/appointment/postcare-section.tsx", "components/client-form.tsx"];
  const paragraphsPrintingName = (src: string) => [...src.matchAll(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?\{clientName\}(?:(?!<\/p>)[\s\S])*?<\/p>/g)].map((m) => m[0]);

  it("the scan sees paragraphs in each pinned component (not vacuous)", () => {
    for (const f of ON_PROFILE_TABS) expect(paragraphsPrintingName(readFileSync(f, "utf8")).length, f).toBeGreaterThan(0);
  });
  it("each such paragraph has min-w-0 and [overflow-wrap:anywhere]", () => {
    for (const f of ON_PROFILE_TABS) {
      for (const p of paragraphsPrintingName(readFileSync(f, "utf8"))) {
        expect(p, f).toContain("[overflow-wrap:anywhere]");
        expect(p, f).toContain("min-w-0");
      }
    }
  });
  it("no OTHER component prints {clientName} in a paragraph without being listed, so a new one cannot slip in unwrapped", async () => {
    const { readdirSync } = await import("node:fs");
    const all = ["components", "components/appointment", "components/waitlist"].flatMap((d) => readdirSync(d).filter((x) => x.endsWith(".tsx")).map((x) => `${d}/${x}`));
    const printing = all.filter((f) => paragraphsPrintingName(readFileSync(f, "utf8")).length > 0);
    const unlisted = printing.filter((f) => !ON_PROFILE_TABS.includes(f) && !NOT_A_PROFILE_TAB.includes(f));
    expect(unlisted).toEqual([]);
  });
});
