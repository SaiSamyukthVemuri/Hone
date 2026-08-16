import { describe, expect, it } from "vitest";
import {
  availabilityKey,
  candidateKey,
  type InternalBookingCandidateIdentity,
} from "@/lib/booking/internal-booking/candidate";
import {
  bufferApprovalIsCurrent,
  bufferOfferIsCurrent,
  currentAvailabilityKey,
  currentIntervalKey,
  currentRequestToken,
  currentStartsAtIso,
  effectiveDurationMinutes,
  initialState,
  isLoading,
  needsLoad,
  normalizedDurationOverride,
  outsideApprovalIsCurrent,
  reduce,
  snapshotIsCurrent,
  type InternalBookingEvent,
  type InternalBookingState,
} from "@/lib/booking/internal-booking/reducer";
import { decide } from "@/lib/booking/internal-booking/decisions";
import type {
  BufferConflictSnapshot,
  InternalBookingServerSnapshot,
} from "@/lib/booking/internal-booking/server-snapshot";
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
function loaded(id = ID(), snap = SNAP(id)): InternalBookingState {
  const s0 = initialState(id);
  const token = currentRequestToken(s0)!;
  return run(
    s0,
    { type: "SLOT_REQUEST_STARTED", token },
    { type: "SLOT_REQUEST_SUCCEEDED", token, snapshot: snap },
    { type: "SUGGESTION_SELECTED", startsAtIso: iso(DATE, "10:00") },
  );
}

/** A buffer refusal describing whatever interval `s` currently is. */
const OFFER = (
  s: InternalBookingState,
  over: Partial<BufferConflictSnapshot> = {},
): BufferConflictSnapshot => ({
  candidateKey: candidateKey(s.identity),
  startsAtIso: currentStartsAtIso(s)!,
  effectiveDurationMinutes: effectiveDurationMinutes(s)!,
  serviceDurationMinutes: 60,
  ...over,
});

/** Manual path, out of hours, at `time`. */
const manualAt = (time: string, s = loaded()) =>
  run(
    s,
    { type: "MANUAL_TIME_ENABLED", enabled: true },
    { type: "MANUAL_TIME_CHANGED", localTime: time },
  );

const decideWith = (s: InternalBookingState, isOwner = true) =>
  decide({ state: s, isOwner });

