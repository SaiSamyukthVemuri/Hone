import { readFileSync } from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadFinancialsView } from "@/lib/finance/financial-briefing";
import type { Studio } from "@/lib/types/database";

type Filter = { op: string; args: unknown[] };

/**
 * Far enough either side of any real clock that these are deterministic without
 * injecting a reference instant into the loader. The TIE and the exact boundary
 * are pinned in the model test, where the instant IS a parameter.
 */
const LONG_PAST = "2000-01-01T00:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

/**
 * A thenable builder proxy, the same shape tests/lib/dashboard/owner-capacity-model
 * uses. It records the table and every filter so the window this module builds
 * can be asserted, and it records whether it was touched AT ALL — which is the
 * security-relevant claim for a non-owner.
 */
function stubClient(stub: {
  rows?: Array<{ status: string; starts_at: string }>;
  count?: number | null;
  error?: { code: string } | null;
  /** Fail exactly ONE table, to prove a single bad read withdraws the census. */
  failTable?: string;
}) {
  const tables: string[] = [];
  const filters: Filter[] = [];
  const from = (table: string) => {
    tables.push(table);
    const result = () =>
      stub.failTable === table
        ? { data: null, error: { code: "57014" }, count: null }
        : stub.error
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
    const { client } = stubClient({ rows: [{ status: "completed", starts_at: LONG_PAST }] });
    const view = await loadFinancialsView(OWNER, studio("America/Toronto"), "today", client);
    expect(view.access).toBe("granted");
  });

  it("a practitioner is REFUSED", async () => {
    const { client } = stubClient({ rows: [{ status: "completed", starts_at: LONG_PAST }] });
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
    const { client, tables, filters } = stubClient({ rows: [{ status: "completed", starts_at: LONG_PAST }] });
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

describe("the read projects enough to answer 'still to happen' truthfully", () => {
  it("SELECTS starts_at ALONGSIDE status, and the appointments read stays non-financial", async () => {
    // Status alone cannot distinguish an upcoming appointment from one that
    // passed and was never closed out, so the projection is the fix's load
    // bearing half.
    const { client, filters, tables } = stubClient({ rows: [] });
    await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);

    const select = filters.find((f) => f.op === "select");
    expect(select).toBeDefined();
    const projection = String(select!.args[0]);
    expect(projection).toContain("status");
    expect(projection).toContain("starts_at");
    // SLICE 2 WIDENS THIS PROJECTION, and every added column is named here so a
    // future widening is a decision made in the open rather than a column that
    // quietly appears. `ends_at` is what "delivered" is defined on;
    // `blocked_ends_at` is chair time including the per-appointment buffer.
    expect(projection).toContain("ends_at");
    expect(projection).toContain("duration_minutes");
    expect(projection).toContain("blocked_ends_at");
    expect(projection).toContain("service_id");

    // THE APPOINTMENTS READ ITSELF CARRIES NO MONEY. Prices, payments and
    // settlements are separate reads against their own authorities, and this
    // one must never grow an embedded resource that reaches them.
    for (const forbidden of ["price", "amount", "cents", "payment", "settlement", "charge", "refund", "stripe"]) {
      expect(projection.toLowerCase(), projection).not.toContain(forbidden);
    }
    expect(projection, "no PostgREST embedded resource").not.toContain("(");

    // ONE appointments read, feeding BOTH censuses, so the calendar and the
    // money panel cannot disagree about which appointments exist.
    expect(tables.filter((t) => t === "appointments")).toHaveLength(1);
  });

  it("reads each money authority exactly where it lives, and reads no decoy", async () => {
    const { client, tables } = stubClient({ rows: [] });
    await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);

    // The live ledger, its refund window, and the 0187 settlement authority.
    // `payment_charge_attempts` appears four times: charges, refunds, the
    // unattributed count, and the ledger-opening probe — four different
    // windows over one authority, never a second table pretending to be it.
    // `client_pricing` joined in Slice 2b: the price a PARTICULAR client
    // pays, for visits no settlement froze a snapshot for.
    expect(new Set(tables)).toEqual(
      new Set([
        "appointments",
        "services",
        "client_pricing",
        "payment_charge_attempts",
        "appointment_settlements",
      ]),
    );
    for (const decoy of [
      "manual_fee_charge_attempts",
      "stripe_charge_attempts",
      "appointment_payments",
      "stripe_refunds",
      "stripe_refund_attempts",
    ]) {
      expect(tables, decoy).not.toContain(decoy);
    }
  });

  it("reads client_pricing scoped to the studio, and never by an id list", async () => {
    // The price a PARTICULAR client pays. Read studio-wide and narrowed in
    // memory: an `.in(client_id, [...])` list grows with the period, and an
    // over-long generated URL is a live production failure mode here.
    const { client, tables, filters } = stubClient({ rows: [] });
    await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);
    expect(tables).toContain("client_pricing");
    expect(filters.filter((f) => f.op === "in")).toHaveLength(0);
    expect(
      filters.some((f) => f.op === "eq" && f.args[0] === "studio_id"),
    ).toBe(true);
  });

  it("a FAILED client_pricing read withdraws the whole money census", async () => {
    // FAIL CLOSED, AND FAIL WHOLE. A census assembled from the reads that
    // happened to succeed is the exact shape of a confident understatement:
    // every visit would silently fall back to the menu price and the total
    // would look complete.
    const { client } = stubClient({ rows: [], failTable: "client_pricing" });
    const view = await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);
    if (view.access !== "granted") throw new Error("expected granted");
    const { money } = view.briefing;
    expect(money.census.treatmentServiceValueCents.known).toBe(false);
    expect(money.census.movedInGrossCents.known).toBe(false);
  });

  it("a PAST confirmed appointment does not reach the owner as 'still to happen'", async () => {
    const { client } = stubClient({
      rows: [
        { status: "confirmed", starts_at: LONG_PAST },
        { status: "confirmed", starts_at: FAR_FUTURE },
      ],
    });
    const view = await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);
    if (view.access !== "granted") throw new Error("expected granted");
    const { calendar } = view.briefing;

    expect(calendar.stillToHappen).toEqual({ known: true, value: 1 });
    expect(calendar.pastConfirmed).toEqual({ known: true, value: 1 });
    // Neither row is dropped, and neither gains an outcome it did not earn.
    expect(calendar.booked).toEqual({ known: true, value: 2 });
    expect(calendar.completed).toEqual({ known: true, value: 0 });
    expect(calendar.noShow).toEqual({ known: true, value: 0 });
    expect(calendar.partition.closed).toBe(true);
  });
});

