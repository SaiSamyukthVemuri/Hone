import { describe, expect, it } from "vitest";
import {
  classifyAgainstWindow,
  decideManualTime,
  readFullDayBlockout,
  resolveAvailabilityWindow,
  type AvailabilityWindow,
} from "@/lib/booking/availability-window";

// The availability-window authority: the thing Hone did not have.
//
// Before this, the only code that knew a practitioner's real working hours was
// the code that generates PACKED SUGGESTIONS, so the internal booking action
// substituted "is this one of the suggestions?" for "is this inside your
// hours?" — and a deliberate 15:30 on a 09:00-17:00 day was reported as an
// availability violation and filed as an out-of-hours override.

const OPEN_9_17: AvailabilityWindow = {
  kind: "open",
  openTime: "09:00",
  closeTime: "17:00",
};
const CLOSED: AvailabilityWindow = { kind: "closed" };

const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

describe("classifyAgainstWindow — mirrors validate_appointment_availability", () => {
  it("a time strictly inside the window is inside_availability", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("15:30"), 60)).toBe(
      "inside_availability",
    );
  });

  it("THE REPORT: 15:30 is inside, even though it is not a packed suggestion", () => {
    // 15:30 + 60 = 16:30 <= 17:00. Nothing about suggestion membership can
    // reach this function, which is the point.
    expect(classifyAgainstWindow(OPEN_9_17, at("15:30"), 60)).toBe(
      "inside_availability",
    );
  });

  it("the opening edge is inclusive", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("09:00"), 60)).toBe(
      "inside_availability",
    );
  });

  it("one minute before open is outside", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("08:59"), 60)).toBe(
      "outside_availability",
    );
  });

  it("the SERVICE end may land exactly on close", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("16:00"), 60)).toBe(
      "inside_availability",
    );
  });

  it("a service end one minute past close is outside", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("16:01"), 60)).toBe(
      "outside_availability",
    );
  });

  it("the window is measured on the SERVICE end, never a buffered end", () => {
    // Hone lets the trailing studio buffer spill past closing time: the slot
    // engine's fit filter, migration 0152's `v_end_time > v_close`, and 0170's
    // port all agree. Subtracting a buffer here would refuse the last
    // appointment of every day that Hone already offers.
    expect(classifyAgainstWindow(OPEN_9_17, at("16:00"), 60)).toBe(
      "inside_availability",
    );
  });

  it("duration changes the verdict for the same start", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("16:30"), 30)).toBe(
      "inside_availability",
    );
    expect(classifyAgainstWindow(OPEN_9_17, at("16:30"), 60)).toBe(
      "outside_availability",
    );
  });

  it("a closed day is practitioner_closed, NOT outside_availability", () => {
    // Different truths deserve different words: a day you do not work is not
    // the same as a time outside the hours you do work.
    expect(classifyAgainstWindow(CLOSED, at("15:30"), 60)).toBe(
      "practitioner_closed",
    );
  });

  it("an appointment that would cross local midnight is refused", () => {
    // 0152 refuses `v_end_date <> v_local_date` BEFORE comparing against close,
    // so a late booking cannot pass by arithmetic that wraps.
    const lateWindow: AvailabilityWindow = {
      kind: "open",
      openTime: "09:00",
      closeTime: "23:59",
    };
    expect(classifyAgainstWindow(lateWindow, at("23:30"), 60)).toBe(
      "outside_availability",
    );
  });
});

