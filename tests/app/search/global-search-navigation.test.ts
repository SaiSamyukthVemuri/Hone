import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NAV_RESULT_CAP,
  SEARCH_RESULT_CAP,
  SEARCH_TOTAL_CAP,
} from "@/lib/search/global-search";

// Global Search V2-A: the server action, end to end.
//
// tests/lib/search/navigation-registry.test.ts proves the registry in
// isolation. This file proves the WIRING: that the action derives the
// practitioner's real role from the session and hands it to the registry, and
// that adding navigation results did not disturb the four V1 data categories.
//
// A source pin would not have caught the failure mode that matters here, an
// action that resolves the session but forwards the wrong role would still
// contain every string a regex could look for. So this drives the real
// exported action against a fake Supabase and asserts on the results.

// ---------------------------------------------------------------------------
// Minimal fake Supabase: the subset of the PostgREST builder the action uses.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

function ilikeMatches(value: unknown, pattern: string): boolean {
  const body = pattern.replace(/^%|%$/g, "").toLowerCase();
  return typeof value === "string" && value.toLowerCase().includes(body);
}

function builder(table: string) {
  const predicates: Array<(r: Row) => boolean> = [];
  let cap: number | null = null;
  const chain = {
    eq(col: string, value: unknown) {
      predicates.push((r) => r[col] === value);
      return chain;
    },
    neq(col: string, value: unknown) {
      predicates.push((r) => r[col] !== value);
      return chain;
    },
    is(col: string, value: unknown) {
      predicates.push((r) => (r[col] ?? null) === value);
      return chain;
    },
    ilike(col: string, pattern: string) {
      predicates.push((r) => ilikeMatches(r[col], pattern));
      return chain;
    },
    or(expr: string) {
      const clauses = expr.split(",").map((c) => {
        const [col, , pattern] = c.split(".");
        return { col, pattern };
      });
      predicates.push((r) =>
        clauses.some((c) => ilikeMatches(r[c.col], c.pattern)),
      );
      return chain;
    },
    in(col: string, values: readonly unknown[]) {
      predicates.push((r) => values.includes(r[col]));
      return chain;
    },
    order() {
      return chain;
    },
    limit(n: number) {
      cap = n;
      return chain;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      let rows = (tables[table] ?? []).filter((r) =>
        predicates.every((p) => p(r)),
      );
      if (cap != null) rows = rows.slice(0, cap);
      return Promise.resolve({ data: rows, error: null }).then(resolve as never);
    },
  };
  return chain;
}

const fakeSupabase = {
  from(table: string) {
    return { select: () => builder(table) };
  },
};

const STUDIO = "studio-1";

const { createClientSpy, getCurrentPractitionerWithStudio, getSessionBlockAreasByBlockIds } =
  vi.hoisted(() => ({
    createClientSpy: vi.fn(),
    getCurrentPractitionerWithStudio: vi.fn(),
    getSessionBlockAreasByBlockIds: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient: createClientSpy }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("global search must never use the service role");
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio,
  getSessionBlockAreasByBlockIds,
}));

import { globalSearchAction } from "@/app/(app)/global-search-actions";

// ---------------------------------------------------------------------------

function signInAs(
  role: "owner" | "practitioner",
  studio: Record<string, unknown> = {},
) {
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: { id: "p-1", role },
    studio: { id: STUDIO, ...studio },
  });
}

function seedEmpty() {
  for (const key of Object.keys(tables)) delete tables[key];
  for (const t of [
    "clients",
    "sessions",
    "session_blocks",
    "session_block_areas",
    "services",
    "appointments",
    "record_keeping_sterile_items",
    "record_keeping_disinfectants",
  ]) {
    tables[t] = [];
  }
}

async function search(q: string) {
  const res = await globalSearchAction(q);
  expect(res.ok).toBe(true);
  return res.ok ? res.results : [];
}

const pages = (results: Awaited<ReturnType<typeof search>>) =>
  results.filter((r) => r.type === "page");
const hrefs = (results: Awaited<ReturnType<typeof search>>) =>
  results.map((r) => r.href);

beforeEach(() => {
  vi.clearAllMocks();
  seedEmpty();
  createClientSpy.mockResolvedValue(fakeSupabase);
  signInAs("owner");
  getSessionBlockAreasByBlockIds.mockResolvedValue(new Map());
});

// ---------------------------------------------------------------------------