describe("the period window is the STUDIO's, in the studio's timezone", () => {
  it("reads appointments scoped to the studio, on a half-open starts_at window", async () => {
    const { client, tables, filters } = stubClient({ rows: [] });
    await loadFinancialsView(OWNER, studio("America/Toronto"), "today", client);

    expect(tables[0]).toBe("appointments");
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
      rows: Array.from({ length: 1_000 }, () => ({ status: "completed", starts_at: LONG_PAST })),
      count: 4_210,
    });
    const view = await loadFinancialsView(OWNER, studio("UTC"), "month", client);
    if (view.access !== "granted") throw new Error("expected granted");
    const { booked } = view.briefing.calendar;
    expect(booked.known).toBe(false);
    if (!booked.known) expect(booked.cause).toBe("not_enumerable");
  });

  it("NO COUNT IS NOT A MATCHING COUNT: a missing Content-Range is a short read", async () => {
    const { client } = stubClient({ rows: [{ status: "completed", starts_at: LONG_PAST }], count: null });
    const view = await loadFinancialsView(OWNER, studio("UTC"), "today", client);
    if (view.access !== "granted") throw new Error("expected granted");
    expect(view.briefing.calendar.booked.known).toBe(false);
  });
});

// ===========================================================================
// SLICE 2 — the money window
// ===========================================================================

/**
 * A stub that answers each TABLE differently, so the money reads can be
 * distinguished from the appointments read. The single-shape `stubClient` above
 * is left untouched: the Slice 1 tests assert against it and it still says what
 * they were written to say.
 */
