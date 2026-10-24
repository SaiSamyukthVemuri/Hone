import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

// RECORDS-SECTION-RECOVERY. After #1095 every record-keeping loader refuses a
// failed read with a fixed message. These cases pin how far that refusal may
// reach:
//   1. /records: a failed section read costs that section only. The title and
//      tab nav still render, with a fixed "could not be loaded" panel (never an
//      empty table).
//   2. Sterile tab: a failed lot search is its own panel; the sterile records
//      list still renders from its own read.
//   3. /records/print: still fails closed, onto a fixed page that is clearly
//      not a log: no document header, no Print button.
// Each read is failed by `${table}#${n}` (call order). Synthetic ids only, and
// the synthetic error text must never reach the page.

const state = vi.hoisted(() => ({ fail: null as string | null, calls: new Map<string, number>() }));

const ROWS: Record<string, unknown[]> = {
  record_keeping_sterile_items: [
    { id: "item-1", lot_number: "LOT-1", item_description: "Probes", date_purchased: "2026-10-01",
      expiry_date: null, date_discarded: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
  ],
};

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
}));

function fakeClient() {
  const builder = (table: string) => {
    const n = (state.calls.get(table) ?? 0) + 1;
    state.calls.set(table, n);
    const settle = () =>
      state.fail === `${table}#${n}`
        ? { data: null, error: { code: "57014", message: "synthetic read failure" }, count: null }
        : { data: ROWS[table] ?? [], error: null, count: (ROWS[table] ?? []).length };
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve().then(settle).then(resolve, reject);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({ data: null, error: settle().error });
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => builder(table),
    rpc: (fn: string) => builder(`rpc:${fn}`),
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/supabase/queries", async (orig) => ({
  ...(await orig<typeof import("@/lib/supabase/queries")>()),
  requirePractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: "owner", display_name: "Owner", email: "owner@example.test" },
    studio: { id: "studio-1", name: "Studio", slug: "studio", timezone: "UTC" },
  }),
}));

const { default: RecordsPage } = await import("@/app/(app)/records/page");
const { default: RecordsPrintPage } = await import("@/app/(app)/records/print/page");
const { PrintButton } = await import("@/app/(app)/records/print/print-button");
// Codex P2 4367401278: the retry control. Loaded leniently so that, before the
// fix, the cases below fail on their assertions rather than on a missing file.
const RefreshRetryButton = await import("@/app/(app)/records/refresh-retry-button")
  .then((m) => m.RefreshRetryButton as unknown)
  .catch(() => null);

type Scan = { text: string; testIds: Set<string>; types: Set<unknown>; hrefs: string[] };

function scan(node: ReactNode): Scan {
  const out: Scan = { text: "", testIds: new Set(), types: new Set(), hrefs: [] };
  const seen = new Set<unknown>();
  const walk = (n: unknown) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      out.text += `${n} `;
      return;
    }
    if (typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) return n.forEach(walk);
    if (isValidElement(n)) {
      out.types.add(n.type);
      const props = n.props as Record<string, unknown>;
      // Child components are not rendered, except the page's own fixed-copy
      // panel, which is a plain synchronous server component.
      if (typeof n.type === "function" && n.type.name === "SectionUnavailable") {
        return walk((n.type as (p: unknown) => ReactNode)(props));
      }
      if (typeof props["data-testid"] === "string") out.testIds.add(props["data-testid"]);
      if (typeof props.href === "string") out.hrefs.push(props.href);
      walk(props.children);
    }
  };
  walk(node);
  return out;
}

const renderRecords = async (sp: Record<string, string>) =>
  scan(await RecordsPage({ searchParams: Promise.resolve(sp) }));
const renderPrint = async (sp: Record<string, string>) =>
  scan(await RecordsPrintPage({ searchParams: Promise.resolve(sp) }));

