import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAvailableSlots } from "@/lib/booking/slots";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// PR — smart / packed booking slots. getAvailableSlots no longer offers a fixed
// every-15-minute grid (10:00/10:15/10:30/…). Candidate starts are anchored to
// the opening time + immediately after each existing reservation's protected
// end, with a COARSE (hourly) fallback so an empty day still offers a few
// choices instead of one. Buffer / duration / overlap / DST semantics preserved.

const TZ = "America/Toronto";
const DATE = "2026-07-06"; // a summer Monday (EDT, no DST transition that day)

// Build a UTC ISO instant for a local HH:MM on DATE, using the SAME helper the
// generator uses — so expectations are tz/DST-correct by construction.
function localISO(hhmm: string): string {
  return utcInstantFromLocal(DATE, hhmm, TZ).toISOString();
}
const studio = (bufferMinutes: number) => ({
  id: "s1",
  timezone: TZ,
  default_appointment_duration_minutes: 60,
  buffer_minutes: bufferMinutes,
});

// Minimal chainable + thenable Supabase mock keyed by table. Chain methods
// return the builder; `.maybeSingle()` and awaiting both resolve the table's
// canned `{ data }`. The mock ignores filter args (deterministic test data).
function mockSupabase(d: {
  blockouts?: unknown[];
  override?: unknown | null;
  defaultRow?: unknown | null;
  reservations?: { starts_at: string; ends_at: string; source_kind?: string }[];
}) {
  const results: Record<string, { data: unknown }> = {
    studio_blockouts: { data: d.blockouts ?? [] },
    studio_availability_overrides: { data: d.override ?? null },
    studio_availability_default: { data: d.defaultRow ?? null },
    studio_calendar_reservations: { data: d.reservations ?? [] },
  };
  function builder(table: string) {
    const result = results[table] ?? { data: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "lte", "gte", "lt", "gt", "order"]) {
      b[m] = () => b;
    }
    b.maybeSingle = () => Promise.resolve(result);
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR);
    return b;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => builder(t) } as any;
}

// Open 10:00–17:00 every day (the mock ignores day_of_week).
const OPEN_10_17 = { is_open: true, open_time: "10:00:00", close_time: "17:00:00" };
// Chloe's studio: opens 11:00, late enough close for afternoon slots.
const OPEN_11_18 = { is_open: true, open_time: "11:00:00", close_time: "18:00:00" };
const starts = (slots: { start: string }[]) => slots.map((s) => s.start);

// Post-migration 0152 the appointment shadow stores the ACTUAL interval; the
// generator re-applies the studio buffer for source_kind === "appointment".
// Tests therefore model appointments with their REAL end + the source tag, and
// timed blocks / breaks with raw intervals (protected end = actual end).
const appt = (startHHMM: string, endHHMM: string) => ({
  starts_at: localISO(startHHMM),
  ends_at: localISO(endHHMM),
  source_kind: "appointment",
});
const block = (startHHMM: string, endHHMM: string) => ({
  starts_at: localISO(startHHMM),
  ends_at: localISO(endHHMM),
  source_kind: "timed_block",
});

describe("smart scheduling: empty day", () => {
  it("offers the opening anchor + a coarse hourly fallback — NOT every 15 minutes", async () => {
    const slots = await getAvailableSlots(
      mockSupabase({ defaultRow: OPEN_10_17, reservations: [] }),
      studio(15),
      DATE,
    );
    const s = starts(slots);
    // hourly from 10:00 to 16:00 (16:00 + 60 = 17:00 close): 7 slots.
    expect(s).toContain(localISO("10:00"));
    expect(s).toContain(localISO("11:00"));
    expect(s).toContain(localISO("16:00"));
    expect(slots).toHaveLength(7);
    // No arbitrary 15-minute grid slots.
    expect(s).not.toContain(localISO("10:15"));
    expect(s).not.toContain(localISO("10:30"));
    expect(s).not.toContain(localISO("11:30"));
    // The opening anchor renders a clean 12-hour label.
    expect(slots.find((x) => x.start === localISO("10:00"))?.startLabel).toBe(
      "10:00 AM",
    );
  });
});