describe("the action derives navigation visibility from the real session", () => {
  it("an owner is offered owner-only settings", async () => {
    signInAs("owner");
    expect(hrefs(await search("payments"))).toContain("/settings/payments");
    expect(hrefs(await search("hours"))).toContain("/settings/availability");
    expect(hrefs(await search("photo consent"))).toContain("/settings/consent");
  });

  it("a practitioner is never offered them, not by any of their words", async () => {
    signInAs("practitioner");
    for (const query of [
      "payments",
      "stripe",
      "fees",
      "hours",
      "availability",
      "vacation",
      "consent",
      "photo consent",
      "reminder",
      "sms",
      "team",
      "invite",
      "services",
      "pricing",
      "data export",
      "import",
      "csv",
      "marketing",
      "buffer",
      "booking link",
    ]) {
      const results = await search(query);
      for (const href of hrefs(results)) {
        for (const ownerOnly of [
          "/settings/payments",
          "/settings/availability",
          "/settings/consent",
          "/settings/studio",
          "/settings/team",
          "/settings/services",
          "/settings/booking",
          "/settings/data",
          "/settings/import",
          "/settings/tracking",
          "/settings/integrations",
        ]) {
          expect(href, `"${query}" leaked ${ownerOnly}`).not.toContain(
            ownerOnly,
          );
        }
      }
    }
  });

  it("a practitioner still gets their own settings", async () => {
    signInAs("practitioner");
    expect(hrefs(await search("profile"))).toContain("/settings/profile");
    expect(hrefs(await search("intake"))).toContain("/settings/intake");
    expect(hrefs(await search("launch"))).toContain("/settings/launch");
    expect(hrefs(await search("sterile"))).toContain(
      "/records?section=sterile",
    );
  });

  it("the Google Calendar surface follows the studio flag, not the query", async () => {
    signInAs("practitioner", { google_calendar_connection_enabled: false });
    expect(pages(await search("google"))).toEqual([]);

    signInAs("practitioner", { google_calendar_connection_enabled: true });
    expect(hrefs(await search("google"))).toContain(
      "/settings/profile#google-calendar",
    );
  });

  it("a missing session yields a refusal, never a default-owner view", async () => {
    getCurrentPractitionerWithStudio.mockRejectedValue(new Error("no session"));
    await expect(globalSearchAction("payments")).resolves.toEqual({
      ok: false,
    });
  });

  it("an unexpected session shape fails CLOSED to the practitioner view", async () => {
    // Missing practitioner, null role, an unrecognised role: none of these
    // may be read as ownership. Every one must land on the narrower view.
    for (const practitioner of [
      undefined,
      null,
      {},
      { role: null },
      { role: "OWNER" },
      { role: "admin" },
    ]) {
      getCurrentPractitionerWithStudio.mockResolvedValue({
        practitioner,
        studio: { id: STUDIO },
      });
      expect(hrefs(await search("payments")), String(practitioner)).not.toContain(
        "/settings/payments",
      );
    }
  });
});

describe("navigation results are shaped safely", () => {
  it("carry the registry id and description, never a database id", async () => {
    const result = pages(await search("buffer"))[0];
    expect(result).toBeDefined();
    expect(result.id).toBe("page:settings-buffer");
    expect(result.title).toBe("Time between appointments");
    expect(result.subtitle).toBe(
      "Buffer left between back-to-back appointments",
    );
    // V2-A.1: anchored at the control, so a click lands on the buffer field
    // rather than the top of the Booking form.
    expect(result.href).toBe("/settings/booking#buffer");
    expect(result.date).toBeUndefined();
    expect(result.badge).toBeUndefined();
  });

  it("a sub-minimum query answers from the registry with ZERO database reads", async () => {
    const results = await search("h");
    expect(results.map((r) => r.title)).toEqual([
      "Dashboard",
      "Clients",
      "Calendar",
      "Record Keeping",
      "Settings",
      "Getting Started",
    ]);
    expect(createClientSpy).not.toHaveBeenCalled();
  });
});

