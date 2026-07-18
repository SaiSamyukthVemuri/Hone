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
    expect(SECTIONS).toMatch(/export function FeatureGrid/);
    expect(SECTIONS).toMatch(/export function WorkflowGrid/);
    // Feature matrix uses column dividers + a title min-height for aligned rows.
    expect(SECTIONS).toMatch(/border-l/);
    expect(SECTIONS).toMatch(/min-h-\[/);
  });
  it("feature pages use the shared FeatureGrid; homepage uses WorkflowGrid", () => {
    for (const f of [
      "app/features/treatment-memory/page.tsx",
      "app/features/booking-calendar/page.tsx",
      "app/features/charting-records/page.tsx",
    ]) {
      expect(read(f)).toMatch(/<FeatureGrid items=/);
    }
    expect(read("app/page.tsx")).toMatch(/<WorkflowGrid steps=/);
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
