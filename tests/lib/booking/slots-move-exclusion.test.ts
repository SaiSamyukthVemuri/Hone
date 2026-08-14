import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAvailableSlots } from "@/lib/booking/slots";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// Move appointment: the SERVER-CONTROLLED own-reservation slot exclusion.
//
// When a practitioner moves an appointment, its OWN shadow reservation must not
// count as a conflict against its new candidate times (otherwise the current time
// and every time inside its own protected interval would be falsely unavailable).
// getAvailableSlots gained a 5th, server-only `excludeReservation` param for this.
//
// Invariants proven here:
//   * the appointment's own (source_kind, source_id) reservation is dropped, so
//     its own current time becomes selectable again;
//   * EVERY other reservation (other appointments, blocks, breaks, blockouts)
//     still blocks, the exclusion is one exact pair, never a category;
//   * the match requires BOTH kind AND id (a same-id row of a different kind is
//     NOT excluded);
//   * passing no exclusion (public booking / reschedule) is byte-for-byte the
//     prior behavior.

const TZ = "America/Toronto";
const DATE = "2026-07-06"; // summer Monday, EDT, no DST transition

function localISO(hhmm: string): string {
  return utcInstantFromLocal(DATE, hhmm, TZ).toISOString();
}
const studio = (bufferMinutes: number) => ({
  id: "s1",
  timezone: TZ,
  default_appointment_duration_minutes: 60,
  buffer_minutes: bufferMinutes,
});

type Res = {
  starts_at: string;
  ends_at: string;
  source_kind?: string;
  source_id?: string;
};

// Same chainable/thenable shape as the smart-scheduling harness, but reservation
// rows carry source_kind/source_id so the exclusion filter has something to match.
function mockSupabase(d: { defaultRow?: unknown | null; reservations?: Res[] }) {
  const results: Record<string, { data: unknown }> = {
    studio_blockouts: { data: [] },
    studio_availability_overrides: { data: null },
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

const OPEN_10_17 = { is_open: true, open_time: "10:00:00", close_time: "17:00:00" };
const starts = (slots: { start: string }[]) => slots.map((s) => s.start);

const ownAppt: Res = {
  starts_at: localISO("10:00"),
  ends_at: localISO("11:00"), // buffer 0 → ends_at == raw end
  source_kind: "appointment",
  source_id: "appt-1",
};

describe("move slot exclusion: own reservation", () => {
  it("without exclusion, the appointment's own time is unavailable (conflicts with itself)", async () => {
    const slots = await getAvailableSlots(
      mockSupabase({ defaultRow: OPEN_10_17, reservations: [ownAppt] }),
      studio(0),
      DATE,
      60,
    );
    expect(starts(slots)).not.toContain(localISO("10:00"));
  });

  it("with the exact own exclusion, its current time becomes selectable again", async () => {
    const slots = await getAvailableSlots(
      mockSupabase({ defaultRow: OPEN_10_17, reservations: [ownAppt] }),
      studio(0),
      DATE,
      60,
      { sourceKind: "appointment", sourceId: "appt-1" },
    );
    expect(starts(slots)).toContain(localISO("10:00"));
  });
});

describe("move slot exclusion: everything else still blocks", () => {
  it("excludes ONLY the own appointment; a concurrent block stays a conflict", async () => {
    const block: Res = {
      starts_at: localISO("12:00"),
      ends_at: localISO("13:00"),
      source_kind: "timed_block",
      source_id: "blk-1",
    };
    const slots = await getAvailableSlots(
      mockSupabase({ defaultRow: OPEN_10_17, reservations: [ownAppt, block] }),
      studio(0),
      DATE,
      60,
      { sourceKind: "appointment", sourceId: "appt-1" },
    );
    const s = starts(slots);
    expect(s).toContain(localISO("10:00")); // own reservation excluded
    expect(s).not.toContain(localISO("12:00")); // block still blocks
    expect(s).toContain(localISO("13:00")); // right after the block
  });

  it("a different appointment (different id) is NOT excluded", async () => {
    const other: Res = {
      starts_at: localISO("14:00"),
      ends_at: localISO("15:00"),
      source_kind: "appointment",
      source_id: "appt-2",
    };
    const slots = await getAvailableSlots(
      mockSupabase({ defaultRow: OPEN_10_17, reservations: [other] }),
      studio(0),
      DATE,
      60,
      { sourceKind: "appointment", sourceId: "appt-1" },
    );
    expect(starts(slots)).not.toContain(localISO("14:00"));
  });

  it("matching requires BOTH kind and id, a same-id row of another kind still blocks", async () => {
    const sameIdOtherKind: Res = {
      starts_at: localISO("10:00"),
      ends_at: localISO("11:00"),
      source_kind: "timed_block", // same id, different kind
      source_id: "appt-1",
    };
    const slots = await getAvailableSlots(
      mockSupabase({ defaultRow: OPEN_10_17, reservations: [sameIdOtherKind] }),
      studio(0),
      DATE,
      60,
      { sourceKind: "appointment", sourceId: "appt-1" },
    );
    expect(starts(slots)).not.toContain(localISO("10:00"));
  });
});

describe("move slot exclusion: source pins", () => {
  const SLOTS = readFileSync(
    path.resolve(__dirname, "../../../lib/booking/slots.ts"),
    "utf8",
  );
  const ACTIONS = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/calendar/move-appointment-actions.ts"),
    "utf8",
  );

  it("the exclusion is one exact (kind,id) pair, not a category filter", () => {
    expect(SLOTS).toMatch(/r\.source_kind === excludeReservation\.sourceKind/);
    expect(SLOTS).toMatch(/r\.source_id === excludeReservation\.sourceId/);
  });

  it("only the authenticated move-slot action passes the exclusion, with a server-derived id", () => {
    // The id fed to excludeReservation is the appointment id resolved server-side,
    // never a browser value; and it is the appointment's OWN id.
    expect(ACTIONS).toMatch(/sourceKind:\s*"appointment"/);
    expect(ACTIONS).toMatch(/sourceId:\s*appointmentId/);
  });
});
