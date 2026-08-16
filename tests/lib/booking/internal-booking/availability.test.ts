import { describe, expect, it } from "vitest";
import {
  classifyAgainstWindow,
  decideManualTime,
  localInterval,
  normalizeDurationOverride,
  selectedSlotMatchesDate,
  type AvailabilityWindow,
} from "@/lib/booking/internal-booking/availability";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// The pure semantics the shared controller decides from. Total functions, so
// every case here is exact rather than illustrative.

const TZ = "America/Toronto";
const PLAIN = "2026-06-15"; // no DST transition
const OPEN_9_17: AvailabilityWindow = { kind: "open", openTime: "09:00", closeTime: "17:00" };

const iv = (hhmm: string, mins: number, date = PLAIN, tz = TZ) =>
  localInterval(utcInstantFromLocal(date, hhmm, tz), mins, tz);

describe("classifyAgainstWindow mirrors the database validator", () => {
  it("a time inside the window is inside", () => {
    expect(classifyAgainstWindow(OPEN_9_17, iv("15:30", 60))).toBe("inside_availability");
  });
  it("the opening edge is inclusive; a minute earlier is outside", () => {
    expect(classifyAgainstWindow(OPEN_9_17, iv("09:00", 60))).toBe("inside_availability");
    expect(classifyAgainstWindow(OPEN_9_17, iv("08:59", 60))).toBe("outside_availability");
  });
  it("the SERVICE end may land exactly on close; a minute past is outside", () => {
    expect(classifyAgainstWindow(OPEN_9_17, iv("16:00", 60))).toBe("inside_availability");
    expect(classifyAgainstWindow(OPEN_9_17, iv("16:01", 60))).toBe("outside_availability");
  });
  it("duration changes the verdict for the same start", () => {
    expect(classifyAgainstWindow(OPEN_9_17, iv("16:30", 30))).toBe("inside_availability");
    expect(classifyAgainstWindow(OPEN_9_17, iv("16:30", 60))).toBe("outside_availability");
  });
  it("CLOSED and UNKNOWN are different verdicts, and neither is the other", () => {
    expect(classifyAgainstWindow({ kind: "closed" }, iv("15:30", 60))).toBe("practitioner_closed");
    expect(classifyAgainstWindow({ kind: "unknown" }, iv("15:30", 60))).toBe("availability_unknown");
  });
  it("an appointment running into the next local date is refused", () => {
    const late = iv("23:30", 60);
    expect(late.endDate).not.toBe(late.startDate);
    expect(classifyAgainstWindow({ kind: "open", openTime: "09:00", closeTime: "23:59" }, late))
      .toBe("outside_availability");
  });
});

describe("localInterval projects BOTH endpoints from instants (DST)", () => {
  it("spring-forward: 01:30 + 60 really ends 03:30", () => {
    const i = iv("01:30", 60, "2026-03-08");
    expect(i.endMinutes).toBe(3 * 60 + 30);
    expect(classifyAgainstWindow({ kind: "open", openTime: "01:00", closeTime: "03:00" }, i))
      .toBe("outside_availability");
  });
  it("fall-back: 01:30 + 60 really ends at or before 02:00", () => {
    const i = iv("01:30", 60, "2026-11-01");
    expect(i.endMinutes).toBeLessThanOrEqual(2 * 60);
    expect(classifyAgainstWindow({ kind: "open", openTime: "01:00", closeTime: "02:00" }, i))
      .toBe("inside_availability");
  });
  it("an ordinary day is simply start + duration", () => {
    const i = iv("15:30", 60);
    expect(i.startMinutes).toBe(15 * 60 + 30);
    expect(i.endMinutes).toBe(16 * 60 + 30);
  });
});

describe("normalizeDurationOverride — custom means DIFFERENT, not populated", () => {
  it("a length equal to the service default is not custom", () => {
    expect(normalizeDurationOverride(60, 60)).toBeNull();
  });
  it("a genuinely different length survives", () => {
    expect(normalizeDurationOverride(45, 60)).toBe(45);
  });
  it("with an unknown service length the value is kept — equality is unprovable", () => {
    expect(normalizeDurationOverride(60, null)).toBe(60);
  });
});

