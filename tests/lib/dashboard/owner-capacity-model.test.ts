import { describe, expect, it } from "vitest";

import { getOwnerCapacityBriefing } from "@/lib/dashboard/owner-capacity";
import {
  isActiveBooking,
  known,
  summarizeBookingDepth,
  summarizeFutureTreatment,
  unknown,
  type BriefingAppointment,
} from "@/lib/dashboard/owner-capacity-model";
import type { Studio } from "@/lib/types/database";
import type { SupabaseClient } from "@supabase/supabase-js";

// ===========================================================================
// OWNER CAPACITY — the rules, and the two ways the briefing could lie
// ===========================================================================
//
// The folds below are pure, so they are proved directly. The read soundness
// properties are proved against a FAKE Supabase client rather than the real
// database: the shapes that matter (`{ data: null, error }`, and a count that
// exceeds the rows actually returned) are client-contract shapes, and pinning
// them here means a regression fails in milliseconds rather than only in the
// db lane. tests/db/owner-capacity.db.test.ts proves the same properties
// against the REAL Data API row ceiling.

const appt = (over: Partial<BriefingAppointment> = {}): BriefingAppointment => ({
  id: "a1",
  clientId: "c1",
  startsAt: "2026-09-01T14:00:00.000Z",
  endsAt: "2026-09-01T15:00:00.000Z",
  status: "confirmed",
  isConsultation: false,
  ...over,
});

describe("isActiveBooking", () => {
  it("counts only the statuses the studio is actually committed to", () => {
    expect(isActiveBooking({ status: "confirmed" })).toBe(true);
    expect(isActiveBooking({ status: "completed" })).toBe(true);
    expect(isActiveBooking({ status: "cancelled" })).toBe(false);
    expect(isActiveBooking({ status: "no_show" })).toBe(false);
  });
});

describe("summarizeFutureTreatment", () => {
  it("counts treatment per client and sums real treatment minutes", () => {
    const r = summarizeFutureTreatment([
      appt({ id: "a1", clientId: "c1" }),
      appt({
        id: "a2",
        clientId: "c1",
        startsAt: "2026-09-08T14:00:00.000Z",
        endsAt: "2026-09-08T14:30:00.000Z",
      }),
      appt({ id: "a3", clientId: "c2" }),
    ]);
    expect(r.countByClient.get("c1")).toBe(2);
    expect(r.countByClient.get("c2")).toBe(1);
    expect(r.minutes).toBe(150);
  });

  it("excludes a consultation — a conversation booked is not treatment booked", () => {
    const r = summarizeFutureTreatment([
      appt({ id: "a1", clientId: "c1", isConsultation: true }),
    ]);
    expect(r.countByClient.has("c1")).toBe(false);
    expect(r.minutes).toBe(0);
  });

  it("excludes a cancelled appointment", () => {
    const r = summarizeFutureTreatment([
      appt({ id: "a1", clientId: "c1", status: "cancelled" }),
    ]);
    expect(r.countByClient.has("c1")).toBe(false);
    expect(r.minutes).toBe(0);
  });

  it("ignores an appointment whose span is not a positive number", () => {
    const r = summarizeFutureTreatment([
      appt({ id: "a1", clientId: "c1", endsAt: "not-a-date" }),
      appt({
        id: "a2",
        clientId: "c2",
        startsAt: "2026-09-01T15:00:00.000Z",
        endsAt: "2026-09-01T14:00:00.000Z",
      }),
    ]);
    // Both still COUNT as bookings — the client does have something on the
    // calendar. Only the minutes are refused.
    expect(r.countByClient.get("c1")).toBe(1);
    expect(r.countByClient.get("c2")).toBe(1);
    expect(r.minutes).toBe(0);
  });
});

