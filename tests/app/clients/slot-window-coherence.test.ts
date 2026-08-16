import { describe, it, expect, beforeEach, vi } from "vitest";

// ONE RESPONSE MAY NOT ASSERT CONTRADICTORY BOOKING FACTS.
//
// The internal fetch performs TWO independent DB read sequences:
//   1) getAvailableSlots -> its own blockout + availability reads -> slots
//   2) readFullDayBlockout + resolveAvailabilityWindow -> the companion window
//
// Nothing reconciled them, so a response could say "availability could not be
// verified" while simultaneously offering bookable suggestions -- and the
// suggestion path requires no window to submit at all. The companion read is
// the stricter, later one, so it is the presentation authority and the response
// is made coherent on the SERVER, before React sees it.
//
// These tests script per-table read outcomes IN CALL ORDER, which is the only
// way to express "the first sequence succeeded and the second did not".

const TZ = "America/Toronto";
const DATE = "2099-07-06";

type Outcome = { data: unknown; error: unknown };
// Per-table scripted outcomes, consumed in call order; the last repeats.
let script: Record<string, Outcome[]> = {};
const calls: Record<string, number> = {};

function next(table: string): Outcome {
  const seq = script[table] ?? [{ data: null, error: null }];
  const i = calls[table] ?? 0;
  calls[table] = i + 1;
  return seq[Math.min(i, seq.length - 1)];
}

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const op of ["eq", "is", "lt", "gt", "lte", "gte", "in", "neq"]) {
        b[op] = () => b;
      }
      b.select = () => b;
      b.order = () => b;
      b.limit = () => b;
      b.maybeSingle = () => Promise.resolve(next(table));
      b.then = (f: (v: unknown) => unknown) => Promise.resolve(next(table)).then(f);
      return b;
    },
  };
}

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: "owner", active: true },
    studio: {
      id: "studio-1",
      timezone: TZ,
      default_appointment_duration_minutes: 60,
      buffer_minutes: 0,
      practitioner_capacity_enabled: false,
    },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));

import { fetchSlotsForClientBookingAction } from "@/app/(app)/clients/[id]/booking-actions";

const SERVICE: Outcome = { data: { default_duration_minutes: 60 }, error: null };
const NO_ROWS: Outcome = { data: [], error: null };
const OPEN = (o: string, c: string): Outcome => ({
  data: { is_open: true, open_time: `${o}:00`, close_time: `${c}:00` },
  error: null,
});
const READ_ERR: Outcome = { data: null, error: { code: "PGRST301" } };

const fetchSlots = () =>
  fetchSlotsForClientBookingAction({ serviceId: "svc-1", date: DATE });

beforeEach(() => {
  script = {};
  for (const k of Object.keys(calls)) delete calls[k];
});

describe("slot/window coherence — the response is reconciled server-side", () => {
  it("CASE A: first sequence succeeds, second FAILS -> unknown window MUST carry no slots", async () => {
    script = {
      services: [SERVICE],
      // 1st blockout read (slot generation) succeeds; 2nd (companion) FAILS.
      studio_blockouts: [NO_ROWS, READ_ERR],
      studio_availability_overrides: [{ data: null, error: null }],
      studio_availability_default: [OPEN("09", "17")],
      studio_calendar_reservations: [NO_ROWS],
    };
    const r = await fetchSlots();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.window.kind).toBe("unknown");
    // A response that says "I could not verify availability" may not also
    // hand the practitioner bookable suggestions.
    expect(r.slots).toEqual([]);
  });

  it("CASE B: companion window CLOSED -> no slots may be offered", async () => {
    script = {
      services: [SERVICE],
      studio_blockouts: [NO_ROWS, NO_ROWS],
      studio_availability_overrides: [{ data: null, error: null }],
      // Generation sees open; the strict companion read sees closed.
      studio_availability_default: [
        OPEN("09", "17"),
        { data: { is_open: false, open_time: null, close_time: null }, error: null },
      ],
      studio_calendar_reservations: [NO_ROWS],
    };
    const r = await fetchSlots();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.window.kind).toBe("closed");
    expect(r.slots).toEqual([]);
  });

  it("CASE C: the OPEN window narrowed between reads -> stale late slots are suppressed", async () => {
    script = {
      services: [SERVICE],
      studio_blockouts: [NO_ROWS, NO_ROWS],
      studio_availability_overrides: [{ data: null, error: null }],
      // Generation: 09:00-17:00. Companion (authoritative): 09:00-15:00.
      studio_availability_default: [OPEN("09", "17"), OPEN("09", "15")],
      studio_calendar_reservations: [NO_ROWS],
    };
    const r = await fetchSlots();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.window).toEqual({ kind: "open", openTime: "09:00", closeTime: "15:00" });
    expect(r.slots.length).toBeGreaterThan(0); // the morning ones survive
    // Nothing may be offered that does not fit the window we just returned.
    const local = (iso: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(iso));
    for (const s of r.slots) {
      const [h, m] = local(s.start).split(":").map(Number);
      expect(h * 60 + m + 60).toBeLessThanOrEqual(15 * 60);
    }
  });

  it("CASE D: both reads agree -> ordinary suggestions survive untouched", async () => {
    script = {
      services: [SERVICE],
      studio_blockouts: [NO_ROWS, NO_ROWS],
      studio_availability_overrides: [{ data: null, error: null }],
      studio_availability_default: [OPEN("09", "17"), OPEN("09", "17")],
      studio_calendar_reservations: [NO_ROWS],
    };
    const r = await fetchSlots();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.window).toEqual({ kind: "open", openTime: "09:00", closeTime: "17:00" });
    expect(r.slots.length).toBeGreaterThan(0);
  });
});
