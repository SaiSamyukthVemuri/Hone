import { describe, expect, it } from "vitest";

import type { ProtectedInterval } from "@/lib/booking/slots";
import {
  bookedPercent,
  capacityWeeks,
  countNewConsultations,
  dayCapacity,
  evaluateAdmission,
  gapsIn,
  isFirstEverBooking,
  known,
  mergeClipped,
  minutesIn,
  summarizeBookingDepth,
  summarizeConversion,
  unknown,
  wholeOpenings,
  type AdmissionEvidence,
  type BriefingAppointment,
} from "@/lib/dashboard/owner-capacity-model";

// ===========================================================================
// The owner-capacity derivations, and the three things they must never do:
// count a returning client as new, treat blocked time as bookable, or turn a
// missing fact into a zero.
// ===========================================================================

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
// A fixed instant so nothing here depends on when the suite runs.
const T0 = Date.parse("2026-09-07T13:00:00.000Z"); // 09:00 in America/Toronto

function appointment(
  over: Partial<BriefingAppointment> & Pick<BriefingAppointment, "id" | "clientId" | "startsAt">,
): BriefingAppointment {
  return {
    endsAt: new Date(Date.parse(over.startsAt) + HOUR).toISOString(),
    status: "confirmed",
    isConsultation: false,
    ...over,
  };
}

function reservation(
  startMs: number,
  endMs: number,
  sourceKind: string,
): ProtectedInterval {
  return { start: startMs, end: endMs, sourceKind };
}

describe("week buckets", () => {
  it("anchors on the same Sunday the rest of the app uses, and runs forward", () => {
    // 2026-09-09 is a Wednesday; the week it belongs to starts Sunday the 6th.
    const weeks = capacityWeeks("2026-09-09", 3);
    expect(weeks.map((w) => w.startLocal)).toEqual([
      "2026-09-06",
      "2026-09-13",
      "2026-09-20",
    ]);
    expect(weeks[0].endLocalExclusive).toBe("2026-09-13");
  });
});

describe("interval arithmetic", () => {
  it("merges overlapping cuts so occupied time is never counted twice", () => {
    const merged = mergeClipped(
      [
        { start: T0, end: T0 + 2 * HOUR },
        { start: T0 + HOUR, end: T0 + 3 * HOUR },
      ],
      T0,
      T0 + 8 * HOUR,
    );
    expect(merged).toHaveLength(1);
    expect(minutesIn(merged)).toBe(180);
  });

  it("clips to the window, so a reservation running past close cannot inflate it", () => {
    expect(
      minutesIn(mergeClipped([{ start: T0 - 5 * HOUR, end: T0 + HOUR }], T0, T0 + 8 * HOUR)),
    ).toBe(60);
  });

  it("returns the gaps between cuts, and the tail after the last one", () => {
    const gaps = gapsIn(
      [{ start: T0 + HOUR, end: T0 + 2 * HOUR }],
      T0,
      T0 + 3 * HOUR,
    );
    expect(gaps).toEqual([
      { start: T0, end: T0 + HOUR },
      { start: T0 + 2 * HOUR, end: T0 + 3 * HOUR },
    ]);
  });
});

describe("free minutes are not free treatments", () => {
  const close = T0 + 8 * HOUR;

  it("a mid-day gap must also fit the trailing buffer before the next booking", () => {
    // 60 free minutes bounded by a reservation, 15-minute buffer: the treatment
    // fits but its buffer does not, so nothing can actually be booked.
    const gap = [{ start: T0, end: T0 + 60 * MIN }];
    expect(wholeOpenings(gap, close, 60 * MIN, 15 * MIN)).toBe(0);
    expect(wholeOpenings(gap, close, 45 * MIN, 15 * MIN)).toBe(1);
  });

  it("the last window of the day lets the buffer spill past closing time", () => {
    // The same 60 minutes, this time ending AT close: Hone fits the SERVICE end
    // against close, so one 60-minute treatment is genuinely bookable.
    const tail = [{ start: close - 60 * MIN, end: close }];
    expect(wholeOpenings(tail, close, 60 * MIN, 15 * MIN)).toBe(1);
  });

  it("scattered white space is not capacity", () => {
    // Three 40-minute gaps: two hours of free time and zero 60-minute openings.
    const scattered = [
      { start: T0, end: T0 + 40 * MIN },
      { start: T0 + 2 * HOUR, end: T0 + 2 * HOUR + 40 * MIN },
      { start: T0 + 4 * HOUR, end: T0 + 4 * HOUR + 40 * MIN },
    ];
    expect(minutesIn(scattered)).toBe(120);
    expect(wholeOpenings(scattered, close, 60 * MIN, 0)).toBe(0);
  });
});

