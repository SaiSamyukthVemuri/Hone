import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capResults,
  escapeIlike,
  sanitizeQuery,
  groupResults,
  statusForQuery,
  NAV_RESULT_CAP,
  SEARCH_RESULT_CAP,
  SEARCH_TOTAL_CAP,
  type SearchResult,
} from "@/lib/search/global-search";

// PR #232: Global Search V1. Pure helpers tested directly; the
// action and component are source-pinned below (behavior also runs
// in the browser lane).
//
// V2-A: the page-shortcut list became the permission-aware navigation
// registry. Its own behaviour (matching, aliases, visibility, href validity,
// coverage tripwire) lives in tests/lib/search/navigation-registry.test.ts;
// what stays HERE is the shared result plumbing — grouping and the caps.

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
      "Settings & Pages",
    ]);
    const many = Array.from({ length: 30 }, (_, i) => result("client", i));
    const total = groupResults(many).reduce((n, g) => n + g.results.length, 0);
    expect(total).toBe(SEARCH_TOTAL_CAP);
  });
});

// ---------------------------------------------------------------------------
// V2-A: the two caps are independent, so neither category can starve the other
// ---------------------------------------------------------------------------

describe("result caps", () => {
  it("data results keep the V1 budget regardless of how many nav rows match", () => {
    const flat = [
      ...Array.from({ length: 30 }, (_, i) => result("client", i)),
      ...Array.from({ length: 30 }, (_, i) => result("page", i)),
    ];
    const capped = capResults(flat);
    expect(capped.filter((r) => r.type === "client")).toHaveLength(
      SEARCH_TOTAL_CAP,
    );
    expect(capped.filter((r) => r.type === "page")).toHaveLength(
      NAV_RESULT_CAP,
    );
    expect(capped).toHaveLength(SEARCH_RESULT_CAP);
  });

  it("a settings answer survives a data-rich query (the V1 starvation bug)", () => {
    // In V1 page shortcuts were appended LAST into one shared cap of 12, so a
    // query matching twelve clients dropped every page result on the floor.
    // A practitioner typing "consent" while a client is called "Consentino"
    // must still be offered the consent SETTING.
    const flat = [
      ...Array.from({ length: 20 }, (_, i) => result("client", i)),
      result("page", 1),
    ];
    const capped = capResults(flat);
    expect(capped.some((r) => r.type === "page")).toBe(true);
  });

  it("data results are never displaced by navigation results", () => {
    const flat = [
      ...Array.from({ length: 4 }, (_, i) => result("page", i)),
      ...Array.from({ length: 12 }, (_, i) => result("client", i)),
    ];
    const capped = capResults(flat);
    expect(capped.filter((r) => r.type === "client")).toHaveLength(12);
  });

  it("is deterministic and idempotent", () => {
    const flat = [
      ...Array.from({ length: 20 }, (_, i) => result("client", i)),
      ...Array.from({ length: 20 }, (_, i) => result("page", i)),
    ];
    const once = capResults(flat);
    expect(capResults(flat)).toEqual(once);
    expect(capResults(once)).toEqual(once);
    // Order within a category is exactly the producer's order, so the same
    // input always yields the same visible rows — the first NAV_RESULT_CAP
    // navigation rows the producer emitted, never an arbitrary subset.
    expect(once.filter((r) => r.type === "page").map((r) => r.id)).toEqual(
      Array.from({ length: NAV_RESULT_CAP }, (_, i) => `page:${i}`),
    );
  });
});

describe("pure helpers (continued)", () => {

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
      // `entry.href` is the ONE indirection allowed here: it comes from the
      // static navigation registry, whose every href is proved app-internal,
      // literal and route-resolvable by
      // tests/lib/search/navigation-registry.test.ts. Every other href in
      // this file must still be a visible leading-slash literal.
      expect(h).toMatch(/href: (`\/|"\/|lot\s*$|lot\n|entry\.href)/);
      expect(h).not.toMatch(/https?:/);
    }
  });

  it("short queries answer with navigation shortcuts, not database scans", () => {
    expect(ACTION).toMatch(
      /query\.length < SEARCH_MIN_CHARS[\s\S]{0,400}navResults\("", navContext\)/,
    );
    // ...and the Supabase client is only created AFTER that early return.
    expect(ACTION.indexOf("await createClient()")).toBeGreaterThan(
      ACTION.indexOf('navResults("", navContext)'),
    );
  });

  it("navigation visibility is derived server-side, never accepted as input", () => {
    // The action takes exactly one parameter — the query string. Role and
    // feature flags come from the resolved session, so no caller can ask to
    // be treated as an owner.
    expect(ACTION).toMatch(
      /export async function globalSearchAction\(\s*rawQuery: string,\s*\)/,
    );
    expect(ACTION).toMatch(/isOwner: practitioner\?\.role === "owner"/);
    expect(ACTION).toMatch(
      /googleCalendarEnabled: studio\.google_calendar_connection_enabled === true/,
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