describe("A — EVERY identity dimension revokes in ONE transition", () => {
  const CHANGES: [string, InternalBookingEvent][] = [
    ["service", { type: "SERVICE_CHANGED", serviceId: "svc-2" }],
    ["date", { type: "DATE_CHANGED", date: "2026-08-21" }],
    ["target", { type: "TARGET_CHANGED", targetPractitionerId: "prac-B" }],
    ["capacity", { type: "CAPACITY_MODE_CHANGED", capacityMode: false }],
    ["timezone", { type: "TIMEZONE_CHANGED", timezone: "Europe/London" }],
  ];

  /** Out of hours AND buffer-refused, with both acknowledgements granted. */
  function bothApproved(): InternalBookingState {
    const s = manualAt("20:00");
    const acked = run(s, { type: "OUTSIDE_HOURS_ACKNOWLEDGED", acknowledged: true });
    return run(
      acked,
      { type: "BUFFER_CONFLICT_RETURNED", conflict: OFFER(acked) },
      { type: "BUFFER_ACKNOWLEDGED", acknowledged: true },
    );
  }

  for (const [label, event] of CHANGES) {
    it(`${label}: snapshot loses authority, selection + BOTH approvals revoked`, () => {
      const before = bothApproved();
      expect(snapshotIsCurrent(before)).toBe(true);
      expect(bufferOfferIsCurrent(before)).toBe(true);
      expect(bufferApprovalIsCurrent(before)).toBe(true);
      expect(outsideApprovalIsCurrent(before)).toBe(true);

      const after = reduce(before, event);

      // ONE transition does all of it -- and note the reducer never CLEARS the
      // approvals. They stop being current because the interval key they were
      // stamped with no longer describes what is on screen.
      expect(snapshotIsCurrent(after), "snapshot must lose authority").toBe(false);
      expect(after.pickedSlotStart, "selection revoked").toBeNull();
      expect(bufferOfferIsCurrent(after), "buffer offer revoked").toBe(false);
      expect(bufferApprovalIsCurrent(after), "buffer approval revoked").toBe(false);
      expect(outsideApprovalIsCurrent(after), "outside approval revoked").toBe(false);
      expect(needsLoad(after), "replacement requested").toBe(true);
      expect(decideWith(after).canConfirm, "submission blocked").toBe(false);
      expect(decideWith(after).plan.allowOutsideAvailability).toBe(false);
    });
  }

  it("the approvals are still PRESENT -- only non-current", () => {
    // Proves the revocation is derived rather than a clear that happens to run.
    const after = reduce(bothApproved(), { type: "DATE_CHANGED", date: "2026-08-21" });
    expect(after.outsideApproval).not.toBeNull();
    expect(after.bufferApproval).not.toBeNull();
    expect(outsideApprovalIsCurrent(after)).toBe(false);
    expect(bufferApprovalIsCurrent(after)).toBe(false);
  });

  it("recovery is DERIVED, so a dimension added later is covered too", () => {
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
    const s0 = initialState(id);
    const s = run(s0, {
      type: "SLOT_REQUEST_SUCCEEDED",
      token: currentRequestToken(s0)!,
      snapshot: SNAP(id),
    });
    expect(s.snapshot?.slots).toHaveLength(1);
    expect(s.snapshot?.window.kind).toBe("open");
    expect(s.snapshot?.serviceDurationMinutes).toBe(60);
    expect(snapshotIsCurrent(s)).toBe(true);
  });

  it("the manual decision measures against the SERVER's duration", () => {
    const id = ID();
    const s = run(
      loaded(id, SNAP(id, { serviceDurationMinutes: 120 })),
      { type: "MANUAL_TIME_ENABLED", enabled: true },
      { type: "MANUAL_TIME_CHANGED", localTime: "16:00" },
    );
    // 16:00 + 120 = 18:00, past a 17:00 close. With a client-held 60 it would
    // have looked fine.
    expect(decideWith(s).manual.verdict).toBe("outside_availability");
  });
});

describe("C — the request TOKEN, not the wanting, governs a load", () => {
  it("recording the start does NOT change the token", () => {
    // This is the invariant the self-cancelling effect violated: if starting a
    // request moved the value the issuing effect is keyed to, the effect would
    // tear itself down.
    const s0 = initialState(ID());
    const token = currentRequestToken(s0)!;
    const started = reduce(s0, { type: "SLOT_REQUEST_STARTED", token });
    expect(currentRequestToken(started)).toBe(token);
    expect(isLoading(started)).toBe(true);
    expect(needsLoad(started)).toBe(false);
  });

  it("a failed refresh keeps display, never authority", () => {
    const s0 = loaded();
    const token = currentRequestToken(s0)!;
    const s = run(
      s0,
      { type: "SLOT_REQUEST_STARTED", token },
      { type: "SLOT_REQUEST_FAILED", token },
    );
    expect(s.snapshot).not.toBeNull(); // display may persist
    expect(snapshotIsCurrent(s)).toBe(false); // authority does not
    expect(decideWith(s).snapshotStale).toBe(true);
    expect(decideWith(s).canConfirm).toBe(false);
  });

  it("a retry moves the token, clears the failure and changes nothing else", () => {
    const s0 = loaded();
    const token = currentRequestToken(s0)!;
    const failed = run(
      s0,
      { type: "SLOT_REQUEST_STARTED", token },
      { type: "SLOT_REQUEST_FAILED", token },
    );
    const retried = reduce(failed, { type: "RETRY_REQUESTED" });

    expect(currentRequestToken(retried)).not.toBe(token);
    expect(currentAvailabilityKey(retried), "same question").toBe(
      currentAvailabilityKey(failed),
    );
    expect(retried.loadFailed).toBe(false);
    expect(retried.identity).toEqual(failed.identity);
    expect(needsLoad(retried)).toBe(true);
  });

  it("a retry is refused when there is no question to ask", () => {
    const s = initialState(ID({ serviceId: null }));
    expect(currentRequestToken(s)).toBeNull();
    expect(reduce(s, { type: "RETRY_REQUESTED" })).toBe(s);
  });

  it("a result for a superseded EPOCH cannot commit", () => {
    // The old request is still for the same availability question, so a
    // key-only guard would let it through. Only the token rejects it.
    const s0 = loaded();
    const stale = currentRequestToken(s0)!;
    const retried = reduce(s0, { type: "RETRY_REQUESTED" });
    expect(availabilityKey(retried.identity)).toBe(availabilityKey(s0.identity));
    const after = reduce(retried, {
      type: "SLOT_REQUEST_SUCCEEDED",
      token: stale,
      snapshot: SNAP(ID(), { serviceDurationMinutes: 999 }),
    });
    expect(after).toBe(retried);
  });
});