function stubTables(
  byTable: Record<
    string,
    {
      rows?: unknown[];
      count?: number | null;
      error?: { code: string } | null;
      /** Successive pages, returned in call order, for a paginated read. */
      pages?: unknown[][];
      /** Fail the Nth page (0-based) of a paginated read. */
      failPage?: number;
      /**
       * Answer per-read, from the filters THAT read used.
       *
       * `payment_charge_attempts` is read four different ways on this screen —
       * windowed charges, windowed refunds, the all-time existence read, the
       * undated head count and the earliest-dated opening read. A stub that
       * returns one shape for the whole table cannot express "the opening read
       * finds nothing while undated payments exist", which is the entire
       * subject of the undated-ledger finding.
       */
      resolve?: (ops: string) => { rows?: unknown[]; count?: number | null } | undefined;
    }
  >,
) {
  const tables: string[] = [];
  const filters: Array<Filter & { table: string }> = [];
  const pageCalls: Record<string, number> = {};
  const from = (table: string) => {
    tables.push(table);
    const stub = byTable[table] ?? { rows: [] };
    const call = (pageCalls[table] = (pageCalls[table] ?? 0) + 1) - 1;
    const mine: Filter[] = [];
    const result = () => {
      if (stub.error) return { data: null, error: stub.error, count: null };
      if (stub.resolve) {
        const ops = mine.map((f) => `${f.op}(${JSON.stringify(f.args)})`).join(" ");
        const answer = stub.resolve(ops);
        if (answer) {
          const rows = answer.rows ?? [];
          return {
            data: rows,
            error: null,
            count: answer.count === undefined ? rows.length : answer.count,
          };
        }
      }
      if (stub.pages) {
        if (stub.failPage === call) return { data: null, error: { code: "57014" }, count: null };
        const page = stub.pages[call] ?? [];
        return {
          data: page,
          error: null,
          count: stub.count === undefined ? page.length : stub.count,
        };
      }
      return {
        data: stub.rows ?? [],
        error: null,
        count: stub.count === undefined ? (stub.rows ?? []).length : stub.count,
      };
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
            filters.push({ table, op: String(prop), args });
            mine.push({ op: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return { client: { from } as unknown as SupabaseClient, tables, filters, pageCalls };
}

const granted = (view: Awaited<ReturnType<typeof loadFinancialsView>>) => {
  if (view.access !== "granted") throw new Error("expected the briefing to be granted");
  return view.briefing;
};

describe("RULING 1 — the money window opens at the record-keeping floor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (iso: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  };

  it("a period ENTIRELY below the floor yields no money figure at all", async () => {
    // July 2026: the marking rate that month was 82.6%, and May's was 0%. A
    // figure over such a month does not describe a quieter studio, it describes
    // a studio that had not started closing appointments out.
    at("2026-07-15T16:00:00.000Z");
    const { client } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));

    expect(b.money.covered).toBe(false);
    expect(b.money.census.movedInGrossCents.known).toBe(false);
    if (!b.money.census.movedInGrossCents.known) {
      // NOT `unavailable` and NOT `unknowable`: the read would have succeeded,
      // and records did exist. They were incomplete.
      expect(b.money.census.movedInGrossCents.cause).toBe("records_incomplete");
    }
    // THE CALENDAR IS UNAFFECTED. Only money is withdrawn.
    expect(b.calendar.booked.known).toBe(true);
  });

  it("a period STRADDLING the floor reports money from the floor, and says so", async () => {
    at("2026-08-15T16:00:00.000Z");
    const { client, filters } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));

    expect(b.money.covered).toBe(true);
    if (b.money.covered) {
      expect(b.money.startLocal).toBe("2026-08-01");
      expect(b.money.narrowed).toBe(false); // August starts exactly at the floor
    }
    // The APPOINTMENTS read still covers the whole period the owner asked for.
    const appointmentStart = filters.find(
      (f) => f.table === "appointments" && f.op === "gte" && f.args[0] === "starts_at",
    );
    expect(appointmentStart).toBeDefined();
  });

  it("THE LEDGER READS ARE WINDOWED AT THE FLOOR, not at the period start", async () => {
    // A July period start must never reach the ledger query, or the figure
    // would cover exactly the months the floor exists to exclude.
    at("2026-08-15T16:00:00.000Z");
    const { client, filters } = stubTables({});
    await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);

    const chargeStart = filters.find(
      (f) => f.table === "payment_charge_attempts" && f.op === "gte" && f.args[0] === "charged_at",
    );
    expect(chargeStart).toBeDefined();
    // Toronto local midnight on 1 August is 04:00Z (EDT).
    expect(String(chargeStart!.args[1])).toBe("2026-08-01T04:00:00.000Z");
  });

  it("a WEEK straddling the floor is narrowed, and the screen is told", async () => {
    // The week of Sunday 26 July 2026 runs into August.
    at("2026-07-30T16:00:00.000Z");
    const { client } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "week", client));
    expect(b.money.covered).toBe(true);
    if (b.money.covered) {
      expect(b.money.startLocal).toBe("2026-08-01");
      expect(b.money.narrowed).toBe(true);
    }
  });
});