describe("smart scheduling: packs after an existing appointment", () => {
  it("offers the slot immediately after appointment + buffer, not the gappy grid", async () => {
    // Appointment 10:00–11:00 with a 15-min buffer baked into ends_at (11:15).
    const slots = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_10_17,
        reservations: [appt("10:00", "11:00")],
      }),
      studio(15),
      DATE,
    );
    const s = starts(slots);
    // The after-appointment anchor (= appt end + buffer) is offered.
    expect(s).toContain(localISO("11:15"));
    // Slots overlapping the protected interval are not.
    expect(s).not.toContain(localISO("10:00"));
    expect(s).not.toContain(localISO("11:00"));
    // No arbitrary gappy slots around the appointment.
    expect(s).not.toContain(localISO("10:15"));
    expect(s).not.toContain(localISO("10:30"));
    expect(s).not.toContain(localISO("11:30"));
    expect(s).not.toContain(localISO("11:45"));
    // Later hourly fallback still available.
    expect(s).toContain(localISO("12:00"));
  });

  it("produces an after-appointment anchor for EACH existing appointment", async () => {
    const slots = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_10_17,
        reservations: [appt("10:00", "11:00"), appt("13:00", "14:00")],
      }),
      studio(15),
      DATE,
    );
    const s = starts(slots);
    expect(s).toContain(localISO("11:15"));
    expect(s).toContain(localISO("14:15"));
  });
});

describe("smart scheduling: packs immediately BEFORE the next appointment (Chloe 11:30)", () => {
  // Studio opens 11:00; existing appointment 13:00–14:00 (post-0152 shadow = the
  // ACTUAL interval; the generator re-applies the 30-min buffer → protected end
  // 14:30). Expected starts: 11:00, 11:30, 14:30, 15:00, 16:00, 17:00.
  //   - 11:30 packs BEFORE: 12:30 + 30 touches 13:00 (backward anchor
  //     reservation.start − duration − buffer = 11:30).
  //   - 14:30 packs AFTER: the appointment's protected end (14:00 + 30).
  //   - 14:00 is EXCLUDED — it violates the appointment's 30-min buffer, exactly
  //     as the authoritative DB validator (0152) rejects it.
  const chloeCase = () =>
    getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_11_18,
        reservations: [appt("13:00", "14:00")],
      }),
      studio(30),
      DATE,
      60,
    );

  it("produces the exact expected list — 11:30 + 14:30 in, 14:00 out (buffer parity)", async () => {
    const s = starts(await chloeCase());
    expect(s).toEqual([
      localISO("11:00"),
      localISO("11:30"),
      localISO("14:30"),
      localISO("15:00"),
      localISO("16:00"),
      localISO("17:00"),
    ]);
    // Explicit spec assertions.
    expect(s).toContain(localISO("11:30"));
    expect(s).toContain(localISO("14:30"));
    expect(s).not.toContain(localISO("12:00"));
    expect(s).not.toContain(localISO("13:00"));
    expect(s).not.toContain(localISO("14:00")); // buffer violation — must not appear
    // Sorted + unique.
    expect(s).toEqual([...s].sort());
    expect(new Set(s).size).toBe(s.length);
  });

  it("offers 11:30 identically under per-practitioner scheduling (capacity ON)", async () => {
    const s = starts(
      await getAvailableSlots(
        mockSupabase({
          defaultRow: OPEN_11_18,
          reservations: [appt("13:00", "14:00")],
        }),
        { ...studio(30), practitioner_capacity_enabled: true },
        DATE,
        60,
        undefined,
        "prac-1",
      ),
    );
    expect(s).toContain(localISO("11:30"));
  });

  it("does NOT offer a backward-packed slot that would cross the boundary (buffer respected)", async () => {
    // Same case but a 45-min buffer: 13:00 − 45 − 60 = 11:15 would be the anchor,
    // and its protected end (11:15 + 60 + 45 = 13:00) still touches — valid. But a
    // candidate one minute later must be rejected. Assert the exact anchor is the
    // latest offered start before the appointment, never anything overlapping.
    const s = starts(
      await getAvailableSlots(
        mockSupabase({
          defaultRow: OPEN_11_18,
          reservations: [appt("13:00", "14:00")],
        }),
        studio(45),
        DATE,
        60,
      ),
    );
    expect(s).toContain(localISO("11:15")); // 13:00 − 45 − 60
    expect(s).not.toContain(localISO("11:30")); // 11:30 + 60 + 45 = 13:15 > 13:00 → crosses
    expect(s).not.toContain(localISO("12:00"));
  });
});

