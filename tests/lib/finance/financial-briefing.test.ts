import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { loadFinancialsView } from "@/lib/finance/financial-briefing";
import type { Studio } from "@/lib/types/database";

type Filter = { op: string; args: unknown[] };

/**
 * A thenable builder proxy, the same shape tests/lib/dashboard/owner-capacity-model
 * uses. It records the table and every filter so the window this module builds
 * can be asserted, and it records whether it was touched AT ALL — which is the
 * security-relevant claim for a non-owner.
 */
function stubClient(stub: {
  rows?: Array<{ status: string }>;
  count?: number | null;
  error?: { code: string } | null;
}) {
  const tables: string[] = [];
  const filters: Filter[] = [];
  const from = (table: string) => {
    tables.push(table);
    const result = () =>
      stub.error
        ? { data: null, error: stub.error, count: null }
        : {
            data: stub.rows ?? [],
            error: null,
            count: stub.count === undefined ? (stub.rows ?? []).length : stub.count,
          };
    const proxy: unknown = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === "then") {
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(result()).then(res, rej);
          }
          return (...args: unknown[]) => {
            filters.push({ op: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return { client: { from } as unknown as SupabaseClient, tables, filters };
}

const studio = (timezone: string): Studio =>
  ({ id: "studio-1", name: "Willow", timezone }) as unknown as Studio;

const OWNER = { role: "owner" } as const;

const argOf = (filters: Filter[], op: string, column: string): string | undefined => {
  const hit = filters.find((f) => f.op === op && f.args[0] === column);
  return hit ? (hit.args[1] as string) : undefined;
};

describe("the owner gate is authority, and it runs before anything is read", () => {
  it("an owner is granted the briefing", async () => {
    const { client } = stubClient({ rows: [{ status: "completed" }] });
    const view = await loadFinancialsView(OWNER, studio("America/Toronto"), "today", client);
    expect(view.access).toBe("granted");
  });

  it("a practitioner is REFUSED", async () => {
    const { client } = stubClient({ rows: [{ status: "completed" }] });
    const view = await loadFinancialsView(
      { role: "practitioner" },
      studio("America/Toronto"),
      "today",
      client,
    );
    expect(view.access).toBe("refused");
  });

  it("A REFUSED PRACTITIONER CAUSES NO READ AT ALL — not a hidden aggregate", async () => {
    // The claim is stronger than "is not shown the total". No studio-wide query
    // is issued, so there is no aggregate payload in the response for anything
    // downstream to leak.
    const { client, tables, filters } = stubClient({ rows: [{ status: "completed" }] });
    const view = await loadFinancialsView(
      { role: "practitioner" },
      studio("America/Toronto"),
      "month",
      client,
    );
    expect(view.access).toBe("refused");
    expect(tables).toEqual([]);
    expect(filters).toEqual([]);
    expect(view).not.toHaveProperty("briefing");
  });

  it("refuses every role that is not exactly owner, including unknown ones", async () => {
    for (const role of ["practitioner", "admin", "Owner", "OWNER", "", "superuser"]) {
      const { client, tables } = stubClient({ rows: [] });
      const view = await loadFinancialsView({ role }, studio("UTC"), "today", client);
      expect(view.access, role).toBe("refused");
      expect(tables, role).toEqual([]);
    }
  });
});

describe("the period window is the STUDIO's, in the studio's timezone", () => {
  it("reads appointments scoped to the studio, on a half-open starts_at window", async () => {
    const { client, tables, filters } = stubClient({ rows: [] });
    await loadFinancialsView(OWNER, studio("America/Toronto"), "today", client);

    expect(tables).toEqual(["appointments"]);
    expect(argOf(filters, "eq", "studio_id")).toBe("studio-1");
    // Half-open: gte on the start, lt on the end. `lte` would double-count the
    // boundary instant into two periods.
    expect(argOf(filters, "gte", "starts_at")).toBeDefined();
    expect(argOf(filters, "lt", "starts_at")).toBeDefined();
    expect(filters.some((f) => f.op === "lte")).toBe(false);
  });

  it("THE BOUNDARY IS STUDIO-LOCAL MIDNIGHT, not UTC midnight", async () => {
    // Non-circular: Toronto is UTC-4 or UTC-5, so its local midnight can never
    // land on a UTC hour of 00. If the browser's or the server's timezone ever
    // starts driving this, that hour changes and this test fails.
    const toronto = stubClient({ rows: [] });
    await loadFinancialsView(OWNER, studio("America/Toronto"), "today", toronto.client);
    const start = argOf(toronto.filters, "gte", "starts_at")!;
    expect(new Date(start).getUTCHours()).toBeGreaterThanOrEqual(4);
    expect(new Date(start).getUTCHours()).toBeLessThanOrEqual(5);

    const utc = stubClient({ rows: [] });
    await loadFinancialsView(OWNER, studio("UTC"), "today", utc.client);
    expect(new Date(argOf(utc.filters, "gte", "starts_at")!).getUTCHours()).toBe(0);
  });

  it("a day window is exactly one day, and never 'start plus 24 hours'", async () => {
    const { client, filters } = stubClient({ rows: [] });
    const view = await loadFinancialsView(OWNER, studio("America/Toronto"), "today", client);
    expect(view.access).toBe("granted");
    if (view.access !== "granted") return;
    // The dates are local calendar strings; the INSTANTS are derived from them
    // separately, which is what makes a 23- or 25-hour DST day come out right.
    expect(view.briefing.endLocalExclusive).not.toBe(view.briefing.startLocal);
    expect(view.briefing.endLocalInclusive).toBe(view.briefing.startLocal);
    expect(argOf(filters, "gte", "starts_at")).not.toBe(argOf(filters, "lt", "starts_at"));
  });

  it("a week is anchored on Sunday, the same anchor the calendar uses", async () => {
    const { client } = stubClient({ rows: [] });
    const view = await loadFinancialsView(OWNER, studio("America/Toronto"), "week", client);
    if (view.access !== "granted") throw new Error("expected granted");
    expect(new Date(`${view.briefing.startLocal}T12:00:00Z`).getUTCDay()).toBe(0);
  });

  it("a month starts on the first, and the inclusive end is the day before the exclusive one", async () => {
    const { client } = stubClient({ rows: [] });
    const view = await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);
    if (view.access !== "granted") throw new Error("expected granted");
    expect(view.briefing.startLocal.endsWith("-01")).toBe(true);
    const inclusive = new Date(`${view.briefing.endLocalInclusive}T12:00:00Z`);
    const exclusive = new Date(`${view.briefing.endLocalExclusive}T12:00:00Z`);
    expect(exclusive.getTime() - inclusive.getTime()).toBe(86_400_000);
  });
});

describe("a read that did not succeed never becomes a zero", () => {
  it("A FAILED READ RENDERS AS UNAVAILABLE, not as an empty studio", async () => {
    // supabase-js RESOLVES with { data: null, error }. Discarding that error is
    // how "no appointments" reaches an owner who in fact had a full week.
    const { client } = stubClient({ error: { code: "57014" } });
    const view = await loadFinancialsView(OWNER, studio("UTC"), "today", client);
    if (view.access !== "granted") throw new Error("expected granted");
    const { booked, completed } = view.briefing.calendar;
    expect(booked.known).toBe(false);
    if (!booked.known) expect(booked.cause).toBe("unavailable");
    expect(completed.known).toBe(false);
    if (!completed.known) expect(completed.cause).toBe("unavailable");
  });

  it("AN EMPTY PERIOD IS STILL A KNOWN ZERO, and is not confused with a failure", async () => {
    const { client } = stubClient({ rows: [], count: 0 });
    const view = await loadFinancialsView(OWNER, studio("UTC"), "today", client);
    if (view.access !== "granted") throw new Error("expected granted");
    expect(view.briefing.calendar.booked).toEqual({ known: true, value: 0 });
    expect(view.briefing.calendar.completed).toEqual({ known: true, value: 0 });
  });

  it("A TRUNCATED READ IS NOT ENUMERABLE — the row ceiling never becomes a total", async () => {
    // supabase/config.toml sets max_rows = 1000 and is tracked, so the Data API
    // clips before any app-side limit. The exact Content-Range count is what
    // exposes it; a shorter row set with a larger count is a short read.
    const { client } = stubClient({
      rows: Array.from({ length: 1_000 }, () => ({ status: "completed" })),
      count: 4_210,
    });
    const view = await loadFinancialsView(OWNER, studio("UTC"), "month", client);
    if (view.access !== "granted") throw new Error("expected granted");
    const { booked } = view.briefing.calendar;
    expect(booked.known).toBe(false);
    if (!booked.known) expect(booked.cause).toBe("not_enumerable");
  });

  it("NO COUNT IS NOT A MATCHING COUNT: a missing Content-Range is a short read", async () => {
    const { client } = stubClient({ rows: [{ status: "completed" }], count: null });
    const view = await loadFinancialsView(OWNER, studio("UTC"), "today", client);
    if (view.access !== "granted") throw new Error("expected granted");
    expect(view.briefing.calendar.booked.known).toBe(false);
  });
});
