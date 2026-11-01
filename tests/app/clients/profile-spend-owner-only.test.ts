import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// RBAC G-1 (Sam decision 2): what a client has PAID is owner-only on the client
// profile. A practitioner's response must not contain the lifetime-spend sum, any
// session's price_paid_cents, or stored card data. The practitioner read never
// SELECTs the price column; hiding it in the page would still ship it in the RSC
// payload. Sentinels are unique; the OWNER control reads the same rows and must see them.

const SENTINEL_CENTS = 7654321;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  selects: [] as Array<{ table: string; columns: string }>,
}));

// A fake that honours the column list: "*" returns the whole row, a named list
// returns only those columns, like PostgREST. So the payload is what the real
// column list would have produced.
function fakeClient() {
  return {
    from(table: string) {
      let columns = "*";
      const rows = () =>
        (db.tables[table] ?? []).map((r) => {
          if (columns.trim().startsWith("*")) return r;
          const wanted = columns
            .replace(/\w+\([^)]*\)/g, "")
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
          return Object.fromEntries(Object.entries(r).filter(([k]) => wanted.includes(k)));
        });
      const query: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: rows(), error: null }).then(resolve);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
          }
          if (prop === "select") {
            return (cols: string) => {
              columns = cols ?? "*";
              db.selects.push({ table, columns });
              return query;
            };
          }
          return () => query;
        },
      });
      return query;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { getClientById } from "@/lib/supabase/queries";
import { SessionTimeline } from "@/components/session-timeline";
import {
  SESSION_FINANCIAL_COLUMNS,
  SESSION_NON_FINANCIAL_COLUMNS,
  clientSessionsSelect,
} from "@/lib/clients/session-columns";

const STUDIO = "studio-synthetic";
const CLIENT = "client-synthetic";

function seedRows() {
  db.selects.length = 0;
  db.tables.clients = [{ id: CLIENT, studio_id: STUDIO }];
  db.tables.client_pricing = [];
  db.tables.practitioners = [];
  db.tables.sessions = [
    {
      id: "s1",
      studio_id: STUDIO,
      client_id: CLIENT,
      practitioner_id: "p1",
      performed_by_practitioner_id: null,
      modality: "electrolysis",
      started_at: "2026-10-01T15:00:00.000Z",
      started_at_original: "2026-10-01T15:00:00.000Z",
      ended_at: null,
      session_notes: null,
      price_paid_cents: SENTINEL_CENTS,
      created_at: "2026-10-01T15:00:00.000Z",
      record_status: "draft",
      deleted_at: null,
      electrolysis_entries: [],
      laser_entries: [],
    },
  ];
}

describe("client profile: what a client paid is owner-only", () => {
  it("owner positive control: the owner's loader returns the session price", async () => {
    seedRows();
    const loaded = await getClientById(STUDIO, CLIENT, { includeFinancials: true });
    expect(loaded?.sessions[0].price_paid_cents).toBe(SENTINEL_CENTS);
    expect(JSON.stringify(loaded)).toContain(String(SENTINEL_CENTS));
  });

  it("practitioner: the loader's payload carries no price at all", async () => {
    seedRows();
    const loaded = await getClientById(STUDIO, CLIENT, { includeFinancials: false });
    expect(loaded?.sessions).toHaveLength(1);
    expect(JSON.stringify(loaded)).not.toContain(String(SENTINEL_CENTS));
    expect("price_paid_cents" in (loaded!.sessions[0] as object)).toBe(false);
    // The clinical row is otherwise intact.
    expect(loaded?.sessions[0].modality).toBe("electrolysis");
  });

  it("the default is the safe direction: no option means no price", async () => {
    seedRows();
    const loaded = await getClientById(STUDIO, CLIENT);
    expect(JSON.stringify(loaded)).not.toContain(String(SENTINEL_CENTS));
  });

  it("the non-owner SELECT never names the price column", () => {
    for (const c of SESSION_FINANCIAL_COLUMNS) {
      expect(clientSessionsSelect(false)).not.toContain(c);
      expect(SESSION_NON_FINANCIAL_COLUMNS as readonly string[]).not.toContain(c);
    }
    expect(clientSessionsSelect(true).startsWith("*")).toBe(true);
    expect(clientSessionsSelect(false)).toContain("electrolysis_entries(*)");
  });

  it("the timeline shows a paid amount to the owner's rows and none to a practitioner's", async () => {
    seedRows();
    const owner = await getClientById(STUDIO, CLIENT, { includeFinancials: true });
    seedRows();
    const member = await getClientById(STUDIO, CLIENT, { includeFinancials: false });
    const render = (sessions: unknown) =>
      renderToStaticMarkup(createElement(SessionTimeline, { clientId: CLIENT, sessions: sessions as never, practitioners: [] }));
    expect(render(owner!.sessions)).toContain("paid");
    expect(render(member!.sessions)).not.toContain("paid");
  });
});

describe("client profile page: source gates (ENFORCED (source only) until Photos' browser proof)", () => {
  const PAGE = readFileSync(path.join(process.cwd(), "app/(app)/clients/[id]/page.tsx"), "utf8");

  it("the loader is asked for financials only for the owner", () => {
    expect(PAGE).toContain('const isOwner = practitioner.role === "owner";');
    expect(PAGE).toContain("getClientById(studio.id, id, { includeFinancials: isOwner })");
  });

  it("lifetime spend and session count are computed for the owner only", () => {
    expect(PAGE).toMatch(/const lifetimeCents = isOwner\s*\?/);
    expect(PAGE).toMatch(/const sessionsWithPrice = isOwner\s*\?/);
  });

  it("the stored-card read and card are owner-only", () => {
    expect(PAGE).toMatch(/isOverview && isOwner\s*\?\s*getActiveCardForStudioClient/);
    expect(PAGE).toMatch(/\{isOwner && \(\(\) => \{/);
  });

  it("the last-treatment session price is owner-only", () => {
    expect(PAGE).toMatch(/\{isOwner &&\s*lastTreatment\.price_paid_cents != null &&/);
  });

  it("service-list prices in booking are NOT touched here (Sam decision 2 exception)", () => {
    // This PR strips client spend, not the published price list.
    expect(PAGE).toContain("AddPricingForm");
  });
});