describe("decideManualTime — the one law both booking surfaces use", () => {
  const base = {
    window: OPEN_9_17 as AvailabilityWindow | null,
    localTime: "15:30",
    serviceDurationMinutes: 60,
    customDurationMinutes: null as number | null,
  };

  it("an inside-hours manual time does NOT require the override", () => {
    const d = decideManualTime(base);
    expect(d.verdict).toBe("inside_availability");
    expect(d.requiresOutsideOverride).toBe(false);
  });

  it("an outside-hours manual time DOES require the override", () => {
    const d = decideManualTime({ ...base, localTime: "18:00" });
    expect(d.verdict).toBe("outside_availability");
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("a closed day requires the override and says so distinctly", () => {
    const d = decideManualTime({ ...base, window: CLOSED });
    expect(d.verdict).toBe("practitioner_closed");
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("FAILS CLOSED when the window is unknown", () => {
    // A failed or pending slot load must never read as "open".
    const d = decideManualTime({ ...base, window: null });
    expect(d.verdict).toBeNull();
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("FAILS CLOSED when the time is unparseable, and reports timeValid", () => {
    const d = decideManualTime({ ...base, localTime: "" });
    expect(d.timeValid).toBe(false);
    expect(d.verdict).toBeNull();
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("FAILS CLOSED when no service duration is known", () => {
    const d = decideManualTime({ ...base, serviceDurationMinutes: null });
    expect(d.verdict).toBeNull();
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("a CUSTOM LENGTH always requires the override, even inside hours", () => {
    // A caller-supplied duration is owner-only inside
    // create_internal_appointment_v2 and is coupled to the flag by the server
    // action. Changing that needs a migration; this PR does not.
    const d = decideManualTime({ ...base, customDurationMinutes: 45 });
    expect(d.verdict).toBe("inside_availability");
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("a custom length is what the window is measured against", () => {
    // 15:30 + 120 = 17:30, past close.
    const d = decideManualTime({ ...base, customDurationMinutes: 120 });
    expect(d.verdict).toBe("outside_availability");
  });
});

// ---------------------------------------------------------------------------
// The async resolvers. These use a PREDICATE-SENSITIVE stub: a stub that
// ignored filters would let "the practitioner-specific row wins" pass without
// the code ever scoping a query.
// ---------------------------------------------------------------------------

type Row = { is_open: boolean; open_time: string; close_time: string };

function mockClient(opts: {
  blockouts?: unknown[];
  blockoutError?: unknown;
  practitionerOverride?: Row | null;
  studioOverride?: Row | null;
  practitionerDefault?: Row | null;
  studioDefault?: Row | null;
}) {
  const seen: { table: string; scoped: "practitioner" | "studio-wide" }[] = [];
  function builder(table: string) {
    let scoped: "practitioner" | "studio-wide" = "studio-wide";
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.eq = (col: string) => {
      if (col === "practitioner_id") scoped = "practitioner";
      return b;
    };
    b.is = (col: string) => {
      if (col === "practitioner_id") scoped = "studio-wide";
      return b;
    };
    for (const op of ["lt", "gt", "lte", "gte"]) b[op] = () => b;
    const result = () => {
      seen.push({ table, scoped });
      if (table === "studio_blockouts") {
        return {
          data: opts.blockouts ?? [],
          error: opts.blockoutError ?? null,
        };
      }
      if (table === "studio_availability_overrides") {
        return {
          data:
            scoped === "practitioner"
              ? (opts.practitionerOverride ?? null)
              : (opts.studioOverride ?? null),
          error: null,
        };
      }
      return {
        data:
          scoped === "practitioner"
            ? (opts.practitionerDefault ?? null)
            : (opts.studioDefault ?? null),
        error: null,
      };
    };
    b.maybeSingle = () => Promise.resolve(result());
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onF, onR);
    return b;
  }
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: { from: (t: string) => builder(t) } as any,
    seen,
  };
}

const WIN = (open: string, close: string): Row => ({
  is_open: true,
  open_time: `${open}:00`,
  close_time: `${close}:00`,
});

describe("readFullDayBlockout — the two policies are explicit", () => {
  it("reports a covering blockout", async () => {
    const m = mockClient({ blockouts: [{ starts_on: "x", ends_on: "y" }] });
    expect(await readFullDayBlockout(m.client, "s1", "2026-07-06")).toEqual({
      blocked: true,
      readFailed: false,
    });
  });

  it("reports a FAILED read distinctly, never as 'no blockout'", async () => {
    // Slot generation discards this (preserving public behaviour); the manual
    // time check treats it as closed. Collapsing the two would have silently
    // hardened the public booking page.
    const m = mockClient({ blockoutError: { code: "PGRST000" } });
    expect(await readFullDayBlockout(m.client, "s1", "2026-07-06")).toEqual({
      blocked: false,
      readFailed: true,
    });
  });
});

describe("resolveAvailabilityWindow — precedence matches the SQL validator", () => {
  const studioOn = {
    id: "s1",
    timezone: "America/Toronto",
    practitioner_capacity_enabled: true,
  };
  const studioOff = {
    id: "s1",
    timezone: "America/Toronto",
    practitioner_capacity_enabled: false,
  };

  it("capacity ON: a practitioner OVERRIDE beats every other row", async () => {
    const m = mockClient({
      practitionerOverride: WIN("10:00", "14:00"),
      studioOverride: WIN("09:00", "17:00"),
      practitionerDefault: WIN("08:00", "20:00"),
      studioDefault: WIN("07:00", "22:00"),
    });
    expect(
      await resolveAvailabilityWindow(m.client, studioOn, "2026-07-06", "p1"),
    ).toEqual({ kind: "open", openTime: "10:00", closeTime: "14:00" });
  });

  it("capacity ON: a studio-wide OVERRIDE beats both defaults", async () => {
    const m = mockClient({
      practitionerOverride: null,
      studioOverride: WIN("09:00", "17:00"),
      practitionerDefault: WIN("08:00", "20:00"),
      studioDefault: WIN("07:00", "22:00"),
    });
    expect(
      await resolveAvailabilityWindow(m.client, studioOn, "2026-07-06", "p1"),
    ).toEqual({ kind: "open", openTime: "09:00", closeTime: "17:00" });
  });

  it("capacity ON: a practitioner DEFAULT beats the studio-wide default", async () => {
    const m = mockClient({
      practitionerDefault: WIN("08:00", "20:00"),
      studioDefault: WIN("07:00", "22:00"),
    });
    expect(
      await resolveAvailabilityWindow(m.client, studioOn, "2026-07-06", "p1"),
    ).toEqual({ kind: "open", openTime: "08:00", closeTime: "20:00" });
  });

  it("capacity ON: falls back to the studio-wide default", async () => {
    const m = mockClient({ studioDefault: WIN("07:00", "22:00") });
    expect(
      await resolveAvailabilityWindow(m.client, studioOn, "2026-07-06", "p1"),
    ).toEqual({ kind: "open", openTime: "07:00", closeTime: "22:00" });
  });

  it("capacity OFF: reads ONLY studio-wide rows, never a retained practitioner row", async () => {
    // A studio that had capacity enabled and then disabled it RETAINS its
    // per-practitioner rows. Reading one here would resolve a window the SQL
    // validator does not even look at.
    const m = mockClient({
      practitionerDefault: WIN("08:00", "20:00"),
      studioDefault: WIN("09:00", "17:00"),
    });
    const w = await resolveAvailabilityWindow(
      m.client,
      studioOff,
      "2026-07-06",
      "p1",
    );
    expect(w).toEqual({ kind: "open", openTime: "09:00", closeTime: "17:00" });
    expect(m.seen.every((s) => s.scoped === "studio-wide")).toBe(true);
  });

  it("a row with is_open=false resolves to closed", async () => {
    const m = mockClient({
      studioDefault: { is_open: false, open_time: "09:00:00", close_time: "17:00:00" },
    });
    expect(
      await resolveAvailabilityWindow(m.client, studioOff, "2026-07-06"),
    ).toEqual({ kind: "closed" });
  });

  it("no row at all resolves to closed (fail closed)", async () => {
    const m = mockClient({});
    expect(
      await resolveAvailabilityWindow(m.client, studioOff, "2026-07-06"),
    ).toEqual({ kind: "closed" });
  });

  it("trims the seconds Postgres returns on a time column", async () => {
    const m = mockClient({ studioDefault: WIN("09:00", "17:00") });
    const w = await resolveAvailabilityWindow(m.client, studioOff, "2026-07-06");
    expect(w).toEqual({ kind: "open", openTime: "09:00", closeTime: "17:00" });
  });
});