describe("V1 categories are not degraded", () => {
  // Every row here matches the word "consent", which is ALSO a settings
  // keyword, the collision the split cap exists to survive.
  function seedData(n: number) {
    tables.clients = Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      studio_id: STUDIO,
      archived_at: null,
      name: `Consent Client ${i}`,
      email: `c${i}@example.com`,
      phone: null,
    }));
    tables.services = Array.from({ length: n }, (_, i) => ({
      id: `sv${i}`,
      studio_id: STUDIO,
      name: `Consent consultation ${i}`,
    }));
    tables.appointments = Array.from({ length: n }, (_, i) => ({
      id: `a${i}`,
      studio_id: STUDIO,
      client_id: `c${i}`,
      service_id: `sv${i}`,
      starts_at: "2026-08-01T10:00:00Z",
      status: "confirmed",
      client: { name: `Consent Client ${i}` },
      service: { name: `Consent consultation ${i}` },
    }));
    tables.session_blocks = Array.from({ length: n }, (_, i) => ({
      id: `b${i}`,
      studio_id: STUDIO,
      session_id: `sess${i}`,
      deleted_at: null,
      primary_area: `Consent area ${i}`,
      side: null,
      block_name: null,
      caution_note: null,
      reaction_notes: null,
      probe_label: null,
      probe_lot_number: null,
      created_at: "2026-08-01T10:00:00Z",
      "session.deleted_at": null,
      "session.record_status": "draft",
      session: {
        client_id: `c${i}`,
        started_at: "2026-08-01T10:00:00Z",
        deleted_at: null,
        record_status: "draft",
        client: { name: `Consent Client ${i}` },
      },
    }));
    tables.sessions = Array.from({ length: n }, (_, i) => ({
      id: `sess${i}`,
      studio_id: STUDIO,
      client_id: `c${i}`,
      deleted_at: null,
      record_status: "draft",
      started_at: "2026-08-01T10:00:00Z",
      next_session_note: `Consent discussed ${i}`,
      client: { name: `Consent Client ${i}` },
    }));
    tables.record_keeping_sterile_items = Array.from({ length: n }, (_, i) => ({
      id: `st${i}`,
      studio_id: STUDIO,
      item_description: `Consent-grade sterile probes ${i}`,
      lot_number: `L-${i}`,
      date_purchased: "2026-07-01",
    }));
    tables.record_keeping_disinfectants = Array.from({ length: n }, (_, i) => ({
      id: `d${i}`,
      studio_id: STUDIO,
      disinfectant_name: `Consent-safe solution ${i}`,
      date_prepared: "2026-07-01",
    }));
  }

  it("clients, appointments, treatment memory and records all still resolve", async () => {
    seedData(1);
    const results = await search("consent");
    const types = new Set(results.map((r) => r.type));
    expect(types.has("client")).toBe(true);
    expect(types.has("appointment")).toBe(true);
    expect(types.has("memory")).toBe(true);
    expect(types.has("record")).toBe(true);
    // ...and the settings answer arrived alongside them, not instead of them.
    expect(hrefs(results)).toContain("/settings/consent");
  });

  it("a data-saturated query keeps its full data budget AND still answers with the setting", async () => {
    // The V1 shape: page shortcuts appended LAST into one shared cap of 12,
    // dropped every page result once twelve data rows matched. Chloe typing
    // "consent" in a studio whose clients and probes are also named "consent"
    // would have been shown no consent SETTING at all.
    //
    // Every data category is deliberately saturated here: the per-category
    // caps sum to 20, well past the shared cap of 12, which is the only
    // condition under which the old behaviour actually starved.
    seedData(30);
    const results = await search("consent");
    expect(results.filter((r) => r.type !== "page")).toHaveLength(
      SEARCH_TOTAL_CAP,
    );
    expect(hrefs(results)).toContain("/settings/consent");
    expect(results.length).toBeLessThanOrEqual(SEARCH_RESULT_CAP);
  });

  it("every V1 category keeps its own per-category budget under saturation", async () => {
    seedData(30);
    const results = await search("consent");
    // These are the V1 category caps, unchanged: clients 5, appointments 4,
    // treatment memory 4 (+2 next-visit notes), records 3 (+2 disinfectants).
    expect(results.filter((r) => r.type === "client")).toHaveLength(5);
    expect(results.filter((r) => r.type === "appointment")).toHaveLength(4);
    expect(results.filter((r) => r.type === "memory").length).toBeGreaterThan(0);
  });

  it("the caps are deterministic across repeated identical searches", async () => {
    seedData(30);
    const first = await search("consent");
    for (let i = 0; i < 3; i += 1) {
      expect(await search("consent")).toEqual(first);
    }
    expect(pages(first).length).toBeLessThanOrEqual(NAV_RESULT_CAP);
  });

  it("never exceeds the absolute result cap, even on a broad query", async () => {
    seedData(30);
    for (const query of ["consent", "settings", "client", "record", "c"]) {
      const results = await search(query);
      expect(results.length, query).toBeLessThanOrEqual(SEARCH_RESULT_CAP);
      expect(pages(results).length, query).toBeLessThanOrEqual(NAV_RESULT_CAP);
    }
  });
});
