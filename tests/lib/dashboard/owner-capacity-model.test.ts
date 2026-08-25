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
//
// The briefing is ONE statement rooted on current clients, so the stub below
// models exactly that: a root rowset, an exact root count, and per-client
// embedded aggregates. It exercises the shapes the real Data API produces,
// including the one that cost this module a redesign — an embedded rowset
// silently clipped while the response's own Content-Range still describes only
// the root.

const STUDIO = { id: "s1", timezone: "America/Toronto" } as unknown as Studio;

type StubBooking = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  service: { modality: string | null; name: string } | null;
};

type StubClient = {
  id: string;
  /** Open plans for this client. A COUNT in the real read, never rows. */
  plans: number;
  /**
   * Replace the plan aggregate verbatim — for the absent and malformed shapes
   * a real response can carry. `[]`, a non-numeric count, NaN, a negative.
   */
  planCountEmbed?: unknown;
  bookings: StubBooking[];
  /**
   * What the embedded COUNT reports, when it differs from `bookings.length` —
   * i.e. the clipped case. Defaults to honest agreement.
   */
  trueBookingCount?: number;
  /** Drop the aggregate entirely, the way a disabled/absent count would. */
  noBookingCount?: boolean;
};

const booking = (over: Partial<StubBooking> = {}): StubBooking => ({
  id: "b1",
  starts_at: "2026-09-01T14:00:00.000Z",
  ends_at: "2026-09-01T15:00:00.000Z",
  status: "confirmed",
  service: { modality: "laser", name: "Session" },
  ...over,
});

type Stub = {
  clients: StubClient[];
  /** Exact root count. Defaults to the number of client rows (i.e. complete). */
  count?: number | null;
  error?: { code: string };
};

/**
 * A Supabase client stub whose every builder method returns itself and which
 * resolves to one canned response — the same thenable shape supabase-js
 * presents. `range` is recorded so "exactly one statement" can be asserted.
 */