describe("one day's capacity", () => {
  const open = T0;
  const close = T0 + 8 * HOUR;
  const base = { openMs: open, closeMs: close, fromMs: open, probeDurationMs: 60 * MIN, bufferMs: 15 * MIN };

  it("counts a full open day when nothing is on it", () => {
    const day = dayCapacity({ ...base, intervals: [] });
    expect(day.netBookableMinutes).toBe(480);
    expect(day.bookedMinutes).toBe(0);
    expect(day.freeMinutes).toBe(480);
  });

  it("a block REDUCES net bookable capacity, and is not merely unbooked", () => {
    const day = dayCapacity({
      ...base,
      intervals: [reservation(open + 3 * HOUR, open + 4 * HOUR, "timed_block")],
    });
    // ANTI-VACUITY: ignoring the block would leave 480 here.
    expect(day.netBookableMinutes).toBe(420);
    expect(day.bookedMinutes).toBe(0);
    expect(day.freeMinutes).toBe(420);
  });

  it("a booked appointment reduces free hours, buffer included", () => {
    const day = dayCapacity({
      ...base,
      // 09:00–11:00 treatment; the shadow row carries the protected end.
      intervals: [reservation(open, open + 2 * HOUR + 15 * MIN, "appointment")],
    });
    expect(day.netBookableMinutes).toBe(480);
    expect(day.bookedMinutes).toBe(135);
    expect(day.freeMinutes).toBe(345);
    expect(bookedPercent(day)).toBe(28);
  });

  it("counts only what is still ahead of now", () => {
    const day = dayCapacity({ ...base, fromMs: open + 6 * HOUR, intervals: [] });
    expect(day.netBookableMinutes).toBe(120);
    expect(day.freeMinutes).toBe(120);
  });

  it("is empty once the day has closed", () => {
    expect(dayCapacity({ ...base, fromMs: close + HOUR, intervals: [] }).freeMinutes).toBe(0);
  });
});

describe("new-client demand", () => {
  const consult = (id: string, clientId: string, dayOffset: number) =>
    appointment({
      id,
      clientId,
      startsAt: new Date(T0 + dayOffset * 24 * HOUR).toISOString(),
      isConsultation: true,
    });

  it("a client's first-ever booking is first-ever; a later one is not", () => {
    const first = consult("a1", "c1", 3);
    const second = consult("a2", "c1", 10);
    const history = [first, second];
    expect(isFirstEverBooking(first, history)).toBe(true);
    expect(isFirstEverBooking(second, history)).toBe(false);
  });

  it("a cancelled earlier booking does not make a real first consultation look like a repeat", () => {
    const cancelled = appointment({
      id: "old",
      clientId: "c1",
      startsAt: new Date(T0 - 30 * 24 * HOUR).toISOString(),
      status: "cancelled",
      isConsultation: true,
    });
    const real = consult("new", "c1", 3);
    expect(isFirstEverBooking(real, [cancelled, real])).toBe(true);
  });

  it("counts first-ever consultations per horizon, and excludes repeats and treatments", () => {
    const newClient = consult("n1", "new", 3);
    const returningConsult = consult("r1", "returning", 5);
    const returningPast = appointment({
      id: "r0",
      clientId: "returning",
      startsAt: new Date(T0 - 50 * 24 * HOUR).toISOString(),
      status: "completed",
    });
    const treatment = appointment({ id: "t1", clientId: "other", startsAt: new Date(T0 + 2 * 24 * HOUR).toISOString() });

    const counts = countNewConsultations(
      [newClient, returningConsult, treatment],
      new Map([
        ["new", [newClient]],
        ["returning", [returningPast, returningConsult]],
        ["other", [treatment]],
      ]),
      T0,
    ).countsByDays;

    // ANTI-VACUITY: letting the repeat consultation count would make this 2,
    // and a treatment visit counting would make it 3.
    expect(counts).toEqual({ 7: 1, 14: 1, 28: 1 });
  });
});

