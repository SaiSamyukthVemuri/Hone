import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIMARY_NAV } from "@/lib/marketing/content";

// Guards the desktop design system: a shared fluid width shell, denser aligned
// grids (feature matrix + workflow), a properly-behaved Product dropdown, and no
// regressions (no min-h-screen on ordinary sections, no scroll-gated reveal, no
// animated SVG dash, no duplicate nav).

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const GLOBALS = read("app/globals.css");
const PRIMITIVES = read("app/_components/marketing/primitives.tsx");
const SECTIONS = read("app/_components/marketing/sections.tsx");
const PRODUCT_MENU = read("app/_components/marketing/ProductMenu.tsx");
const REVEAL = read("app/_components/marketing/Reveal.tsx");
const PANEL = read("app/_components/marketing/visuals/TreatmentMemoryPanel.tsx");

const PAGE_FILES = [
  "app/page.tsx",
  "app/pricing/page.tsx",
  "app/demo/page.tsx",
  "app/electrolysis-software/page.tsx",
  "app/features/treatment-memory/page.tsx",
  "app/features/booking-calendar/page.tsx",
  "app/features/charting-records/page.tsx",
  "app/resources/page.tsx",
  "app/resources/electrolysis-treatment-record-checklist/page.tsx",
  "app/resources/moving-an-electrolysis-practice-from-paper-records/page.tsx",
];