describe("D — a stale response cannot alter ANY controller state", () => {
  it("a response for the old identity is ignored entirely", () => {
    const idA = ID();
    const idB = ID({ date: "2026-08-21" });
    const s0 = loaded(idA);
    const tokenA = currentRequestToken(s0)!;
    const moved = reduce(s0, { type: "DATE_CHANGED", date: "2026-08-21" });
    const s = reduce(moved, {
      type: "SLOT_REQUEST_SUCCEEDED",
      token: currentRequestToken(moved)!,
      snapshot: SNAP(idB),
    });
    const withStaleA = reduce(s, {
      type: "SLOT_REQUEST_SUCCEEDED",
      token: tokenA,
      snapshot: SNAP(idA), // A resolves LAST
    });
    expect(withStaleA).toBe(s); // literally no state change
    expect(withStaleA.snapshot?.availabilityKey).toBe(availabilityKey(idB));
  });

  it("a stale FAILURE cannot mark the current candidate failed", () => {
    const s0 = loaded();
    const tokenA = currentRequestToken(s0)!;
    const s = reduce(s0, { type: "DATE_CHANGED", date: "2026-08-21" });
    expect(reduce(s, { type: "SLOT_REQUEST_FAILED", token: tokenA }).loadFailed).toBe(
      false,
    );
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

describe("G — a buffer refusal is scoped to the INTERVAL it was issued for", () => {
  it("an offer for another candidate is refused outright", () => {
    const s = loaded();
    const after = reduce(s, {
      type: "BUFFER_CONFLICT_RETURNED",
      conflict: OFFER(s, { candidateKey: "someone-else" }),
    });
    expect(after.bufferOffer).toBeNull();
  });

  it("an offer for another START on the same candidate is refused too", () => {
    const s = loaded();
    const after = reduce(s, {
      type: "BUFFER_CONFLICT_RETURNED",
      conflict: OFFER(s, { startsAtIso: iso(DATE, "13:00") }),
    });
    expect(after.bufferOffer).toBeNull();
  });

  it("the acknowledged interval travels as a PRECONDITION, not authority", () => {
    const s0 = loaded();
    const s = run(
      s0,
      { type: "BUFFER_CONFLICT_RETURNED", conflict: OFFER(s0) },
      { type: "BUFFER_ACKNOWLEDGED", acknowledged: true },
    );
    const d = decideWith(s);
    expect(d.bufferOffered).toBe(true);
    expect(d.canConfirm).toBe(true);
    expect(d.plan.allowOutsideAvailability).toBe(true);
    expect(d.plan.expectedDurationMinutes).toBe(60);
  });

  it("choosing another suggestion revokes it -- derived, not cleared", () => {
    const s0 = loaded();
    const s = run(
      s0,
      { type: "BUFFER_CONFLICT_RETURNED", conflict: OFFER(s0) },
      { type: "BUFFER_ACKNOWLEDGED", acknowledged: true },
      { type: "SUGGESTION_SELECTED", startsAtIso: iso(DATE, "11:00") },
    );
    expect(s.bufferApproval, "still present").not.toBeNull();
    expect(bufferOfferIsCurrent(s), "but not current").toBe(false);
    expect(decideWith(s).plan.allowOutsideAvailability).toBe(false);
    expect(decideWith(s).plan.expectedDurationMinutes).toBeNull();
  });
});

describe("H — a non-owner is never given an actionable exception", () => {
  const outOfHours = () =>
    run(manualAt("20:00"), { type: "OUTSIDE_HOURS_ACKNOWLEDGED", acknowledged: true });

  it("canConfirm is FALSE for a non-owner even if they tick the box", () => {
    const s = outOfHours();
    expect(decideWith(s, false).manual.overrideReason).toBe("outside_availability");
    expect(decideWith(s, false).canConfirm).toBe(false);
    expect(decideWith(s, false).plan.allowOutsideAvailability).toBe(false);
  });

  it("...and the OWNER path is unchanged", () => {
    const s = outOfHours();
    expect(decideWith(s, true).canConfirm).toBe(true);
    expect(decideWith(s, true).plan.allowOutsideAvailability).toBe(true);
  });

  it("a non-owner can still book an ordinary in-hours suggestion", () => {
    expect(decideWith(loaded(), false).canConfirm).toBe(true);
    expect(decideWith(loaded(), false).plan.allowOutsideAvailability).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE APPROVAL REGRESSION MATRIX. Each case is a defect the first foundation
// shipped: an acknowledgement outliving the interval it was granted for.
// ---------------------------------------------------------------------------

describe("APPROVAL A — the outside-hours time changes", () => {
  it("18:00 acknowledged does not authorise 22:00", () => {
    const at18 = run(manualAt("18:00"), {
      type: "OUTSIDE_HOURS_ACKNOWLEDGED",
      acknowledged: true,
    });
    expect(decideWith(at18).canConfirm).toBe(true);
    expect(decideWith(at18).plan.allowOutsideAvailability).toBe(true);

    const at22 = reduce(at18, { type: "MANUAL_TIME_CHANGED", localTime: "22:00" });

    expect(outsideApprovalIsCurrent(at22)).toBe(false);
    expect(decideWith(at22).outsideExceptionRequired).toBe(true);
    expect(decideWith(at22).outsideExceptionSatisfied).toBe(false);
    expect(decideWith(at22).canConfirm, "22:00 was never acknowledged").toBe(false);
    expect(decideWith(at22).plan.allowOutsideAvailability).toBe(false);

    // ...and acknowledging THIS interval restores it.
    const acked = reduce(at22, { type: "OUTSIDE_HOURS_ACKNOWLEDGED", acknowledged: true });
    expect(decideWith(acked).canConfirm).toBe(true);
    expect(decideWith(acked).plan.startsAtIso).toBe(iso(DATE, "22:00"));
  });

  it("returning to the acknowledged time does not resurrect the approval", () => {
    // The stamp matches again, which is correct: it is the same interval. What
    // must never happen is a DIFFERENT interval inheriting it.
    const at18 = run(manualAt("18:00"), {
      type: "OUTSIDE_HOURS_ACKNOWLEDGED",
      acknowledged: true,
    });
    const wandered = run(
      at18,
      { type: "MANUAL_TIME_CHANGED", localTime: "22:00" },
      { type: "MANUAL_TIME_CHANGED", localTime: "18:00" },
    );
    expect(outsideApprovalIsCurrent(wandered)).toBe(true);
    expect(decideWith(wandered).plan.startsAtIso).toBe(iso(DATE, "18:00"));
  });

  it("an unreadable window is never acknowledgeable", () => {
    const id = ID();
    const s = run(
      manualAt("15:30", loaded(id, SNAP(id, { window: { kind: "unknown" }, slots: [] }))),
      { type: "OUTSIDE_HOURS_ACKNOWLEDGED", acknowledged: true },
    );
    expect(s.outsideApproval, "nothing truthful to acknowledge").toBeNull();
    expect(decideWith(s).canConfirm).toBe(false);
  });
});

describe("APPROVAL B — the custom duration changes", () => {
  it("a buffer approval granted at 60 does not authorise 90", () => {
    const base = manualAt("15:30"); // in hours, ordinary
    const acked = run(
      base,
      { type: "BUFFER_CONFLICT_RETURNED", conflict: OFFER(base) },
      { type: "BUFFER_ACKNOWLEDGED", acknowledged: true },
    );
    expect(bufferApprovalIsCurrent(acked)).toBe(true);
    expect(decideWith(acked).canConfirm).toBe(true);

    const longer = reduce(acked, { type: "CUSTOM_DURATION_CHANGED", minutes: 90 });

    expect(effectiveDurationMinutes(longer)).toBe(90);
    expect(bufferOfferIsCurrent(longer), "the refusal was about 60").toBe(false);
    expect(bufferApprovalIsCurrent(longer)).toBe(false);
    expect(decideWith(longer).plan.allowOutsideAvailability, "not without a fresh ack").toBe(
      false,
    );
    expect(decideWith(longer).canConfirm).toBe(false);
  });
});

describe("APPROVAL C — a default-equivalent length is an ORDINARY booking", () => {
  it("60 against a 60-minute service posts no override at all", () => {
    const s = run(manualAt("15:30"), {
      type: "CUSTOM_DURATION_CHANGED",
      minutes: 60,
    });
    expect(normalizedDurationOverride(s)).toBeNull();
    expect(effectiveDurationMinutes(s)).toBe(60);
    const d = decideWith(s);
    expect(d.manual.requiresOutsideOverride).toBe(false);
    expect(d.canConfirm).toBe(true);
    expect(d.plan.allowOutsideAvailability).toBe(false);
    expect(d.plan.durationOverrideMinutes).toBeNull();
  });

  // The cases above never reach the raw-vs-normalised distinction, because a
  // default-equivalent length means no exception is required at all and the
  // override field is suppressed anyway. The distinction only becomes
  // observable when SOMETHING ELSE requires the exception -- which is exactly
  // the case the defect was reported for.
  it("an out-of-hours time with a default-equivalent length posts NO override", () => {
    const s = run(
      manualAt("20:00"),
      { type: "CUSTOM_DURATION_CHANGED", minutes: 60 }, // == the service default
      { type: "OUTSIDE_HOURS_ACKNOWLEDGED", acknowledged: true },
    );
    const d = decideWith(s);
    expect(d.manual.overrideReason, "the TIME is the exception").toBe(
      "outside_availability",
    );
    expect(d.plan.allowOutsideAvailability).toBe(true);
    expect(
      d.plan.durationOverrideMinutes,
      "...the LENGTH is ordinary and must not be audited as an override",
    ).toBeNull();
  });

  it("a buffer exception with a default-equivalent length posts no override either", () => {
    const base = run(manualAt("15:30"), {
      type: "CUSTOM_DURATION_CHANGED",
      minutes: 60,
    });
    const d = decideWith(
      run(
        base,
        { type: "BUFFER_CONFLICT_RETURNED", conflict: OFFER(base) },
        { type: "BUFFER_ACKNOWLEDGED", acknowledged: true },
      ),
    );
    expect(d.plan.allowOutsideAvailability).toBe(true);
    expect(d.plan.durationOverrideMinutes).toBeNull();
    expect(d.plan.expectedDurationMinutes).toBe(60);
  });

  it("a genuinely different length IS an override, and is posted normalised", () => {
    const s = run(
      manualAt("15:30"),
      { type: "CUSTOM_DURATION_CHANGED", minutes: 45 },
      { type: "OUTSIDE_HOURS_ACKNOWLEDGED", acknowledged: true },
    );
    expect(decideWith(s).manual.overrideReason).toBe("custom_duration");
    expect(decideWith(s).plan.durationOverrideMinutes).toBe(45);
    expect(decideWith(s).plan.allowOutsideAvailability).toBe(true);
  });
});

describe("APPROVAL D — two exceptions need two acknowledgements", () => {
  /** Out of hours AND buffer-refused, nothing acknowledged yet. */
  function both(): InternalBookingState {
    const s = manualAt("20:00");
    return reduce(s, { type: "BUFFER_CONFLICT_RETURNED", conflict: OFFER(s) });
  }
  const OUT: InternalBookingEvent = {
    type: "OUTSIDE_HOURS_ACKNOWLEDGED",
    acknowledged: true,
  };
  const BUF: InternalBookingEvent = { type: "BUFFER_ACKNOWLEDGED", acknowledged: true };

  it("neither acknowledgement: cannot confirm", () => {
    const d = decideWith(both());
    expect(d.outsideExceptionRequired && d.bufferExceptionRequired).toBe(true);
    expect(d.canConfirm).toBe(false);
  });

  it("outside only: cannot confirm", () => {
    const d = decideWith(run(both(), OUT));
    expect(d.outsideExceptionSatisfied).toBe(true);
    expect(d.bufferExceptionSatisfied).toBe(false);
    expect(d.canConfirm).toBe(false);
    expect(d.plan.allowOutsideAvailability).toBe(false);
  });

  it("buffer only: cannot confirm", () => {
    // THE DEFECT: one ternary considered the buffer acknowledgement alone, so
    // this tick authorised the out-of-hours exception nobody agreed to.
    const d = decideWith(run(both(), BUF));
    expect(d.bufferExceptionSatisfied).toBe(true);
    expect(d.outsideExceptionSatisfied).toBe(false);
    expect(d.canConfirm).toBe(false);
    expect(d.plan.allowOutsideAvailability).toBe(false);
  });

  it("both: eligible, and the precondition travels", () => {
    const d = decideWith(run(both(), OUT, BUF));
    expect(d.canConfirm).toBe(true);
    expect(d.plan.allowOutsideAvailability).toBe(true);
    expect(d.plan.expectedDurationMinutes).toBe(60);
    expect(d.plan.startsAtIso).toBe(iso(DATE, "20:00"));
  });

  it("withdrawing either one blocks it again", () => {
    const full = run(both(), OUT, BUF);
    expect(
      decideWith(reduce(full, { type: "BUFFER_ACKNOWLEDGED", acknowledged: false }))
        .canConfirm,
    ).toBe(false);
    expect(
      decideWith(
        reduce(full, { type: "OUTSIDE_HOURS_ACKNOWLEDGED", acknowledged: false }),
      ).canConfirm,
    ).toBe(false);
  });
});

describe("APPROVAL E — a candidate change invalidates without bespoke clearing", () => {
  it("the client is part of the interval, so a client change revokes", () => {
    // The client does NOT change the availability question, so this is the one
    // dimension a slot-identity-only model would have missed entirely.
    const s0 = loaded();
    const acked = run(
      s0,
      { type: "BUFFER_CONFLICT_RETURNED", conflict: OFFER(s0) },
      { type: "BUFFER_ACKNOWLEDGED", acknowledged: true },
    );
    expect(bufferApprovalIsCurrent(acked)).toBe(true);

    const other = reduce(acked, { type: "CLIENT_CHANGED", clientId: "client-2" });
    expect(currentAvailabilityKey(other), "same availability question").toBe(
      currentAvailabilityKey(acked),
    );
    expect(snapshotIsCurrent(other), "so the snapshot stays authoritative").toBe(true);
    expect(bufferApprovalIsCurrent(other), "but the approval does not").toBe(false);
    expect(decideWith(other).plan.allowOutsideAvailability).toBe(false);
  });
});

describe("the ordinary product rules still hold", () => {
  it("an in-hours manual time that is NOT a suggestion books normally", () => {
    const d = decideWith(manualAt("15:30"));
    expect(d.manual.verdict).toBe("inside_availability");
    expect(d.canConfirm).toBe(true);
    expect(d.plan.allowOutsideAvailability).toBe(false);
    expect(d.plan.startsAtIso).toBe(iso(DATE, "15:30"));
  });

  it("an UNKNOWN window blocks the manual path and asserts nothing", () => {
    const id = ID();
    const s = manualAt(
      "15:30",
      loaded(id, SNAP(id, { window: { kind: "unknown" }, slots: [] })),
    );
    const d = decideWith(s);
    expect(d.manual.windowKnown).toBe(false);
    expect(d.manual.overrideReason).toBeNull();
    expect(d.canConfirm).toBe(false);
  });

  it("a successful booking resets the candidate AND asks again", () => {
    const s0 = loaded();
    const s = reduce(s0, { type: "BOOKING_SUCCEEDED" });
    expect(s.pickedSlotStart).toBeNull();
    expect(s.snapshot).toBeNull();
    expect(s.bufferOffer).toBeNull();
    expect(s.outsideApproval).toBeNull();
    // The token must MOVE, or the discarded snapshot would never be replaced.
    expect(currentRequestToken(s)).not.toBe(currentRequestToken(s0));
    expect(needsLoad(s)).toBe(true);
  });

  it("an incomplete candidate has no interval and no request to make", () => {
    const s = initialState(ID({ serviceId: null }));
    expect(currentIntervalKey(s)).toBeNull();
    expect(currentRequestToken(s)).toBeNull();
    expect(needsLoad(s)).toBe(false);
  });
});