describe("summarizeBookingDepth", () => {
  it("bands the active clients cumulatively", () => {
    const depth = summarizeBookingDepth(
      new Set(["c1", "c2", "c3", "c4"]),
      new Map([
        ["c1", 3],
        ["c2", 2],
        ["c3", 1],
      ]),
    );
    expect(depth).toEqual({ zero: 1, oneOrMore: 3, twoOrMore: 2, threeOrMore: 1 });
  });

  it("counts an active client with no future treatment in `zero`", () => {
    expect(summarizeBookingDepth(new Set(["c1"]), new Map()).zero).toBe(1);
  });

  it("ignores booked clients who are not in the active treatment set", () => {
    // A client booked for treatment without an open plan is not counted as an
    // active treatment client; this screen never infers the plan from a booking.
    const depth = summarizeBookingDepth(new Set(["c1"]), new Map([["stranger", 5]]));
    expect(depth).toEqual({ zero: 1, oneOrMore: 0, twoOrMore: 0, threeOrMore: 0 });
  });
});

describe("Fact", () => {
  it("carries a value, or a reason and no value", () => {
    expect(known(3)).toEqual({ known: true, value: 3 });
    expect(unknown<number>("because")).toEqual({ known: false, reason: "because" });
  });
});

// ---------------------------------------------------------------------------
// Read soundness
// ---------------------------------------------------------------------------

const STUDIO = { id: "s1", timezone: "America/Toronto" } as unknown as Studio;

type Canned = { rows: unknown[]; count: number | null; error?: { code: string } };

/**
 * A Supabase client stub whose every builder method returns itself and which
 * resolves to a canned page per table — the same thenable shape supabase-js
 * presents. `range` is honoured so paging can be observed.
 */
