import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  escapeIlike,
  sanitizeQuery,
  filterPageShortcuts,
  groupResults,
  statusForQuery,
  SEARCH_TOTAL_CAP,
  type SearchResult,
} from "@/lib/search/global-search";

// PR #232: Global Search V1. Pure helpers tested directly; the
// action and component are source-pinned below (behavior also runs
// in the browser lane).

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const ACTION = read("app/(app)/global-search-actions.ts");
const COMPONENT = read("app/(app)/GlobalSearch.tsx");
const LAYOUT = read("app/(app)/layout.tsx");

function result(type: SearchResult["type"], n: number): SearchResult {
  return { id: `${type}:${n}`, type, title: `t${n}`, href: "/x" };
}

describe("pure helpers", () => {
  it("escapeIlike makes %, _, and backslash literal", () => {
    expect(escapeIlike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });

  it("sanitizeQuery trims and caps length", () => {
    expect(sanitizeQuery("  chin  ")).toBe("chin");
    expect(sanitizeQuery("x".repeat(200)).length).toBe(80);
  });

  it("page shortcuts: all six on empty, filtered on text, no exposure shortcut", () => {
    const all = filterPageShortcuts("");
    expect(all.map((r) => r.title)).toEqual([
      "Dashboard",
      "Clients",
      "Calendar",
      "Records",
      "Settings",
      "Getting Started",
    ]);
    expect(filterPageShortcuts("gett").map((r) => r.title)).toEqual([
      "Getting Started",
    ]);
    expect(all.some((r) => /exposure/i.test(r.title))).toBe(false);
    for (const r of all) expect(r.href.startsWith("/")).toBe(true);
  });

  it("groupResults preserves category order, drops empty groups, caps the total", () => {
    const flat = [
      result("page", 1),
      result("client", 1),
      result("memory", 1),
      result("client", 2),
    ];
    const groups = groupResults(flat);
    expect(groups.map((g) => g.label)).toEqual([
      "Clients",
      "Treatment Memory",
      "Pages",
    ]);
    const many = Array.from({ length: 30 }, (_, i) => result("client", i));
    const total = groupResults(many).reduce((n, g) => n + g.results.length, 0);
    expect(total).toBe(SEARCH_TOTAL_CAP);
  });

  it("statusForQuery maps status keywords and rejects noise", () => {
    expect(statusForQuery("no sh")).toBe("no_show");
    expect(statusForQuery("comp")).toBe("completed");
    expect(statusForQuery("cancel")).toBe("cancelled");
    expect(statusForQuery("x")).toBeNull();
    expect(statusForQuery("zzz")).toBeNull();
  });
});

describe("server action posture (source pins)", () => {
  it("authenticated, studio-scoped, user-scoped client only", () => {
    expect(ACTION).toMatch(/"use server"/);
    expect(ACTION).toMatch(/getCurrentPractitionerWithStudio\(\)/);
    expect(ACTION).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(ACTION).not.toMatch(/admin-server|createAdminClient|service_role/);
    const scoped = ACTION.match(/\.eq\("studio_id", studioId\)/g) ?? [];
    expect(scoped.length).toBeGreaterThanOrEqual(8);
  });

  it("sensitive surfaces are excluded from V1", () => {
    for (const banned of [
      "record_keeping_exposure_incidents",
      "record_keeping_audit_events",
      "payment_charge_attempts",
      "manual_fee_charge_attempts",
      "stripe_",
      "cancellation_token",
      "calendar_feed_token",
      "client_portal_magic_links",
    ]) {
      expect(ACTION, `action must not touch ${banned}`).not.toContain(banned);
    }
  });

  it("every result href is app-internal", () => {
    const hrefs = ACTION.match(/href: [^\n]+/g) ?? [];
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      expect(h).toMatch(/href: (`\/|"\/|lot\s*$|lot\n)/);
      expect(h).not.toMatch(/https?:/);
    }
  });

  it("short queries answer with page shortcuts, not database scans", () => {
    expect(ACTION).toMatch(
      /query\.length < SEARCH_MIN_CHARS[\s\S]{0,120}filterPageShortcuts\(""\)/,
    );
  });
});

describe("component + header wiring (source pins)", () => {
  it("search closes on Escape, outside pointerdown, and result click", () => {
    expect(COMPONENT).toMatch(/e\.key === "Escape"/);
    expect(COMPONENT).toMatch(/!rootRef\.current\.contains\(e\.target as Node\)/);
    expect(COMPONENT).toMatch(/onClick=\{close\}/);
  });

  it("accessible names and debounce exist", () => {
    expect(COMPONENT).toMatch(/aria-label="Search Hone"/);
    expect(COMPONENT).toMatch(/setTimeout/);
    expect(COMPONENT).toMatch(/250/);
    expect(COMPONENT).toMatch(/No results found\./);
  });

  it("both header variants are rendered in the authenticated layout", () => {
    expect(LAYOUT).toMatch(/<GlobalSearch variant="desktop" \/>/);
    expect(LAYOUT).toMatch(/<GlobalSearch variant="mobile" \/>/);
  });
});