describe("decideManualTime — permission and fact are separate answers", () => {
  const base = {
    window: OPEN_9_17 as AvailabilityWindow | null,
    localDate: PLAIN,
    localTime: "10:00",
    timezone: TZ,
    serviceDurationMinutes: 60,
    customDurationMinutes: null as number | null,
  };

  it("an ordinary in-hours time needs no override and states no reason", () => {
    const d = decideManualTime(base);
    expect(d.verdict).toBe("inside_availability");
    expect(d.requiresOutsideOverride).toBe(false);
    expect(d.overrideReason).toBeNull();
  });

  it("a custom length INSIDE hours reports custom_duration, never outside", () => {
    const d = decideManualTime({ ...base, customDurationMinutes: 45 });
    expect(d.verdict).toBe("inside_availability");
    expect(d.requiresOutsideOverride).toBe(true);
    expect(d.overrideReason).toBe("custom_duration");
  });

  it("a default-equivalent length is an ORDINARY booking", () => {
    const d = decideManualTime({ ...base, customDurationMinutes: 60 });
    expect(d.requiresOutsideOverride).toBe(false);
    expect(d.overrideReason).toBeNull();
  });

  it("out-of-hours WINS over custom_duration when both apply", () => {
    const d = decideManualTime({ ...base, localTime: "18:00", customDurationMinutes: 45 });
    expect(d.overrideReason).toBe("outside_availability");
  });

  it("UNKNOWN fails closed but asserts NOTHING", () => {
    const d = decideManualTime({ ...base, window: { kind: "unknown" } });
    expect(d.windowKnown).toBe(false);
    expect(d.requiresOutsideOverride).toBe(true); // do not treat as ordinary
    expect(d.overrideReason).toBeNull(); // ...but claim nothing
  });

  it("an unloaded window behaves the same as an unreadable one", () => {
    const d = decideManualTime({ ...base, window: null });
    expect(d.windowKnown).toBe(false);
    expect(d.overrideReason).toBeNull();
  });

  it("an unparseable time is reported as such, not as outside hours", () => {
    const d = decideManualTime({ ...base, localTime: "" });
    expect(d.timeValid).toBe(false);
    expect(d.verdict).toBeNull();
    expect(d.overrideReason).toBeNull();
  });

  it("a closed day is distinct from an out-of-hours time", () => {
    expect(decideManualTime({ ...base, window: { kind: "closed" } }).overrideReason)
      .toBe("practitioner_closed");
  });

  it("the duration used is the one supplied as authoritative", () => {
    // 16:00 + 120 = 18:00, past a 17:00 close.
    const d = decideManualTime({ ...base, localTime: "16:00", serviceDurationMinutes: 120 });
    expect(d.verdict).toBe("outside_availability");
  });
});

describe("selectedSlotMatchesDate binds a suggestion to its date", () => {
  it("a slot from another date is not usable", () => {
    const s = utcInstantFromLocal("2026-08-20", "10:00", TZ).toISOString();
    expect(selectedSlotMatchesDate({ startsAtIso: s, formDate: "2026-08-20", timezone: TZ })).toBe(true);
    expect(selectedSlotMatchesDate({ startsAtIso: s, formDate: "2026-08-21", timezone: TZ })).toBe(false);
  });
  it("compared in STUDIO time, so a late-evening slot is still today", () => {
    expect(
      selectedSlotMatchesDate({ startsAtIso: "2026-08-21T02:00:00.000Z", formDate: "2026-08-20", timezone: TZ }),
    ).toBe(true);
  });
  it("no selection, or an unparseable one, is never usable", () => {
    expect(selectedSlotMatchesDate({ startsAtIso: null, formDate: "2026-08-20", timezone: TZ })).toBe(false);
    expect(selectedSlotMatchesDate({ startsAtIso: "nope", formDate: "2026-08-20", timezone: TZ })).toBe(false);
  });
});
