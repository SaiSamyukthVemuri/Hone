import { describe, expect, it } from "vitest";
import { getAvailableSlots } from "@/lib/booking/slots";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// PR B — per-practitioner slot generation. getAvailableSlots gains a trailing
// practitionerId; per-practitioner behaviour activates ONLY when
// studio.practitioner_capacity_enabled === true AND a practitionerId is passed.
// When off, the engine never touches the 0134/0135 columns and is byte-for-byte
// today's studio-wide behaviour.

const TZ = "America/Toronto";
const DATE = "2026-07-06"; // summer Monday, EDT, no DST transition
const localISO = (hhmm: string) => utcInstantFromLocal(DATE, hhmm, TZ).toISOString();
const starts = (slots: { start: string }[]) => slots.map((s) => s.start);

const P1 = "practitioner-1";
const P2 = "practitioner-2";
const STUDIO = "studio-1";

type Win = { practitioner_id: string | null; is_open: boolean; open_time: string; close_time: string };
type Res = { starts_at: string; ends_at: string };

// Filter-AWARE Supabase mock: it honours the practitioner_id / resource_key /
// studio_id filters the engine applies, so per-practitioner precedence and the
// resource_key reservation split are exercised deterministically.
function mock(data: {
  blockouts?: unknown[];
  overrides?: Win[];
  defaults?: Win[];
  reservationsByKey?: Record<string, Res[]>;
}) {
  function builder(table: string) {
    const f: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    for (const m of ["select", "lte", "gte", "lt", "gt", "order"]) b[m] = () => b;
    b.eq = (col: string, val: unknown) => {
      f[col] = val;
      return b;
    };
    b.is = (col: string, val: unknown) => {
      f[col] = val;
      return b;
    };
    const resolve = () => {
      if (table === "studio_blockouts") return { data: data.blockouts ?? [] };
      if (table === "studio_availability_overrides") {
        const want = "practitioner_id" in f ? f.practitioner_id : null;
        return { data: (data.overrides ?? []).find((r) => r.practitioner_id === want) ?? null };
      }
      if (table === "studio_availability_default") {
        const want = "practitioner_id" in f ? f.practitioner_id : null;
        return { data: (data.defaults ?? []).find((r) => r.practitioner_id === want) ?? null };
      }
      if (table === "studio_calendar_reservations") {
        const key = (f.resource_key ?? f.studio_id) as string;
        return { data: (data.reservationsByKey ?? {})[key] ?? [] };
      }
      return { data: null };
    };
    b.maybeSingle = () => Promise.resolve(resolve());
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR);
    return b;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => builder(t) } as any;
}

const studio = (opts?: { on?: boolean }) => ({
  id: STUDIO,
  timezone: TZ,
  default_appointment_duration_minutes: 60,
  buffer_minutes: 0,
  practitioner_capacity_enabled: opts?.on ?? false,
});

const open = (practitioner_id: string | null, o: string, c: string): Win => ({
  practitioner_id,
  is_open: true,
  open_time: `${o}:00`,
  close_time: `${c}:00`,
});

describe("OFF-safety: capacity off ignores practitionerId entirely", () => {
  it("uses the studio-wide window + studio-wide reservations even when a practitionerId is passed", async () => {
    const slots = await getAvailableSlots(
      mock({
        defaults: [open(null, "10:00", "17:00"), open(P1, "08:00", "20:00")],
        reservationsByKey: { [STUDIO]: [], [P1]: [] },
      }),
      studio({ on: false }),
      DATE,
      60,
      undefined,
      P1, // passed, but ignored because the flag is off
    );
    // Studio-wide 10–17 (hourly), NOT the practitioner's 08–20.
    expect(starts(slots)).toContain(localISO("10:00"));
    expect(starts(slots)).not.toContain(localISO("08:00"));
    expect(starts(slots)).not.toContain(localISO("19:00"));
  });
});

describe("ON: per-practitioner hours win over the studio fallback", () => {
  it("uses the practitioner's own hours when a per-practitioner row exists", async () => {
    const slots = await getAvailableSlots(
      mock({
        defaults: [open(null, "10:00", "17:00"), open(P1, "08:00", "12:00")],
        reservationsByKey: { [P1]: [] },
      }),
      studio({ on: true }),
      DATE,
      60,
      undefined,
      P1,
    );
    // P1's 08–12: 08,09,10,11 (11+60=12 close). Not studio 10–17.
    expect(starts(slots)).toContain(localISO("08:00"));
    expect(starts(slots)).toContain(localISO("11:00"));
    expect(starts(slots)).not.toContain(localISO("12:00"));
    expect(starts(slots)).not.toContain(localISO("16:00"));
  });

  it("falls back to studio-wide hours when the practitioner has no own row", async () => {
    const slots = await getAvailableSlots(
      mock({
        defaults: [open(null, "10:00", "17:00")], // only studio-wide
        reservationsByKey: { [P2]: [] },
      }),
      studio({ on: true }),
      DATE,
      60,
      undefined,
      P2,
    );
    expect(starts(slots)).toContain(localISO("10:00"));
    expect(starts(slots)).toContain(localISO("16:00"));
    expect(slots).toHaveLength(7);
  });
});

describe("ON: parallelism — each practitioner sees only their own reservations", () => {
  it("P1's booked hour blocks P1 but not P2", async () => {
    const common = {
      defaults: [open(null, "10:00", "17:00")],
    };
    // P1 booked 10:00–11:00 (in P1's resource_key timeline only).
    const p1res: Res = { starts_at: localISO("10:00"), ends_at: localISO("11:00") };
    const p1 = await getAvailableSlots(
      mock({ ...common, reservationsByKey: { [P1]: [p1res], [P2]: [] } }),
      studio({ on: true }),
      DATE,
      60,
      undefined,
      P1,
    );
    const p2 = await getAvailableSlots(
      mock({ ...common, reservationsByKey: { [P1]: [p1res], [P2]: [] } }),
      studio({ on: true }),
      DATE,
      60,
      undefined,
      P2,
    );
    // P1 cannot start at 10:00 (booked); P2 can (parallel, empty timeline).
    expect(starts(p1)).not.toContain(localISO("10:00"));
    expect(starts(p1)).toContain(localISO("11:00")); // packs right after
    expect(starts(p2)).toContain(localISO("10:00"));
  });
});

describe("ON: a per-practitioner day-closed override yields no slots for that practitioner", () => {
  it("respects a practitioner-specific closed override over the open studio default", async () => {
    const slots = await getAvailableSlots(
      mock({
        defaults: [open(null, "10:00", "17:00")],
        overrides: [
          { practitioner_id: P1, is_open: false, open_time: "00:00", close_time: "00:00" },
        ],
        reservationsByKey: { [P1]: [] },
      }),
      studio({ on: true }),
      DATE,
      60,
      undefined,
      P1,
    );
    expect(slots).toHaveLength(0);
  });
});