describe("FIN-C11 — a window reaching back before the ledger is flagged, never reported flat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags a window that starts before this studio's first verified payment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    // The undated count is stated EXPLICITLY as zero. A stub that answered every
    // read with the same row made the undated head count 1 as well, which now
    // (correctly) withholds the banner — so the fixture has to say which of the
    // two facts it means.
    const { client } = stubTables({
      payment_charge_attempts: {
        resolve: (ops) =>
          ops.includes('is(["charged_at",null])') ? { rows: [], count: 0 } : undefined,
        rows: [{ charged_at: "2026-08-10T12:00:00.000Z" }],
      },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.precedesLedger).toBe(true);
  });

  it("does NOT flag a window that sits entirely inside the ledger's life", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({
      payment_charge_attempts: { rows: [{ charged_at: "2026-07-07T12:00:00.000Z" }] },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.precedesLedger).toBe(false);
  });

  // -------------------------------------------------------------------------
  // A FAILED READ IS NOT AN EMPTY LEDGER — Codex P2-A
  // -------------------------------------------------------------------------
  //
  // The defect: every failure branch set `ledgerOpensAt` to null, and the
  // expression then read null as PROOF that the studio had no prior card
  // payment. The screen stated the window predates the owner's first payment
  // on the strength of a read that did not come back. There are three truths
  // here, not two, and the third one is UNKNOWN.

  it("a FAILED ledger read never authorizes the predates-first-payment claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({
      payment_charge_attempts: { error: { code: "57014" } },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    // NOT flagged: Hone could not look, so it cannot say the window came first.
    expect(b.money.covered && b.money.precedesLedger).toBe(false);
    // And the census is withdrawn with the cause that caused it, rather than
    // being reported as a quiet studio.
    expect(b.money.census.collectedOnDeliveredCents.known).toBe(false);
  });

  it("a TRUNCATED ledger read never authorizes it either", async () => {
    // Not an error — a short page against a larger exact count. The read
    // "succeeded" and is still not an enumeration.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({
      payment_charge_attempts: { rows: [{ charged_at: "2026-08-10T12:00:00.000Z" }], count: 5_000 },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.precedesLedger).toBe(false);
    expect(b.money.census.collectedOnDeliveredCents.known).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AN UNDATED PAYMENT IS NOT AN EMPTY LEDGER — Codex P2-B
  // -------------------------------------------------------------------------
  //
  // Unlike the read-failure case above, this query SUCCEEDS. It orders by
  // `charged_at` and takes one row, so a studio whose succeeded payments all
  // carry `charged_at = NULL` yields zero rows — and that was read as "this
  // studio has no card ledger", licensing "before your first card payment".
  // The separately loaded unattributed count proves those payments exist.
  //
  // The banner states a CHRONOLOGY. It may render only when Hone can prove one.

  it("only UNDATED payments cannot prove an empty ledger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    // The opening read finds no dated row; the head-count read reports 3
    // succeeded payments. Both are true at once, and only one of them is
    // evidence about chronology.
    const { client } = stubTables({
      payment_charge_attempts: {
        // The OPENING read (ordered by charged_at, limit 1) finds no dated row.
        // The UNDATED head count reports three. Every other read is empty and
        // consistent, so nothing is withdrawn and the banner decision is the
        // only thing under test.
        resolve: (ops) =>
          ops.includes('limit([1])')
            ? { rows: [] }
            : ops.includes('is(["charged_at",null])')
              ? { rows: [], count: 3 }
              : { rows: [] },
      },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.precedesLedger).toBe(false);
    // ...and the census is NOT withdrawn: this is a truthful-claim fix, not a
    // read failure, so every other figure must survive it.
    expect(b.money.covered && b.money.census.deliveredTreatmentVisits.known).toBe(true);
  });

  it("a DATED payment cannot be called FIRST while an undated one exists", async () => {
    // The conservative truth: an undated row could chronologically precede the
    // earliest dated one, so "first" is not established and the window cannot
    // be said to precede it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({
      payment_charge_attempts: {
        resolve: (ops) =>
          ops.includes('limit([1])')
            ? { rows: [{ charged_at: "2026-08-10T12:00:00.000Z" }] }
            : ops.includes('is(["charged_at",null])')
              ? { rows: [], count: 5 }
              : { rows: [] },
      },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.precedesLedger).toBe(false);
    expect(b.money.covered && b.money.census.deliveredTreatmentVisits.known).toBe(true);
  });

  it("a dated payment with NO undated rows still proves the chronology", async () => {
    // The control: without an undated row the banner is exactly as before.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({
      payment_charge_attempts: {
        resolve: (ops) =>
          ops.includes('limit([1])')
            ? { rows: [{ charged_at: "2026-08-10T12:00:00.000Z" }] }
            : ops.includes('is(["charged_at",null])')
              ? { rows: [], count: 0 }
              : { rows: [] },
      },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.precedesLedger).toBe(true);
  });

  it("NO LEDGER AT ALL is the same statement, maximally — flagged, not zeroed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.precedesLedger).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE STUDIO-WIDE SETTLEMENT READ MUST PAGINATE — Codex P1-B
// ---------------------------------------------------------------------------
//
// `supabase/config.toml` sets `max_rows = 1000`, so a studio-wide read of
// `appointment_settlements` returns at most one page while `count: "exact"`
// reports the true total. `complete()` then rejects the read and withdraws
// EVERY money figure — and because this read is deliberately not narrowed by
// the period, choosing a shorter day, week or month cannot recover the screen.
// Any studio that crosses the lifetime threshold loses Financials permanently.
//
// The read stays studio-wide: an `.in("appointment_id", [...])` list grows with
// the period and an over-long generated URL is a live failure mode on this
// codebase. It is enumerated page by page instead, with the completeness claim
// made about the FULL enumerated set rather than about a short final page.

describe("the studio-wide settlement read enumerates every page", () => {
  const settlementRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      appointment_id: `old-${i}`,
      method: "paid_cash",
      amount_cents: 1_000,
      quoted_amount_cents: null,
    }));

  const pagesOf = (n: number) => {
    const all = settlementRows(n);
    const pages: unknown[][] = [];
    for (let i = 0; i < all.length; i += 1_000) pages.push(all.slice(i, i + 1_000));
    // A read whose total is an exact multiple ends on an empty page.
    if (all.length % 1_000 === 0) pages.push([]);
    return pages;
  };

  const load = async (n: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client, pageCalls } = stubTables({
      appointment_settlements: { pages: pagesOf(n), count: n },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    return { b, pageCalls };
  };

  for (const n of [999, 1_000, 1_001, 2_001]) {
    it(`${n} live settlements still yield a money census`, async () => {
      const { b } = await load(n);
      // The census is NOT withdrawn: every figure survives the read.
      expect(b.money.covered && b.money.census.deliveredTreatmentVisits.known).toBe(true);
      // Every row was enumerated exactly once, and none of them belongs to this
      // window, so they are disclosed as history rather than counted here.
      expect(
        b.money.covered ? b.money.census.basis.settlementsOutsideWindow : -1,
      ).toBe(n);
      expect(b.money.covered ? b.money.census.basis.settlementsUnattributable : -1).toBe(0);
    });
  }

  it("pages are requested until the read is exhausted, not just once", async () => {
    const { pageCalls } = await load(2_001);
    // 1000 + 1000 + 1 → three pages. A single request would have been the bug.
    expect(pageCalls.appointment_settlements).toBe(3);
  });

  it("an exact multiple of the page size ends on an empty page, losing nothing", async () => {
    const { b, pageCalls } = await load(2_000);
    expect(b.money.covered && b.money.census.basis.settlementsOutsideWindow).toBe(2_000);
    // 1000 + 1000 + the empty page that proves the end.
    expect(pageCalls.appointment_settlements).toBe(3);
  });

  it("A FAILING PAGE WITHDRAWS THE WHOLE READ — never the pages that worked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({
      appointment_settlements: { pages: pagesOf(2_001), count: 2_001, failPage: 1 },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.census.deliveredTreatmentVisits.known).toBe(false);
  });

  it("A SHORT ENUMERATION IS NOT COMPLETE — the count is still the authority", async () => {
    // Every page returned successfully, and they still do not add up to what
    // PostgREST said exists. That is `not_enumerable`, not a complete read.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({
      appointment_settlements: { pages: [settlementRows(500)], count: 900 },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.census.deliveredTreatmentVisits.known).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLIENT PRICING HAS THE SAME CEILING AS SETTLEMENTS — Codex P2
// ---------------------------------------------------------------------------
//
// The identical studio-wide lifetime cliff, on the read next to it: past 1000
// `client_pricing` rows the first page came back while `count: "exact"`
// reported the true total, `complete()` rejected it, and the whole census went
// with it. Also unrecoverable by choosing a shorter period, for the same reason.

describe("the studio-wide client-pricing read enumerates every page", () => {
  const pricingRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      client_id: `c-${i}`,
      service_name: "60 minute session",
      price_cents: 12_000,
      notes: null,
      effective_from: "2026-01-01",
    }));

  const pagesOf = (n: number) => {
    const all = pricingRows(n);
    const pages: unknown[][] = [];
    for (let i = 0; i < all.length; i += 1_000) pages.push(all.slice(i, i + 1_000));
    if (all.length % 1_000 === 0) pages.push([]);
    return pages;
  };

  const load = async (n: number, over: Record<string, unknown> = {}) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client, pageCalls } = stubTables({
      client_pricing: { pages: pagesOf(n), count: n, ...over },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    return { b, pageCalls };
  };

  for (const n of [999, 1_000, 1_001, 2_001]) {
    it(`${n} client-pricing rows still yield a money census`, async () => {
      const { b } = await load(n);
      expect(b.money.covered && b.money.census.deliveredTreatmentVisits.known).toBe(true);
    });
  }

  it("pages are requested until the read is exhausted", async () => {
    const { pageCalls } = await load(2_001);
    expect(pageCalls.client_pricing).toBe(3);
  });

  it("an exact multiple ends on an empty page, losing nothing", async () => {
    const { b, pageCalls } = await load(2_000);
    expect(b.money.covered && b.money.census.deliveredTreatmentVisits.known).toBe(true);
    expect(pageCalls.client_pricing).toBe(3);
  });

  it("A FAILING PAGE WITHDRAWS THE WHOLE READ", async () => {
    const { b } = await load(2_001, { failPage: 1 });
    expect(b.money.covered && b.money.census.deliveredTreatmentVisits.known).toBe(false);
  });

  it("A SHORT ENUMERATION IS NOT COMPLETE", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({
      client_pricing: { pages: [pricingRows(500)], count: 900 },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.census.deliveredTreatmentVisits.known).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PAYMENT-RECORD EXISTENCE IS ITS OWN AUTHORITY — Codex P1
// ---------------------------------------------------------------------------

describe("the all-time payment-existence read", () => {
  it("is mode-scoped and status-scoped, like every other ledger read", () => {
    // A TEST-mode row must not satisfy LIVE evidence, and a FAILED attempt is
    // not a payment. Asserted against the source because the filters are the
    // whole authority — there is no arithmetic here to catch a missing one.
    const src = readFileSync(
      path.join(process.cwd(), "lib/finance/financial-briefing.ts"),
      "utf8",
    );
    const read = src.slice(src.indexOf('.select("appointment_id, charged_at, amount_cents'));
    const head = read.slice(0, 400);
    expect(head).toContain('.eq("status", "succeeded")');
    expect(head).toContain('.eq("stripe_livemode", livemode)');
    expect(head).toContain('.not("appointment_id", "is", null)');
  });

  it("A FAILED existence read withdraws the census — never a confident unrecorded", async () => {
    // The whole point: absence of evidence from a read that did not happen is
    // not evidence of absence. `complete()` already fails whole, so the census
    // is withdrawn rather than reporting "No payment recorded".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({
      payment_charge_attempts: { error: { code: "57014" } },
    });
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.census.unresolvedVisits.known).toBe(false);
    expect(b.money.covered && b.money.census.paidInAnotherPeriodVisits.known).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE EVIDENCE INSTANT MUST ACTUALLY BOUND THE READ — Codex P2-C
// ---------------------------------------------------------------------------
//
// Every period this surface offers is anchored on today, so `endLocalExclusive`
// is always in the FUTURE: "month" ends at next month's first local midnight.
// The transaction reads used that future boundary while the footer stamped the
// census with the captured `evidenceInstant`, so a charge committing after that
// instant while these asynchronous reads were in flight could enter totals
// labelled with an earlier time. The published timestamp did not bound the
// money it labelled.
//
// The filter is applied by the DATABASE, so what decides inclusion in
// production is the bound SENT. That is what these tests assert — deterministic,
// no sleeps, no wall clock.

describe("transaction reads are bounded by the evidence instant", () => {
  const boundsFor = async (nowIso: string, period: "today" | "week" | "month") => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowIso));
    const { client, filters } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), period, client));
    const upper = (col: string) =>
      filters
        .filter((f) => f.op === "lt" && Array.isArray(f.args) && f.args[0] === col)
        .map((f) => String((f.args as unknown[])[1]));
    return { evidenceInstant: b.evidenceInstant, charged: upper("charged_at"), refunded: upper("refunded_at") };
  };

  it("the charge window ends at the evidence instant, not the period end", async () => {
    const { evidenceInstant, charged } = await boundsFor("2026-08-15T16:00:00.000Z", "month");
    expect(charged.length).toBeGreaterThan(0);
    for (const bound of charged) {
      expect(bound, "a charge read reached past the evidence instant").toBe(evidenceInstant);
    }
  });

  it("the refund window ends there too — the same authority governs both", async () => {
    const { evidenceInstant, refunded } = await boundsFor("2026-08-15T16:00:00.000Z", "month");
    expect(refunded.length).toBeGreaterThan(0);
    for (const bound of refunded) {
      expect(bound, "a refund read reached past the evidence instant").toBe(evidenceInstant);
    }
  });

  it("holds for every period this surface offers", async () => {
    for (const period of ["today", "week", "month"] as const) {
      const { evidenceInstant, charged, refunded } = await boundsFor(
        "2026-08-15T16:00:00.000Z",
        period,
      );
      for (const bound of [...charged, ...refunded]) {
        expect(bound, `${period} reached past the evidence instant`).toBe(evidenceInstant);
      }
    }
  });

  it("a LATER evidence instant moves the bound with it", async () => {
    // The same query at a newer instant admits what the earlier one excluded —
    // the row becomes visible because the boundary moved, not because the
    // window was widened.
    const earlier = await boundsFor("2026-08-15T16:00:00.000Z", "month");
    const later = await boundsFor("2026-08-15T18:30:00.000Z", "month");
    expect(later.evidenceInstant > earlier.evidenceInstant).toBe(true);
    expect(later.charged[0] > earlier.charged[0]).toBe(true);
  });

  it("THE SERVICE-PERIOD READ IS NOT TRUNCATED — a different authority", async () => {
    // Delivered work is governed by the period, not by the transaction clock.
    // Capping it here would hide appointments that genuinely belong to the
    // window, so this asserts the two authorities stayed separate.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client, filters } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    const startsAtUpper = filters
      .filter((f) => f.op === "lt" && Array.isArray(f.args) && f.args[0] === "starts_at")
      .map((f) => String((f.args as unknown[])[1]));
    expect(startsAtUpper.length).toBeGreaterThan(0);
    for (const bound of startsAtUpper) {
      expect(bound, "the appointments read was capped at the evidence instant").not.toBe(
        b.evidenceInstant,
      );
    }
  });
});

