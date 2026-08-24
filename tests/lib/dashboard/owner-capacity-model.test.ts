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
  serviceClass: "treatment",
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
      appt({ id: "a1", clientId: "c1", serviceClass: "consultation" }),
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

  it("issues exactly ONE request per read, and never unions two into a population", async () => {
    // Offset paging cannot produce a snapshot. Between two range() requests a
    // row can be inserted, archived, cancelled or deleted, shifting every later
    // offset — read the first 1,000 of 1,050 clients, archive one of them, and
    // the next request returns 49 against a new count of 1,049. The arithmetic
    // says complete while a live client was skipped. There is no cursor or
    // retry that fixes it without a transaction boundary this module cannot
    // open, so multi-request enumeration is gone rather than patched.
    const { client, ranges } = stubClient({
      clients: { rows: clientRows(1050), count: 1050 },
      treatment_plans: { rows: [{ client_id: "c1049" }], count: 1 },
      appointments: { rows: [], count: 0 },
    });
    await getOwnerCapacityBriefing(STUDIO, client);
    expect(ranges.clients).toEqual([[0, 999]]);
    expect(ranges.treatment_plans).toEqual([[0, 999]]);
    expect(ranges.appointments).toEqual([[0, 999]]);
  });

  it("keeps the exact TOTAL but refuses every id-dependent figure past the ceiling", async () => {
    // The operator's worked example: 1,050 clients, one response carries 1,000.
    // Content-Range still reports 1,050 truthfully and the ceiling does not
    // bound it, so the total survives. Who is in treatment, who has nothing
    // booked and how deeply anyone is booked are computed over the IDENTIFIERS,
    // which were never fully in hand — so they must not be reported at all.
    const { client } = stubClient({
      clients: { rows: clientRows(1050), count: 1050 },
      treatment_plans: { rows: [{ client_id: "c1049" }], count: 1 },
      appointments: { rows: [], count: 0 },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1050 });
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
  });

  it("a rowset that exactly fills one response IS complete, so the ceiling is not a false alarm", async () => {
    // The guard must be `rows.length !== total`, not "did we hit the ceiling".
    // A studio of exactly 1,000 is fully in hand and must still get real
    // figures, or the fix would have replaced a false zero with a false unknown.
    const { client } = stubClient({
      clients: { rows: clientRows(1000), count: 1000 },
      treatment_plans: { rows: [{ client_id: "c999" }], count: 1 },
      appointments: { rows: [], count: 0 },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1000 });
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 1,
    });
  });

  it("refuses id-dependent figures when the PLANS read is the one that overflows", async () => {
    // Symmetry: the clients read being complete proves nothing about the plans
    // read, and active treatment is an intersection of both.
    const { client } = stubClient({
      clients: { rows: clientRows(5), count: 5 },
      treatment_plans: {
        rows: Array.from({ length: 1000 }, (_, i) => ({ client_id: `c${i}` })),
        count: 1200,
      },
      appointments: { rows: [], count: 0 },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 5 });
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.depth.known).toBe(false);
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

  it("when EVERY open plan belongs to an archived client, active treatment is UNKNOWN — not zero", async () => {
    // The negative control the previous test was missing. Excluding the
    // archived plan is correct; the bug was what happened when exclusion
    // emptied the set. `planRows.rows` is non-empty, so a "no plans on file"
    // guard never fired, and the screen printed a confident 0 — which on a page
    // about chasing work reads as "nobody needs booking". A studio with no
    // plans and a studio whose only plans are archived are the SAME state: no
    // evidence any CURRENT client is in a course of treatment.
    const { client } = stubClient({
      clients: { rows: [{ id: "c0" }], count: 1 },
      treatment_plans: { rows: [{ client_id: "archived-one" }], count: 1 },
      appointments: { rows: [], count: 0 },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.activeTreatment.known).toBe(false);
    if (b.clients.activeTreatment.known) throw new Error("unreachable");
    expect(b.clients.activeTreatment.reason).toMatch(/It is not zero/);
    // And everything derived from it inherits the absence.
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
    // The client total is unaffected — it never needed the plans.
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1 });
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

  it("an appointment with NO SERVICE is UNKNOWN, and takes its dependent figures with it", async () => {
    // service_id is nullable, and the embed also vanishes when a service row is
    // deleted. Modality and name are the whole input to isConsultationService,
    // so the classification genuinely cannot be made. Calling it treatment was
    // a guess wearing a fact's clothes, and it failed in the direction that
    // matters: a consultation whose service was deleted counted as booked
    // treatment and removed its client from the "nothing booked" list.
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
    expect(b.futureTreatmentMinutes.known).toBe(false);
    expect(b.depth.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    if (b.futureTreatmentMinutes.known) throw new Error("unreachable");
    expect(b.futureTreatmentMinutes.reason).toMatch(/no service on record/i);
    // The client population itself is unaffected — only the appointment-derived
    // figures degrade.
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1 });
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
  });

  it("an unclassifiable booking OUTSIDE the active population spares booking depth", async () => {
    // Depth is computed only over active treatment clients, so an orphaned
    // appointment for someone with no open plan cannot change it. Total
    // committed minutes sums every booking, so that one still degrades. Two
    // different blast radii, deliberately not merged — failing depth closed
    // here would be over-refusal, which is its own kind of untruth.
    const { client } = stubClient({
      clients: { rows: [{ id: "c0" }, { id: "stranger" }], count: 2 },
      treatment_plans: { rows: [{ client_id: "c0" }], count: 1 },
      appointments: {
        rows: [
          {
            id: "a1",
            client_id: "stranger",
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
    expect(b.futureTreatmentMinutes.known).toBe(false);
    expect(b.depth).toEqual({
      known: true,
      value: { zero: 1, oneOrMore: 0, twoOrMore: 0, threeOrMore: 0 },
    });
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 1,
    });
  });

  it("a CANCELLED service-less booking does not contaminate anything", async () => {
    // Classification is only attempted for bookings the studio is committed to.
    // A cancelled one is out of scope before its service is ever consulted.
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
            status: "cancelled",
            service: null,
          },
        ],
        count: 1,
      },
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.futureTreatmentMinutes).toEqual({ known: true, value: 0 });
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 1,
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
