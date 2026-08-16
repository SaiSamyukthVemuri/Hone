import { describe, expect, it } from "vitest";
import {
  availabilityKey,
  candidateKey,
  type InternalBookingCandidateIdentity,
} from "@/lib/booking/internal-booking/candidate";
import {
  bufferOfferIsCurrent,
  currentAvailabilityKey,
  initialState,
  needsLoad,
  reduce,
  snapshotIsCurrent,
  type InternalBookingEvent,
  type InternalBookingState,
} from "@/lib/booking/internal-booking/reducer";
import { decide } from "@/lib/booking/internal-booking/decisions";
import type { InternalBookingServerSnapshot } from "@/lib/booking/internal-booking/server-snapshot";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// ONE STATE MACHINE, ONE TRANSITION LAW.
//
// These drive the shared controller rather than grepping two components. The
// duplication they replace is what produced four consecutive rounds of
// neighbouring defects.

const TZ = "America/Toronto";
const DATE = "2026-08-20";

const ID = (
  over: Partial<InternalBookingCandidateIdentity> = {},
): InternalBookingCandidateIdentity => ({
  clientId: "client-1",
  serviceId: "svc-1",
  date: DATE,
  targetPractitionerId: "prac-A",
  capacityMode: true,
  timezone: TZ,
  ...over,
});

const iso = (d: string, t: string) => utcInstantFromLocal(d, t, TZ).toISOString();

const SNAP = (
  id: InternalBookingCandidateIdentity,
  over: Partial<InternalBookingServerSnapshot> = {},
): InternalBookingServerSnapshot => ({
  availabilityKey: availabilityKey(id),
  serviceDurationMinutes: 60,
  window: { kind: "open", openTime: "09:00", closeTime: "17:00" },
  slots: [{ start: iso(DATE, "10:00"), end: iso(DATE, "11:00"), startLabel: "10:00 AM" }],
  ...over,
});

function run(
  start: InternalBookingState,
  ...events: InternalBookingEvent[]
): InternalBookingState {
  return events.reduce(reduce, start);
}

/** A fully loaded, confirmable candidate with a suggestion chosen. */
function loaded(id = ID()): InternalBookingState {
  return run(
    initialState(id),
    { type: "SLOT_REQUEST_STARTED", key: availabilityKey(id) },
    { type: "SLOT_REQUEST_SUCCEEDED", snapshot: SNAP(id) },
    { type: "SUGGESTION_SELECTED", startsAtIso: iso(DATE, "10:00") },
  );
}

const decideWith = (s: InternalBookingState, isOwner = true) =>
  decide({
    state: s,
    isOwner,
    customDurationMinutes: null,
    toInstantIso: (d, t) => iso(d, t),
  });

describe("A — EVERY identity dimension revokes in ONE transition", () => {
  const CHANGES: [string, InternalBookingEvent][] = [
    ["service", { type: "SERVICE_CHANGED", serviceId: "svc-2" }],
    ["date", { type: "DATE_CHANGED", date: "2026-08-21" }],
    ["target", { type: "TARGET_CHANGED", targetPractitionerId: "prac-B" }],
    ["capacity", { type: "CAPACITY_MODE_CHANGED", capacityMode: false }],
    ["timezone", { type: "TIMEZONE_CHANGED", timezone: "Europe/London" }],
  ];

  for (const [label, event] of CHANGES) {
    it(`${label}: snapshot loses authority, selection + approvals revoked, reload requested`, () => {
      const before = run(loaded(), {
        type: "BUFFER_CONFLICT_RETURNED",
        conflict: { candidateKey: candidateKey(ID()), serviceDurationMinutes: 60 },
      }, { type: "BUFFER_ACKNOWLEDGED", acknowledged: true },
         { type: "OUTSIDE_HOURS_ACKNOWLEDGED", acknowledged: true });
      expect(snapshotIsCurrent(before)).toBe(true);
      expect(bufferOfferIsCurrent(before)).toBe(true);

      const after = reduce(before, event);

      // ONE transition does all of it -- no caller performed a sequence.
      expect(snapshotIsCurrent(after), "snapshot must lose authority").toBe(false);
      expect(after.pickedSlotStart, "selection revoked").toBeNull();
      expect(bufferOfferIsCurrent(after), "buffer approval revoked").toBe(false);
      expect(after.bufferConfirmed).toBe(false);
      expect(after.outsideHoursConfirmed).toBe(false);
      expect(needsLoad(after), "replacement requested").toBe(true);
      expect(decideWith(after).canConfirm, "submission blocked").toBe(false);
    });
  }

  it("recovery is DERIVED, so a dimension added later is covered too", () => {
    // needsLoad compares the whole derived key. Nothing enumerates which props
    // to watch, which is exactly what the hand-written two-prop effect got
    // wrong when ownership changed the effective target.
    const s = reduce(loaded(), { type: "TARGET_CHANGED", targetPractitionerId: null });
    expect(currentAvailabilityKey(s)).not.toBe(availabilityKey(ID()));
    expect(needsLoad(s)).toBe(true);
  });

  it("a no-op change does not churn", () => {
    const s = loaded();
    const same = reduce(s, { type: "DATE_CHANGED", date: DATE });
    expect(same).toBe(s);
    expect(needsLoad(same)).toBe(false);
  });
});

