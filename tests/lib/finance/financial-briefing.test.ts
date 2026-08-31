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
    expect(new Set(tables)).toEqual(
      new Set(["appointments", "services", "payment_charge_attempts", "appointment_settlements"]),
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
function stubTables(byTable: Record<string, { rows?: unknown[]; count?: number | null }>) {
  const tables: string[] = [];
  const filters: Array<Filter & { table: string }> = [];
  const from = (table: string) => {
    tables.push(table);
    const stub = byTable[table] ?? { rows: [] };
    const result = () => ({
      data: stub.rows ?? [],
      error: null,
      count: stub.count === undefined ? (stub.rows ?? []).length : stub.count,
    });
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
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return { client: { from } as unknown as SupabaseClient, tables, filters };
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
    const { client } = stubTables({
      payment_charge_attempts: { rows: [{ charged_at: "2026-08-10T12:00:00.000Z" }] },
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

  it("NO LEDGER AT ALL is the same statement, maximally — flagged, not zeroed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T16:00:00.000Z"));
    const { client } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.money.covered && b.money.precedesLedger).toBe(true);
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

  it("is UNKNOWN, not zero, when the period is below the money floor", async () => {
    // Below the floor no ledger read is issued at all, so the count is not
    // established — and an unestablished count must never render as none.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T16:00:00.000Z"));
    const { client } = stubTables({});
    const b = granted(await loadFinancialsView(OWNER, studio("America/Toronto"), "month", client));
    expect(b.unattributedChargesAllTime.known).toBe(false);
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