describe("shared desktop width shell", () => {
  it("globals define one fluid shell + a reading shell", () => {
    expect(GLOBALS).toMatch(/\.mk-shell\s*\{/);
    expect(GLOBALS).toMatch(/\.mk-shell-reading\s*\{/);
    expect(GLOBALS).toMatch(/width:\s*min\(/);
  });
  it("Container uses the shared shells (no scattered max-w on the container)", () => {
    expect(PRIMITIVES).toMatch(/mk-shell-reading/);
    expect(PRIMITIVES).toMatch(/["'`]mk-shell["'`]|mk-shell\}|mk-shell /);
  });
});

describe("section density / no reserved blank space", () => {
  it("Section has no min-height or viewport-height units", () => {
    const section = PRIMITIVES.slice(PRIMITIVES.indexOf("export function Section"), PRIMITIVES.indexOf("export function Eyebrow"));
    expect(section).not.toMatch(/min-h/);
    expect(section).not.toMatch(/vh\]/);
  });
  it("no marketing page pins min-h-screen or vh on ordinary sections", () => {
    for (const f of PAGE_FILES) {
      const src = read(f);
      expect(src, `${f}: min-h-screen`).not.toMatch(/min-h-screen/);
      expect(src, `${f}: vh height`).not.toMatch(/min-h-\[[^\]]*vh/);
    }
  });
});

describe("desktop grids", () => {
  it("sections export the feature matrix + workflow grid", () => {
    expect(SECTIONS).toMatch(/export function FeatureMatrix/);
    expect(SECTIONS).toMatch(/export function WorkflowGrid/);
    // Feature matrix uses column dividers + a title min-height for aligned rows.
    expect(SECTIONS).toMatch(/border-l/);
    expect(SECTIONS).toMatch(/min-h-\[/);
  });

  it("the shared matrix supports optional eyebrow, body and link (aligned at bottom)", () => {
    expect(SECTIONS).toMatch(/eyebrow\?:/);
    expect(SECTIONS).toMatch(/body\?:/);
    expect(SECTIONS).toMatch(/link\?:/);
    // Optional link renders and pins to the bottom of the cell.
    expect(SECTIONS).toMatch(/it\.link/);
    expect(SECTIONS).toMatch(/mt-auto/);
  });

  it("every capability grid uses the shared FeatureMatrix", () => {
    for (const f of [
      "app/features/treatment-memory/page.tsx",
      "app/features/booking-calendar/page.tsx",
      "app/features/charting-records/page.tsx",
      "app/page.tsx", // homepage "What Hone covers"
      "app/electrolysis-software/page.tsx", // pillar "What it manages"
    ]) {
      expect(read(f), `${f}: uses FeatureMatrix`).toMatch(/<FeatureMatrix\b/);
      expect(read(f), `${f}: no legacy FeatureGrid`).not.toMatch(/FeatureGrid/);
    }
    expect(read("app/page.tsx")).toMatch(/<WorkflowGrid steps=/);
  });

  it("the pillar matrix preserves its capability links + accessible names", () => {
    const pillar = read("app/electrolysis-software/page.tsx");
    // The matrix is fed from MANAGES with title/body/link mapped from href+link.
    expect(pillar).toMatch(/link:\s*m\.href && m\.link \? \{ href: m\.href, label: m\.link \}/);
    // The linked feature routes are still referenced in MANAGES.
    expect(pillar).toMatch(/\/features\/treatment-memory/);
    expect(pillar).toMatch(/\/features\/booking-calendar/);
    expect(pillar).toMatch(/\/features\/charting-records/);
  });
});

describe("workflow editorial split", () => {
  it("the heading runs across the top, and the calendar and steps share the row beneath it", () => {
    // MKT-03 retired the narrow intro column: a five-line heading stood over
    // the calendar, and that column ran taller than the steps beside it. The
    // heading now spans the shell and the split sits under it, level.
    const page = read("app/page.tsx");
    const at = page.indexOf('id="how-hone-works"');
    expect(at, "workflow section not found").toBeGreaterThan(-1);
    const section = page.slice(at, page.indexOf("</Section>", at));
    expect(section).toMatch(/<Title className="max-w-\[24ch\] lg:max-w-none">/);
    expect(section).toMatch(/lg:grid-cols-\[minmax\(18rem,0\.75fr\)_minmax\(0,1\.6fr\)\]/);
    // The heading precedes the split, so it can never become one of its columns.
    expect(section.indexOf("<Title")).toBeLessThan(section.indexOf("lg:grid-cols-["));
    expect(section).toMatch(/<CalendarPreview \/>/);
    expect(section).toMatch(/<WorkflowGrid steps=/);
  });
  it("WorkflowGrid is a 2-column numbered sequence, not a 3-col matrix", () => {
    const start = SECTIONS.indexOf("export function WorkflowGrid");
    const wf = SECTIONS.slice(start, SECTIONS.indexOf("export function", start + 1));
    expect(wf).toMatch(/sm:grid-cols-2/);
    expect(wf).not.toMatch(/lg:grid-cols-3/);
    // An ordered list, because the order is real; a teal step number and one
    // hairline per step; no fixed title height stretching the grid taller than
    // what it says; no animated connector.
    expect(wf).toMatch(/<ol\b/);
    expect(wf).toMatch(/text-mineral/);
    expect(wf).toMatch(/border-t/);
    expect(wf).not.toMatch(/min-h-\[/);
    expect(wf).not.toMatch(/svg|stroke|IntersectionObserver/i);
  });
});

describe("one type scale, with room for the glyphs (MKT-03 revision 2)", () => {
  // The H1 was 64-72px at a 1.02 line height: Instrument Sans' ascenders and
  // descenders nearly met between lines, and each page opened at its own size.
  const px = (rem: string) => parseFloat(rem) * 16;
  const clampOf = (key: string) => {
    const m = PRIMITIVES.match(new RegExp(`${key}:\\s*"clamp\\(([\\d.]+)rem,[^,]+,\\s*([\\d.]+)rem\\)"`));
    expect(m, `TYPE_SCALE.${key} is not a rem clamp`).not.toBeNull();
    return { min: px(m![1]), max: px(m![2]) };
  };

  it("the H1 runs about 34px on a phone to 52px on a desktop", () => {
    const d = clampOf("display");
    expect(d.min).toBeGreaterThanOrEqual(34);
    expect(d.min).toBeLessThanOrEqual(40);
    expect(d.max).toBeGreaterThanOrEqual(48);
    expect(d.max).toBeLessThanOrEqual(52);
  });

  // REVISION 3: 48-52px ON EVERY DESKTOP WIDTH THE OPENING IS JUDGED AT. At 58px
  // the homepage headline needed most of the shell for two lines, so nothing
  // could sit beside it. Evaluated from the clamp itself, at each width, rather
  // than from its two ends: the ends alone cannot say what 1280 gets.
  it("the H1 is 48-52px at 1280, 1440 and 1920", () => {
    const m = PRIMITIVES.match(
      /display:\s*"clamp\(([\d.]+)rem,\s*([\d.]+)rem\s*\+\s*([\d.]+)vw,\s*([\d.]+)rem\)"/,
    );
    expect(m, "TYPE_SCALE.display is not clamp(Xrem, Yrem + Zvw, Wrem)").not.toBeNull();
    const [min, base, vw, max] = m!.slice(1).map(Number);
    const at = (width: number) => Math.min(Math.max(min * 16, base * 16 + (vw * width) / 100), max * 16);
    for (const width of [1280, 1440, 1920]) {
      expect(at(width), `H1 at ${width}px`).toBeGreaterThanOrEqual(48);
      expect(at(width), `H1 at ${width}px`).toBeLessThanOrEqual(52);
    }
    expect(at(390), "H1 on a phone").toBeGreaterThanOrEqual(34);
  });

  it("headings sit below the H1 and above the body", () => {
    expect(clampOf("title").max).toBeLessThan(clampOf("display").max);
    expect(clampOf("subtitle").max).toBeLessThan(clampOf("title").min);
  });

  it("every heading primitive leaves line height for its glyphs", () => {
    const heights = [...PRIMITIVES.matchAll(/lineHeight:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(heights.length, "no lineHeight found — vacuous").toBeGreaterThanOrEqual(4);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(1.05);
  });

  it("no page sizes its own H1: Display takes no size", () => {
    expect(PRIMITIVES).not.toMatch(/size === "compact"/);
    for (const f of PAGE_FILES) {
      expect(read(f), `${f}: Display with a size`).not.toMatch(/<Display[^>]*\bsize=/);
    }
  });
});

describe("one filled button per view", () => {
  it("the header's walkthrough request is the quiet outline, not a second filled button", () => {
    const header = read("app/_components/marketing/SiteHeader.tsx");
    const cta = header.slice(header.indexOf("<CTAButton"), header.indexOf("</CTAButton>"));
    expect(cta, "the header renders no CTAButton").not.toBe("");
    expect(cta).toMatch(/variant="outline"/);
    expect(cta).toMatch(/WALKTHROUGH\.href/);
    expect(header).not.toMatch(/bg-mineral/);
    // Opaque: at 95% the page's headings showed through the bar on scroll.
    expect(header).toMatch(/sticky top-0[^"]*\bbg-paper\b(?!\/)/);
  });

  // REVISION 3. The homepage's opening row carries the request a few hundred
  // pixels below the header, so the header drops its copy there, and only
  // there: on every other page the header's request is the way back to it.
  it("only the homepage turns the header's request off", () => {
    const header = read("app/_components/marketing/SiteHeader.tsx");
    expect(header).toMatch(/export function SiteHeader\(\{ cta = true \}/);
    expect(header).toMatch(/\{cta \? \(\s*<CTAButton/);
    expect(read("app/page.tsx")).toMatch(/<SiteHeader cta=\{false\} \/>/);
    const others = [...PAGE_FILES.filter((p) => p !== "app/page.tsx"), "app/_components/PolicyLayout.tsx"];
    for (const f of others) {
      const src = read(f);
      expect(src, `${f} no longer renders the marketing header — re-derive this list`).toMatch(/<SiteHeader\b/);
      expect(src, `${f} turns the header's request off`).not.toMatch(/<SiteHeader[^>]*cta=/);
    }
  });

  it("focus is an outline on every CTA, never a box-shadow ring (DESIGN LAW 6)", () => {
    const cta = PRIMITIVES.slice(PRIMITIVES.indexOf("export function CTAButton"));
    expect(cta).toMatch(/focus-visible:outline-2/);
    expect(cta).not.toMatch(/focus-visible:ring|outline-none/);
  });
});

describe("Product dropdown behavior", () => {
  it("closes on route change, outside click, Escape, and selection; returns focus", () => {
    expect(PRODUCT_MENU).toMatch(/usePathname/); // route change
    expect(PRODUCT_MENU).toMatch(/setOpen\(false\)/);
    expect(PRODUCT_MENU).toMatch(/mousedown/); // outside click
    expect(PRODUCT_MENU).toMatch(/"Escape"/);
    expect(PRODUCT_MENU).toMatch(/btnRef\.current\?\.focus\(\)/); // focus return
    expect(PRODUCT_MENU).toMatch(/hidden=\{!open\}/); // removed from focus order when closed
    expect(PRODUCT_MENU).toMatch(/onClick=\{\(\) => setOpen\(false\)\}/); // close on select
  });
  it("the header no longer uses a native <details> dropdown", () => {
    expect(read("app/_components/marketing/SiteHeader.tsx")).not.toMatch(/<details/);
    expect(read("app/_components/marketing/SiteHeader.tsx")).toMatch(/<ProductMenu \/>/);
  });
});

describe("no animation regressions", () => {
  it("no scroll-gated reveal or hidden-by-default content", () => {
    expect(REVEAL).not.toMatch(/IntersectionObserver/);
    expect(REVEAL).not.toMatch(/data-mreveal/);
    expect(GLOBALS).not.toMatch(/\[data-mreveal="0"\][^{]*\{[^}]*opacity:\s*0/);
  });
  it("no animated SVG dash paths", () => {
    expect(GLOBALS).not.toMatch(/stroke-dashoffset/);
    expect(PANEL).not.toMatch(/stroke-dasharray|data-thread/);
  });
});

describe("navigation", () => {
  it("has no duplicate top-level Treatment memory (it lives in the Product menu)", () => {
    expect(PRIMARY_NAV.filter((i) => i.label === "Treatment memory").length).toBe(0);
    expect(PRIMARY_NAV.some((i) => i.label === "Product")).toBe(true);
  });
});