describe("smart scheduling: buffer 0 vs 15", () => {
  it("buffer 0 → next slot is exactly at the appointment end", async () => {
    const slots = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_10_17,
        reservations: [appt("10:00", "11:00")],
      }),
      studio(0),
      DATE,
    );
    expect(starts(slots)).toContain(localISO("11:00"));
  });

  it("buffer 15 → next slot is the appointment end + buffer (11:15), not 11:00", async () => {
    const slots = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_10_17,
        reservations: [appt("10:00", "11:00")],
      }),
      studio(15),
      DATE,
    );
    const s = starts(slots);
    expect(s).toContain(localISO("11:15"));
    expect(s).not.toContain(localISO("11:00"));
  });
});

describe("smart scheduling: duration / fit / overlap / blocks", () => {
  it("does not offer an anchor whose full duration would not fit before close", async () => {
    // Appointment ending 16:30; a 60-min slot at 16:30 would end 17:30 > close.
    const slots = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_10_17,
        reservations: [appt("15:30", "16:30")],
      }),
      studio(0),
      DATE,
    );
    const s = starts(slots);
    expect(s).not.toContain(localISO("16:30")); // would overrun close
    // Nothing starts after the last fitting hour (16:00 + 60 = 17:00).
    expect(s.every((x) => x <= localISO("16:00"))).toBe(true);
  });

  it("rejects candidates overlapping a timed block / recurring break reservation", async () => {
    // A block 12:00–13:00 (raw, no buffer).
    const slots = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_10_17,
        reservations: [block("12:00", "13:00")],
      }),
      studio(15),
      DATE,
    );
    const s = starts(slots);
    expect(s).not.toContain(localISO("12:00")); // inside the block
    expect(s).toContain(localISO("13:00")); // immediately after the block
  });

  it("returns no slots when the whole day is blocked out", async () => {
    const slots = await getAvailableSlots(
      mockSupabase({
        blockouts: [{ starts_on: DATE, ends_on: DATE }],
        defaultRow: OPEN_10_17,
      }),
      studio(15),
      DATE,
    );
    expect(slots).toHaveLength(0);
  });

  it("returns no slots when the day is closed", async () => {
    const slots = await getAvailableSlots(
      mockSupabase({ defaultRow: { is_open: false, open_time: null, close_time: null } }),
      studio(15),
      DATE,
    );
    expect(slots).toHaveLength(0);
  });
});

describe("smart scheduling: shared generator / source pins", () => {
  const ACTIONS = readFileSync(
    path.resolve(__dirname, "../../../app/book/[slug]/actions.ts"),
    "utf8",
  );
  const SLOTS = readFileSync(
    path.resolve(__dirname, "../../../lib/booking/slots.ts"),
    "utf8",
  );

  it("public booking + re-verify use the SAME getAvailableSlots generator", () => {
    // fetchPublicSlotsAction (display) and publicBookAppointmentAction (re-verify)
    // both call getAvailableSlots, so a shown slot is generated identically to
    // the bookable check.
    expect(ACTIONS).toMatch(/getAvailableSlots/);
    expect(ACTIONS).toMatch(/publicBookAppointmentAction/);
    const calls = (ACTIONS.match(/getAvailableSlots\(/g) ?? []).length;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("the generator no longer uses a fixed 15-minute grid step", () => {
    expect(SLOTS).not.toMatch(/SLOT_GRANULARITY_MINUTES/);
    expect(SLOTS).toMatch(/FALLBACK_GRANULARITY_MINUTES/);
    // Anchors after each reservation's protected end (the packing rule).
    expect(SLOTS).toMatch(/candidateMs\.add\(c\.end\)/);
    // DST-correct: fallback candidates built via utcInstantFromLocal per step.
    expect(SLOTS).toMatch(/utcInstantFromLocal\(dateStr, minutesToHHMM\(m\), tz\)/);
  });
});