// One failing read per section: the section's own record read.
const SECTIONS = [
  { section: "sterile", fail: "record_keeping_sterile_items#1" },
  { section: "disinfectants", fail: "record_keeping_disinfectants#1" },
  { section: "incidents", fail: "record_keeping_exposure_incidents#1" },
  { section: "procedures", fail: "sessions#1" },
] as const;

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.fail = null;
  state.calls = new Map();
  log?.mockRestore();
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("RECORDS-SECTION-RECOVERY /records: a failed section keeps the page", () => {
  for (const { section, fail } of SECTIONS) {
    it(`control: ${section} renders on successful reads, and the failing read runs`, async () => {
      const page = await renderRecords({ section });
      expect(page.testIds.has("records-section-unavailable")).toBe(false);
      expect(state.calls.get(fail.split("#")[0]) ?? 0).toBeGreaterThanOrEqual(1);
    });

    it(`${section}: a failed read shows the title, the tab nav and the fixed panel`, async () => {
      state.fail = fail;
      const page = await renderRecords({ section });
      expect(page.text).toContain("Record Keeping");
      for (const tab of ["Sterile Items", "Disinfectants", "Exposure Incidents", "Procedure records"]) {
        expect(page.text).toContain(tab);
      }
      expect(page.testIds.has("records-section-unavailable")).toBe(true);
      expect(page.text).toContain("This section could not be loaded.");
      expect(page.text).toContain("not because there are no records");
      expect(page.text).not.toContain("synthetic");
    });
  }
});

describe("RECORDS-SECTION-RECOVERY sterile tab: the lot search fails on its own", () => {
  it("a failed lot search shows its own panel and the sterile records still render", async () => {
    state.fail = "session_blocks#1";
    const page = await renderRecords({ section: "sterile", lot: "LOT-1" });
    expect(page.testIds.has("records-lot-search-unavailable")).toBe(true);
    expect(page.testIds.has("records-section-unavailable")).toBe(false);
    expect(page.text).toContain("Sterile item records");
    expect(page.text).toContain("Probes");
    expect(page.text).not.toContain("synthetic");
  });

  it("control: a successful lot search shows no unavailable panel", async () => {
    const page = await renderRecords({ section: "sterile", lot: "LOT-1" });
    expect(state.calls.get("session_blocks")).toBe(1);
    expect(page.testIds.has("records-lot-search-unavailable")).toBe(false);
  });
});

describe("RECORDS-SECTION-RECOVERY /records/print: fails closed onto a non-record page", () => {
  for (const { section, fail } of SECTIONS) {
    it(`control: ${section} print renders the log with its Print button`, async () => {
      const page = await renderPrint({ section, history: "1" });
      expect(page.types.has(PrintButton)).toBe(true);
      expect(page.testIds.has("records-print-unavailable")).toBe(false);
    });

    it(`${section}: a failed read renders no log, no header and no Print button`, async () => {
      state.fail = fail;
      const page = await renderPrint({ section, history: "1" });
      expect(page.testIds.has("records-print-unavailable")).toBe(true);
      expect(page.text).toContain("No log was generated.");
      expect(page.types.has(PrintButton)).toBe(false);
      expect(page.types.has("header")).toBe(false);
      expect(page.text).not.toContain("Generated");
      expect(page.text).not.toContain("Studio");
      expect(page.text).not.toMatch(/No (sterile item|disinfectant|exposure incident) records|No sessions recorded/);
      expect(page.text).not.toContain("synthetic");
    });
  }
});

// Codex P2 4367401278. "Try again" pointed at the URL already on screen. A
// client-side navigation to the same URL may reuse the Router Cache's failed
// payload, so the read never re-runs and the retry cannot recover. The retry
// must be a control that calls router.refresh(), as app/(app)/error.tsx does.
describe("RECORDS-SECTION-RECOVERY retry re-requests the server render", () => {
  it("/records: the section panel retries with a refresh control, not a same-URL link", async () => {
    state.fail = "record_keeping_sterile_items#1";
    const page = await renderRecords({ section: "sterile" });
    expect(page.testIds.has("records-section-unavailable")).toBe(true);
    expect(RefreshRetryButton).not.toBeNull();
    expect(page.types.has(RefreshRetryButton)).toBe(true);
    // The tab nav still links to every section, including this one, so the
    // check is that the panel adds no second link to the displayed URL.
    expect(page.hrefs.filter((h) => h === "/records?section=sterile")).toHaveLength(1);
  });

  it("/records/print: the not-a-record page retries with a refresh control", async () => {
    state.fail = "record_keeping_sterile_items#1";
    const page = await renderPrint({ section: "sterile", history: "1" });
    expect(page.testIds.has("records-print-unavailable")).toBe(true);
    expect(RefreshRetryButton).not.toBeNull();
    expect(page.types.has(RefreshRetryButton)).toBe(true);
    expect(page.hrefs.some((h) => h.startsWith("/records/print"))).toBe(false);
  });
});