describe("mature conversion", () => {
  const consultAt = (id: string, clientId: string, daysAgo: number) =>
    appointment({
      id,
      clientId,
      startsAt: new Date(T0 - daysAgo * 24 * HOUR).toISOString(),
      status: "completed",
      isConsultation: true,
    });
  const treatmentAt = (id: string, clientId: string, daysAgo: number) =>
    appointment({
      id,
      clientId,
      startsAt: new Date(T0 - daysAgo * 24 * HOUR).toISOString(),
      status: "completed",
    });

  it("counts a treatment booked inside the window, and not one booked after it", () => {
    const inside = consultAt("c-in", "in", 30);
    const late = consultAt("c-late", "late", 60);
    const summary = summarizeConversion(
      [inside, late],
      new Map([
        ["in", [inside, treatmentAt("t-in", "in", 25)]],
        // 20 days after the consultation: real, but outside the 14-day window.
        ["late", [late, treatmentAt("t-late", "late", 40)]],
      ]),
    );
    expect(summary).toEqual({ converted: 1, matured: 2, percent: 50 });
  });

  it("another consultation is not a conversion", () => {
    const first = consultAt("c1", "c", 30);
    const repeat = consultAt("c2", "c", 25);
    expect(summarizeConversion([first], new Map([["c", [first, repeat]]])).converted).toBe(0);
  });

  it("an empty cohort reports no percentage rather than 0%", () => {
    // 0/0 is not "nobody converts"; the screen must not paint it as failure.
    expect(summarizeConversion([], new Map())).toEqual({
      converted: 0,
      matured: 0,
      percent: null,
    });
  });
});

describe("booking depth", () => {
  it("puts an active client with nothing booked in the zero bucket, and one with a booking out of it", () => {
    const depth = summarizeBookingDepth(
      new Set(["stranded", "one", "three"]),
      new Map([
        ["one", 1],
        ["three", 3],
        // A client who is NOT an active treatment client is ignored entirely.
        ["stranger", 9],
      ]),
    );
    expect(depth).toEqual({ zero: 1, oneOrMore: 2, twoOrMore: 1, threeOrMore: 1 });
  });
});

describe("admission", () => {
  const complete: AdmissionEvidence = {
    freeTreatmentHours: known(40),
    nextTreatmentOpeningDays: known(3),
    firstTreatmentLeadTimeTargetDays: known(14),
    activeClientsWithoutFutureBooking: known(0),
    latentRecurringDemandHours: known(12),
    newConsultationsNext7Days: known(1),
    outstandingInvitations: known(0),
    studioIntakeCapPerWeek: known(3),
  };

  it("produces a number only when every input is present", () => {
    expect(evaluateAdmission(complete)).toEqual({ kind: "can_take_more", count: 2 });
  });

  it("a MISSING input is never read as zero", () => {
    // ANTI-VACUITY, and the whole reason Fact<T> exists. Latent demand of
    // "unknown" must not behave like latent demand of 0 — which would leave
    // 40 free hours against nothing and answer "yes, take two more".
    const state = evaluateAdmission({
      ...complete,
      latentRecurringDemandHours: unknown("Return cadence is not recorded."),
    });
    expect(state.kind).toBe("unknown");
    if (state.kind !== "unknown") throw new Error("unreachable");
    expect(state.missing).toEqual([
      "Recurring demand from existing clients: Return cadence is not recorded.",
    ]);
  });

  it("names every missing input, not just the first", () => {
    const state = evaluateAdmission({
      ...complete,
      studioIntakeCapPerWeek: unknown("No cap set."),
      outstandingInvitations: unknown("Not stored."),
    });
    if (state.kind !== "unknown") throw new Error("expected unknown");
    expect(state.missing).toHaveLength(2);
  });

  it("holds when a new client would wait past the studio's own lead-time target", () => {
    const state = evaluateAdmission({ ...complete, nextTreatmentOpeningDays: known(21) });
    expect(state).toEqual({
      kind: "hold",
      reason: "A new client would wait 21 days for a first treatment, past the 14-day target.",
    });
  });

  it("holds while existing active clients have no future appointment", () => {
    const state = evaluateAdmission({ ...complete, activeClientsWithoutFutureBooking: known(7) });
    expect(state.kind).toBe("hold");
    if (state.kind !== "hold") throw new Error("unreachable");
    expect(state.reason).toContain("7 active treatment clients have no future appointment");
  });

  it("holds when the existing clients' own demand already exceeds free capacity", () => {
    const state = evaluateAdmission({ ...complete, latentRecurringDemandHours: known(60) });
    expect(state.kind).toBe("hold");
  });

  it("holds when this week's intake is already spoken for", () => {
    const state = evaluateAdmission({
      ...complete,
      newConsultationsNext7Days: known(2),
      outstandingInvitations: known(1),
    });
    expect(state.kind).toBe("hold");
  });

  it("holds when there is no opening at all, rather than dividing white space", () => {
    expect(evaluateAdmission({ ...complete, nextTreatmentOpeningDays: known(null) })).toEqual({
      kind: "hold",
      reason: "No treatment opening inside the horizon.",
    });
  });
});