describe("the evidence instant is pinned and published", () => {
  it("one clock read anchors the period, the delivered split AND the printed instant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.evidenceInstant).toBe("2026-08-15T16:00:00.000Z");
    vi.useRealTimers();
  });
});

describe("P2-D — the unattributed count never rides on the period", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("travels on the briefing, NOT inside the windowed money census", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));

    expect(b.unattributedChargesAllTime).toBeDefined();
    // It is not a member of the census, so no window can be implied for it.
    expect(Object.keys(b.money.census)).not.toContain("unattributedCharges");
    expect(Object.keys(b.money.census)).not.toContain("unattributedChargesAllTime");
  });

  it("its read is filtered on charged_at IS NULL and carries NO date window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client, filters } = stubTables({});
    await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);

    // A HEAD count over rows with no collection time. Windowing it would need
    // an instant these rows do not have; `created_at` records when the attempt
    // ROW was written, not when money moved.
    const nullCharged = filters.filter((f) => f.op === "is" && f.args[0] === "charged_at");
    expect(nullCharged.length).toBeGreaterThanOrEqual(1);
    expect(filters.some((f) => f.args[0] === "created_at")).toBe(false);
  });

  it("IS STILL ESTABLISHED when the period is below the money floor", async () => {
    // The count is ALL-TIME, so the money window's floor has no bearing on it.
    // It previously rode inside the ledger bundle, which meant a July period
    // suppressed an all-time figure for an unrelated reason — and reported the
    // absence as `not_yet_supported`, whose sentence claims Hone cannot answer
    // this yet. Hone answers it in every other period, so that was untrue.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T16:00:00.000Z"));
    const { client } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));

    expect(b.money.covered).toBe(false); // the money window IS withheld...
    expect(b.unattributedChargesAllTime.known).toBe(true); // ...and this is not
  });

  it("NEVER carries not_yet_supported — Hone does support this figure", async () => {
    // The only absent path is a failed read, and the true thing to say about
    // that is `unavailable`. A `not_yet_supported` sentence would tell the
    // owner something false about their own studio.
    const failing = {
      from: () => {
        const proxy: unknown = new Proxy(
          {},
          {
            get: (_t, prop) => {
              if (prop === "then") {
                return (res: (v: unknown) => unknown) =>
                  Promise.resolve({ data: null, error: { code: "PGRST500" }, count: null }).then(res);
              }
              return () => proxy;
            },
          },
        );
        return proxy;
      },
    } as unknown as SupabaseClient;

    const b = granted(
      await loadFinancialsView(OWNER, studio("America/Toronto"), "month", failing),
    );
    expect(b.unattributedChargesAllTime.known).toBe(false);
    if (!b.unattributedChargesAllTime.known) {
      expect(b.unattributedChargesAllTime.cause).toBe("unavailable");
    }
  });

  it("its read is issued even when no ledger window is opened at all", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T16:00:00.000Z"));
    const { client, filters } = stubTables({});
    await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);
    // Below the floor the ledger WINDOW reads are skipped, but the all-time
    // count still goes out — filtered on the absence of a collection time.
    expect(filters.some((f) => f.op === "is" && f.args[0] === "charged_at")).toBe(true);
    expect(filters.some((f) => f.op === "gte" && f.args[0] === "charged_at")).toBe(false);
  });
});

describe("P2-A — the services read carries what the shared predicate needs", () => {
  it("projects name and modality, not only price", async () => {
    const { client, filters } = stubTables({});
    await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client);
    const servicesSelect = filters.find((f) => f.table === "services" && f.op === "select");
    expect(servicesSelect).toBeDefined();
    const projection = String(servicesSelect!.args[0]);
    // Without BOTH, `isConsultationService` silently degrades: no modality
    // sends every row down its name fallback, and no name makes the fallback
    // impossible too.
    expect(projection).toContain("name");
    expect(projection).toContain("modality");
    expect(projection).toContain("price_cents");
  });
});
