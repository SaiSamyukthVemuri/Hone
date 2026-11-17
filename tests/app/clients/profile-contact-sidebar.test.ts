import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

describe("every paragraph, heading and link that prints the client's name breaks an unbroken long word (HON-69)", () => {
  // Photos measured the Overview and Billing tabs scrolling sideways at 390 with a 105-character single word. The same name is printed by many elements:
  // the tab cards (components/), and the pages under clients/[id] (images, intake, assisted intake, new session, edit, clinical-notes print). The scan reads
  // every .tsx file under components/ (all sub-folders) and app/(app)/clients/[id]/, so a NEW element that prints the name unwrapped fails here with no list
  // to remember. Stated bound: the scan matches <p>, <h1>-<h3>, <Link> and <PendingLink> whose OWN text (no nested tag) contains one of the name expressions below (including a clientDisplayName(...) call, which is what the edit page's back link prints), comment lines ignored; a name
  // printed inside a <span>/<div>, or through a differently named variable, would escape it.
  const NAME = String.raw`\{(?:clientName|clientDisplay|client\.name|data\.client\.name|c\.name|d\.clientName|clientDisplayName\((?:[^{}]|\{[^{}]*\})*\))\}`;
  const ELEMENT = new RegExp(String.raw`<(p|h1|h2|h3|Link|PendingLink)\b([^>]*)>([^<]*?${NAME}[^<]*)<\/\1>`, "g");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const f = `${dir}/${e}`;
      if (statSync(f).isDirectory()) walk(f, out);
      else if (f.endsWith(".tsx")) out.push(f);
    }
    return out;
  };
  const FILES = [...walk("components"), ...walk("app/(app)/clients/[id]")];
  const hits = FILES.flatMap((f) => [...readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").matchAll(ELEMENT)].map((m) => ({ f, tag: m[1], attrs: m[2] })));

  it("the scan reaches the pinned files (not vacuous)", () => {
    const files = new Set(hits.map((h) => h.f));
    for (const f of ["components/consent-signatures-card.tsx", "components/payment-method-card.tsx", "components/portal-messages-card.tsx", "app/(app)/clients/[id]/page.tsx", "app/(app)/clients/[id]/intake/page.tsx", "app/(app)/clients/[id]/sessions/new/page.tsx", "app/(app)/clients/[id]/edit/page.tsx", "components/client-form.tsx"]) {
      expect(files.has(f), f).toBe(true);
    }
    expect(hits.length).toBeGreaterThanOrEqual(12);
  });
  it("every such element carries min-w-0 and [overflow-wrap:anywhere] in its own className", () => {
    const missing = hits.filter((h) => !(h.attrs.includes("[overflow-wrap:anywhere]") && h.attrs.includes("min-w-0"))).map((h) => `${h.f} <${h.tag}>`);
    expect(missing).toEqual([]);
  });
});