describe("B — the result installs ATOMICALLY or not at all", () => {
  it("slots, window and authoritative duration arrive in one transition", () => {
    const id = ID();
    const s = run(initialState(id), {
      type: "SLOT_REQUEST_SUCCEEDED",
      snapshot: SNAP(id),
    });
    expect(s.snapshot?.slots).toHaveLength(1);
    expect(s.snapshot?.window.kind).toBe("open");
    expect(s.snapshot?.serviceDurationMinutes).toBe(60);
    // There is no transition that can set one without the others: they are one
    // object on one event.
    expect(snapshotIsCurrent(s)).toBe(true);
  });

  it("the manual decision measures against the SERVER's duration", () => {
    const id = ID();
    const s = run(
      initialState(id),
      { type: "SLOT_REQUEST_SUCCEEDED", snapshot: SNAP(id, { serviceDurationMinutes: 120 }) },
      { type: "MANUAL_TIME_ENABLED", enabled: true },
      { type: "MANUAL_TIME_CHANGED", localTime: "16:00" },
    );
    // 16:00 + 120 = 18:00, past a 17:00 close. With a client-held 60 it would
    // have looked fine.
    expect(decideWith(s).manual.verdict).toBe("outside_availability");
  });
});

describe("C — a failed refresh may keep display, never authority", () => {
  it("old data survives for display but cannot confirm", () => {
    const s0 = loaded();
    const key = currentAvailabilityKey(s0);
    const s = run(
      s0,
      { type: "SLOT_REQUEST_STARTED", key },
      { type: "SLOT_REQUEST_FAILED", key },
    );
    expect(s.snapshot).not.toBeNull(); // display may persist
    expect(snapshotIsCurrent(s)).toBe(false); // authority does not
    expect(decideWith(s).snapshotStale).toBe(true);
    expect(decideWith(s).canConfirm).toBe(false);
  });
});

describe("D — a stale response cannot alter ANY controller state", () => {
  it("a response for the old identity is ignored entirely", () => {
    const idA = ID();
    const idB = ID({ date: "2026-08-21" });
    const s = run(
      loaded(idA),
      { type: "DATE_CHANGED", date: "2026-08-21" },
      { type: "SLOT_REQUEST_SUCCEEDED", snapshot: SNAP(idB) }, // B lands
    );
    const withStaleA = reduce(s, {
      type: "SLOT_REQUEST_SUCCEEDED",
      snapshot: SNAP(idA), // A resolves LAST
    });
    expect(withStaleA).toBe(s); // literally no state change
    expect(withStaleA.snapshot?.availabilityKey).toBe(availabilityKey(idB));
  });

  it("a stale FAILURE cannot mark the current candidate failed", () => {
    const s = run(loaded(), { type: "DATE_CHANGED", date: "2026-08-21" });
    const after = reduce(s, {
      type: "SLOT_REQUEST_FAILED",
      key: availabilityKey(ID()), // the OLD key
    });
    expect(after.loadFailed).toBe(false);
  });
});

describe("E/F — capacity and timezone recover with no user interaction", () => {
  for (const [label, event] of [
    ["capacity", { type: "CAPACITY_MODE_CHANGED", capacityMode: false }],
    ["timezone", { type: "TIMEZONE_CHANGED", timezone: "Europe/London" }],
  ] as [string, InternalBookingEvent][]) {
    it(`${label}: needsLoad becomes true immediately`, () => {
      const s = reduce(loaded(), event);
      expect(needsLoad(s)).toBe(true);
      expect(decideWith(s).canConfirm).toBe(false);
    });
  }

  it("no old-zone instant remains submittable after a timezone change", () => {
    const s = reduce(loaded(), { type: "TIMEZONE_CHANGED", timezone: "Europe/London" });
    expect(decideWith(s).suggestionUsable).toBe(false);
    expect(decideWith(s).plan.startsAtIso).toBeNull();
  });
});