function stubClient(stub: Stub): {
  client: SupabaseClient;
  calls: { table: string; range: [number, number] }[];
} {
  const calls: { table: string; range: [number, number] }[] = [];
  const from = (table: string) => {
    let lo = 0;
    let hi = Number.MAX_SAFE_INTEGER;
    const result = () => {
      if (stub.error) return { data: null, error: stub.error, count: null };
      calls.push({ table, range: [lo, hi] });
      const rows = stub.clients.slice(lo, hi + 1).map((c) => ({
        id: c.id,
        plan_count:
          c.planCountEmbed !== undefined ? c.planCountEmbed : [{ count: c.plans }],
        bookings: c.bookings,
        booking_count: c.noBookingCount
          ? []
          : [{ count: c.trueBookingCount ?? c.bookings.length }],
      }));
      return {
        data: rows,
        error: null,
        count: stub.count === undefined ? stub.clients.length : stub.count,
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
  return { client: { from } as unknown as SupabaseClient, calls };
}

const manyClients = (n: number): StubClient[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, plans: 0, bookings: [] }));

describe("getOwnerCapacityBriefing — one statement, one snapshot", () => {
  it("FAILS CLOSED when the read errors, rather than reporting an idle studio", async () => {
    // supabase-js RESOLVES with { data: null, error } on a transient failure.
    // Read as an empty row set that becomes "no active clients, no treatment booked"
    // — a confident, wrong screen.
    const { client } = stubClient({ clients: [], error: { code: "57014" } });
    await expect(getOwnerCapacityBriefing(STUDIO, client)).rejects.toThrow(
      /owner_capacity_read_failed:capacity_snapshot:57014/,
    );
  });

  it("issues EXACTLY ONE statement, against the client root", async () => {
    // Three requests are three snapshots, and joining them reports combinations
    // of states that never coexisted — a plan closed and a booking inserted
    // between two of them is enough. One statement is one snapshot by
    // construction, so the count of statements IS the correctness property.
    const { client, calls } = stubClient({
      clients: [{ id: "c0", plans: 1, bookings: [booking()] }],
    });
    await getOwnerCapacityBriefing(STUDIO, client);
    expect(calls).toEqual([{ table: "clients", range: [0, 999] }]);
  });

  it("keeps the exact TOTAL but refuses every id-dependent figure past the root ceiling", async () => {
    // The operator's worked example: 1,050 clients, one response carries 1,000.
    // Content-Range still reports 1,050 truthfully and the ceiling does not
    // bound it, so the total survives. Everything computed over the IDENTIFIERS
    // must not be reported at all.
    const { client } = stubClient({ clients: manyClients(1000), count: 1050 });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1050 });
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
    expect(b.futureTreatmentMinutes.known).toBe(false);
  });

  it("a root rowset that exactly fills one response IS complete, so the ceiling is not a false alarm", async () => {
    // The guard is `rows.length !== total`, not "did we touch the ceiling".
    // Without this control the fix could trade a false zero for a permanent
    // false unknown and no test would notice.
    const rows = manyClients(1000);
    rows[999] = { id: "c999", plans: 1, bookings: [] };
    const { client } = stubClient({ clients: rows, count: 1000 });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1000 });
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 1,
    });
  });

  it("goes UNKNOWN, never zero, when PostgREST reports no root count at all", async () => {
    const { client } = stubClient({
      clients: [{ id: "c0", plans: 1, bookings: [] }],
      count: null,
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.totalRecords.known).toBe(false);
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.depth.known).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The embedded ceiling — the reason this module is one statement and not one
  // query with a naive embed
  // -------------------------------------------------------------------------

  it("detects a CLIPPED embedded rowset, which the response itself does not report", async () => {
    // Measured against the real Data API: a client with 1,100 qualifying
    // appointments comes back with 1,000, per parent row, and Content-Range
    // describes only the ROOT. Nothing in the response body says rows are
    // missing — so the rows are checked against a count of the same filtered
    // population, asked for in the same statement.
    const { client } = stubClient({
      clients: [
        {
          id: "c0",
          plans: 1,
          bookings: [booking({ id: "b1" })],
          trueBookingCount: 1100,
        },
      ],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.futureTreatmentMinutes.known).toBe(false);
    expect(b.depth.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    if (b.futureTreatmentMinutes.known) throw new Error("unreachable");
    expect(b.futureTreatmentMinutes.reason).toMatch(/more future appointments/i);
    // The client population itself was never in doubt.
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1 });
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
  });

  it("treats a MISSING embedded count as unestablished, not as agreement", async () => {
    // No count to check against is the same epistemic state as a short read.
    const { client } = stubClient({
      clients: [{ id: "c0", plans: 1, bookings: [booking()], noBookingCount: true }],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.futureTreatmentMinutes.known).toBe(false);
    expect(b.depth.known).toBe(false);
  });

  it("a clipped rowset OUTSIDE the active population spares booking depth", async () => {
    // Depth reads only the active-treatment population, so a stranger's clipped
    // bookings cannot change it. The studio-wide minutes total still degrades.
    const { client } = stubClient({
      clients: [
        { id: "c0", plans: 1, bookings: [] },
        { id: "stranger", plans: 0, bookings: [booking()], trueBookingCount: 1100 },
      ],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.futureTreatmentMinutes.known).toBe(false);
    expect(b.depth).toEqual({
      known: true,
      value: { zero: 1, oneOrMore: 0, twoOrMore: 0, threeOrMore: 0 },
    });
  });

  // -------------------------------------------------------------------------
  // Active treatment is an intersection, and an empty one is UNKNOWN
  // -------------------------------------------------------------------------

  it("a studio with no treatment plans reports UNKNOWN active clients, not zero", async () => {
    const { client } = stubClient({ clients: manyClients(5) });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 5 });
    expect(b.clients.activeTreatment.known).toBe(false);
    if (b.clients.activeTreatment.known) throw new Error("unreachable");
    expect(b.clients.activeTreatment.reason).toMatch(/It is not zero/);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
  });

  it("when EVERY open plan belongs to an archived client, active treatment is UNKNOWN — not zero", async () => {
    // Rooting on CURRENT clients makes this structural: an archived client's
    // plan is not in the result at all. The empty intersection must still read
    // UNKNOWN rather than a confident 0, which on a page about chasing work
    // would read as "nobody needs booking".
    const { client } = stubClient({ clients: [{ id: "c0", plans: 0, bookings: [] }] });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.activeTreatment.known).toBe(false);
    if (b.clients.activeTreatment.known) throw new Error("unreachable");
    expect(b.clients.activeTreatment.reason).toMatch(/It is not zero/);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    expect(b.depth.known).toBe(false);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1 });
  });

  // -------------------------------------------------------------------------
  // Plan evidence is TRI-STATE: open / none / unreadable
  // -------------------------------------------------------------------------

  it("one client's MISSING plan count refuses the whole active-treatment population", async () => {
    // The defect this replaced: `?? 0` classified the unreadable client as
    // having no plan, `activeIds` stayed non-empty because the OTHER client
    // answered, and the loader published a known active-treatment count that
    // was too low — confident and understated, the worst combination.
    const { client } = stubClient({
      clients: [
        { id: "a", plans: 1, bookings: [] },
        { id: "b", plans: 0, planCountEmbed: [], bookings: [] },
      ],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.depth.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    // The specific regression, stated as its own assertion.
    expect(b.clients.activeTreatment).not.toEqual({ known: true, value: 1 });
    if (b.clients.activeTreatment.known) throw new Error("unreachable");
    expect(b.clients.activeTreatment.reason).toMatch(/could not be read/i);
  });

  it.each([
    ["absent embed", [] as unknown],
    ["null embed", null as unknown],
    ["non-numeric count", [{ count: "many" }] as unknown],
    ["NaN count", [{ count: Number.NaN }] as unknown],
    ["negative count", [{ count: -1 }] as unknown],
    ["not an array", { count: 1 } as unknown],
  ])("a MALFORMED plan count (%s) takes the same UNKNOWN path as a missing one", async (
    _label,
    embed,
  ) => {
    // Malformed is not absence. Every one of these shapes must refuse rather
    // than coerce to a number.
    const { client } = stubClient({
      clients: [
        { id: "a", plans: 1, bookings: [] },
        { id: "b", plans: 0, planCountEmbed: embed, bookings: [] },
      ],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.depth.known).toBe(false);
  });

  it("a VALID ZERO plan count is a fact, not an absence", async () => {
    // The control that stops the fix over-correcting: a genuinely-read 0 must
    // still mean "this client has no open plan", so the population stays
    // provable and the client is simply not in it.
    const { client } = stubClient({
      clients: [
        { id: "a", plans: 1, bookings: [] },
        { id: "b", plans: 0, bookings: [] },
      ],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 1,
    });
    expect(b.depth).toEqual({
      known: true,
      value: { zero: 1, oneOrMore: 0, twoOrMore: 0, threeOrMore: 0 },
    });
  });

  it("a VALID POSITIVE plan count works normally", async () => {
    const { client } = stubClient({
      clients: [{ id: "a", plans: 3, bookings: [booking()] }],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    // Three open plans is still ONE client in active treatment.
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
    expect(b.depth).toEqual({
      known: true,
      value: { zero: 0, oneOrMore: 1, twoOrMore: 0, threeOrMore: 0 },
    });
  });

  it("an unreadable plan count leaves booking-only figures independently truthful", async () => {
    // Plan evidence and booking evidence are different questions. Committed
    // treatment minutes does not depend on plan membership, so refusing it here
    // would be over-refusal — its own kind of untruth.
    const { client } = stubClient({
      clients: [
        { id: "a", plans: 0, planCountEmbed: [], bookings: [booking()] },
        { id: "b", plans: 1, bookings: [] },
      ],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.activeTreatment.known).toBe(false);
    expect(b.depth.known).toBe(false);
    // ...but these two are unaffected.
    expect(b.futureTreatmentMinutes).toEqual({ known: true, value: 60 });
    expect(b.clients.totalRecords).toEqual({ known: true, value: 2 });
  });

  it("an all-unreadable studio says the plans could not be READ, not that there are none", async () => {
    // Two different claims. Ordering the guards the other way round would emit
    // "no open treatment plan is on file", which is a statement about the
    // studio rather than about the read.
    const { client } = stubClient({
      clients: [{ id: "a", plans: 0, planCountEmbed: [], bookings: [] }],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    if (b.clients.activeTreatment.known) throw new Error("unreachable");
    expect(b.clients.activeTreatment.reason).toMatch(/could not be read/i);
    expect(b.clients.activeTreatment.reason).not.toMatch(/It is not zero/);
  });

  // -------------------------------------------------------------------------
  // Service classification
  // -------------------------------------------------------------------------

  it("reports the treatment time booked, and who is holding nothing", async () => {
    const { client } = stubClient({
      clients: [
        { id: "c0", plans: 1, bookings: [booking()] },
        { id: "c1", plans: 1, bookings: [] },
      ],
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

  it("a booking with NO SERVICE is UNKNOWN, and takes its dependent figures with it", async () => {
    // service_id is nullable, and the embed also vanishes when a service row is
    // deleted. Modality and name are the whole input to isConsultationService,
    // so the classification genuinely cannot be made. Calling it treatment was a
    // guess wearing a fact's clothes, and it failed in the direction that
    // matters: a consultation whose service was deleted counted as booked
    // treatment and removed its client from the no-treatment-booked list.
    const { client } = stubClient({
      clients: [{ id: "c0", plans: 1, bookings: [booking({ service: null })] }],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.futureTreatmentMinutes.known).toBe(false);
    expect(b.depth.known).toBe(false);
    expect(b.clients.activeTreatmentWithoutFutureBooking.known).toBe(false);
    if (b.futureTreatmentMinutes.known) throw new Error("unreachable");
    expect(b.futureTreatmentMinutes.reason).toMatch(/no service on record/i);
    expect(b.clients.totalRecords).toEqual({ known: true, value: 1 });
    expect(b.clients.activeTreatment).toEqual({ known: true, value: 1 });
  });

  it("an unclassifiable booking OUTSIDE the active population spares booking depth", async () => {
    const { client } = stubClient({
      clients: [
        { id: "c0", plans: 1, bookings: [] },
        { id: "stranger", plans: 0, bookings: [booking({ service: null })] },
      ],
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
    const { client } = stubClient({
      clients: [
        {
          id: "c0",
          plans: 1,
          bookings: [booking({ status: "cancelled", service: null })],
        },
      ],
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
      clients: [
        {
          id: "c0",
          plans: 1,
          bookings: [booking({ service: { modality: "consultation", name: "Consult" } })],
        },
      ],
    });
    const b = await getOwnerCapacityBriefing(STUDIO, client);
    expect(b.clients.activeTreatmentWithoutFutureBooking).toEqual({
      known: true,
      value: 1,
    });
    expect(b.futureTreatmentMinutes).toEqual({ known: true, value: 0 });
  });
});