function stubClient(byTable: Record<string, Canned>): {
  client: SupabaseClient;
  ranges: Record<string, Array<[number, number]>>;
} {
  const ranges: Record<string, Array<[number, number]>> = {};
  const from = (table: string) => {
    const canned = byTable[table] ?? { rows: [], count: 0 };
    let lo = 0;
    let hi = Number.MAX_SAFE_INTEGER;
    const result = () => {
      if (canned.error) return { data: null, error: canned.error, count: null };
      (ranges[table] ??= []).push([lo, hi]);
      return {
        data: canned.rows.slice(lo, hi + 1),
        error: null,
        count: canned.count,
      };
    };
    const builder: Record<string | symbol, unknown> = {};
    const proxy: unknown = new Proxy(builder, {
      get: (_t, prop) => {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(result()).then(res, rej);
        }
        if (prop === "range") {
          return (a: number, b: number) => {
            lo = a;
            hi = b;
            return proxy;
          };
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return { client: { from } as unknown as SupabaseClient, ranges };
}

const clientRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));

describe("getOwnerCapacityBriefing — read soundness", () => {
  it("FAILS CLOSED when a read errors, rather than reporting an idle studio", async () => {
    // supabase-js RESOLVES with { data: null, error } on a transient failure.
    // Read as an empty row set that becomes "no active clients, nothing booked"
    // — a confident, wrong screen.
    const { client } = stubClient({
      clients: { rows: [], count: null, error: { code: "57014" } },
    });
    await expect(getOwnerCapacityBriefing(STUDIO, client)).rejects.toThrow(
      /owner_capacity_read_failed:clients:57014/,
    );
  });

  it("names the failing table, so a failure is diagnosable rather than generic", async () => {
    const { client } = stubClient({
      treatment_plans: { rows: [], count: null, error: { code: "PGRST301" } },
    });
    await expect(getOwnerCapacityBriefing(STUDIO, client)).rejects.toThrow(
      /owner_capacity_read_failed:treatment_plans:PGRST301/,
    );
  });

  it("pages past the first page instead of calling one page complete", async () => {
    const { client, ranges } = stubClient({
      clients: { rows: clientRows(1049), count: 1049 },
      treatment_plans: { rows: [{ client_id: "c1048" }], count: 1 },
      appointments: { rows: [], count: 0 },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    // Two pages requested, not one.
    expect(ranges.clients).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1049 });
    // The plan belongs to the LAST client in order — visible only to a read
    // that went past the ceiling.
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
  });

  it("goes UNKNOWN, never zero, when PostgREST reports no count at all", async () => {
    // No count means completeness was never established. Reporting the rows
    // that did arrive would present a truncated studio as a small one.
    const { client } = stubClient({
      clients: { rows: clientRows(3), count: null },
      treatment_plans: { rows: [{ client_id: "c1" }], count: 1 },
      appointments: { rows: [], count: 0 },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.totalRecords.known).toBe(false);
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
  });

  it("a studio with no treatment plans reports UNKNOWN active clients, not zero", async () => {
    const { client } = stubClient({
      clients: { rows: clientRows(5), count: 5 },
      treatment_plans: { rows: [], count: 0 },
      appointments: { rows: [], count: 0 },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 5 });
    expect(b.clients.activeTreatment.known).toBe(false);
    if (b.clients.activeTreatment.known) throw new Error("unreachable");
    expect(b.clients.activeTreatment.reason).toMatch(/It is not zero/);
    // And the figures that depend on it inherit the absence rather than
    // inventing a denominator.
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
  });

  it("does not count an active plan belonging to an archived client", async () => {
    // The clients read already excludes archived rows, so a plan whose client
    // is absent from that set is history, not current care.
    const { client } = stubClient({
      clients: { rows: [{ id: "c0" }], count: 1 },
      treatment_plans: {
        rows: [{ client_id: "c0" }, { client_id: "archived-one" }],
        count: 2,
      },
      appointments: { rows: [], count: 0 },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
  });

  it("reports the treatment time booked, and who is holding nothing", async () => {
    const { client } = stubClient({
      clients: { rows: [{ id: "c0" }, { id: "c1" }], count: 2 },
      treatment_plans: { rows: [{ client_id: "c0" }, { client_id: "c1" }], count: 2 },
      appointments: {
        rows: [
          {
            id: "a1",
            client_id: "c0",
            starts_at: "2026-09-01T14:00:00.000Z",
            ends_at: "2026-09-01T15:00:00.000Z",
            status: "confirmed",
            service: { modality: "laser", name: "Session" },
          },
        ],
        count: 1,
      },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.futureTreatmentMinutes).toEqual({ known: true, value: 60 });
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 1,
    });
    expect(b.depth).toEqual({
      known: true,
      value: { zero: 1, oneOrMore: 1, twoOrMore: 0, threeOrMore: 0 },
    });
  });

  it("treats an appointment with no service as treatment, not a consultation", async () => {
    const { client } = stubClient({
      clients: { rows: [{ id: "c0" }], count: 1 },
      treatment_plans: { rows: [{ client_id: "c0" }], count: 1 },
      appointments: {
        rows: [
          {
            id: "a1",
            client_id: "c0",
            starts_at: "2026-09-01T14:00:00.000Z",
            ends_at: "2026-09-01T15:00:00.000Z",
            status: "confirmed",
            service: null,
          },
        ],
        count: 1,
      },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.futureTreatmentMinutes).toEqual({ known: true, value: 60 });
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 0,
    });
  });

  it("does not count a booked CONSULTATION as the client having treatment booked", async () => {
    const { client } = stubClient({
      clients: { rows: [{ id: "c0" }], count: 1 },
      treatment_plans: { rows: [{ client_id: "c0" }], count: 1 },
      appointments: {
        rows: [
          {
            id: "a1",
            client_id: "c0",
            starts_at: "2026-09-01T14:00:00.000Z",
            ends_at: "2026-09-01T15:00:00.000Z",
            status: "confirmed",
            service: { modality: "consultation", name: "Consult" },
          },
        ],
        count: 1,
      },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 1,
    });
    expect(b.futureTreatmentMinutes).toEqual({ known: true, value: 0 });
  });
});