describe("G — a buffer approval is scoped to the candidate it was issued for", () => {
  it("an offer for another candidate is refused outright", () => {
    const s = reduce(loaded(), {
      type: "BUFFER_CONFLICT_RETURNED",
      conflict: { candidateKey: "someone-else", serviceDurationMinutes: 60 },
    });
    expect(s.bufferOffer).toBeNull();
  });

  it("the acknowledged interval travels as a PRECONDITION, not authority", () => {
    const s = run(
      loaded(),
      { type: "BUFFER_CONFLICT_RETURNED", conflict: { candidateKey: candidateKey(ID()), serviceDurationMinutes: 60 } },
      { type: "BUFFER_ACKNOWLEDGED", acknowledged: true },
    );
    const d = decideWith(s);
    expect(d.bufferOffered).toBe(true);
    expect(d.canConfirm).toBe(true);
    expect(d.plan.allowOutsideAvailability).toBe(true);
    expect(d.plan.expectedDurationMinutes).toBe(60);
  });

  it("choosing another suggestion revokes it", () => {
    const s = run(
      loaded(),
      { type: "BUFFER_CONFLICT_RETURNED", conflict: { candidateKey: candidateKey(ID()), serviceDurationMinutes: 60 } },
      { type: "BUFFER_ACKNOWLEDGED", acknowledged: true },
      { type: "SUGGESTION_SELECTED", startsAtIso: iso(DATE, "11:00") },
    );
    expect(bufferOfferIsCurrent(s)).toBe(false);
    expect(decideWith(s).plan.allowOutsideAvailability).toBe(false);
    expect(decideWith(s).plan.expectedDurationMinutes).toBeNull();
  });
});

describe("H — a non-owner is never given an actionable exception", () => {
  const outOfHours = () =>
    run(
      loaded(),
      { type: "MANUAL_TIME_ENABLED", enabled: true },
      { type: "MANUAL_TIME_CHANGED", localTime: "20:00" }, // past a 17:00 close
    );

  it("canConfirm is FALSE for a non-owner even if they tick the box", () => {
    const s = run(outOfHours(), {
      type: "OUTSIDE_HOURS_ACKNOWLEDGED",
      acknowledged: true,
    });
    expect(decideWith(s, false).manual.overrideReason).toBe("outside_availability");
    expect(decideWith(s, false).canConfirm).toBe(false);
    expect(decideWith(s, false).plan.allowOutsideAvailability).toBe(false);
  });

  it("...and the OWNER path is unchanged", () => {
    const s = run(outOfHours(), {
      type: "OUTSIDE_HOURS_ACKNOWLEDGED",
      acknowledged: true,
    });
    expect(decideWith(s, true).canConfirm).toBe(true);
    expect(decideWith(s, true).plan.allowOutsideAvailability).toBe(true);
  });

  it("a non-owner can still book an ordinary in-hours suggestion", () => {
    // Harmonising the UX must not narrow what a member may legitimately do.
    expect(decideWith(loaded(), false).canConfirm).toBe(true);
    expect(decideWith(loaded(), false).plan.allowOutsideAvailability).toBe(false);
  });
});

describe("the ordinary product rules still hold", () => {
  it("an in-hours manual time that is NOT a suggestion books normally", () => {
    const s = run(
      loaded(),
      { type: "MANUAL_TIME_ENABLED", enabled: true },
      { type: "MANUAL_TIME_CHANGED", localTime: "15:30" },
    );
    const d = decideWith(s);
    expect(d.manual.verdict).toBe("inside_availability");
    expect(d.canConfirm).toBe(true);
    expect(d.plan.allowOutsideAvailability).toBe(false);
  });

  it("an UNKNOWN window blocks the manual path and asserts nothing", () => {
    const id = ID();
    const s = run(
      initialState(id),
      { type: "SLOT_REQUEST_SUCCEEDED", snapshot: SNAP(id, { window: { kind: "unknown" }, slots: [] }) },
      { type: "MANUAL_TIME_ENABLED", enabled: true },
      { type: "MANUAL_TIME_CHANGED", localTime: "15:30" },
    );
    const d = decideWith(s);
    expect(d.manual.windowKnown).toBe(false);
    expect(d.manual.overrideReason).toBeNull();
    expect(d.canConfirm).toBe(false);
  });

  it("a successful booking resets the candidate", () => {
    const s = reduce(loaded(), { type: "BOOKING_SUCCEEDED" });
    expect(s.pickedSlotStart).toBeNull();
    expect(s.snapshot).toBeNull();
    expect(s.bufferOffer).toBeNull();
  });
});
