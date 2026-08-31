import { describe, expect, it } from "vitest";
import {
  MOVE_NOTICE,
  MOVE_REASON,
  moveConfirmState,
  type MoveConfirmInput,
} from "@/app/(app)/calendar/move-confirm-state";

// EMERG-02 — the Move appointment confirm gate.
//
// The customer report was "custom date + time entered, override acknowledged,
// MOVE APPOINTMENT still greyed out, no explanation". The disabled state turned
// out to be CORRECT (see the authority note below); the missing half was the
// explanation. These pin BOTH halves from the one function that produces them,
// which is the only reason they cannot drift apart.
//
// AUTHORITY: `move_or_reassign_appointment` coalesces a NULL target to the
// appointment's current practitioner and validates it independently — on a
// capacity-ON studio an inactive/ineligible holder returns
// `practitioner_reassignment_required` (0144 -> 0174). tests/db/
// move-target-integrity.db.test.ts proves that against the real database.
// So the reassignment gate below MIRRORS the server; it is not a UI rule, and
// "fixing" it by enabling the button would submit a move the DB refuses.

// Owner, capacity ON, healthy current practitioner, valid future custom time.
const base: MoveConfirmInput = {
  mode: "custom_time",
  submitting: false,
  reassignEnabled: true,
  eligibleIds: ["p-a", "p-b"],
  target: "p-a",
  currentPractitionerId: "p-a",
  hasSlot: false,
  loadingSlots: false,
  date: "2031-09-15",
  customTime: "05:00",
  ackOverride: true,
  timeChanged: true,
};
const state = (over: Partial<MoveConfirmInput> = {}) => moveConfirmState({ ...base, ...over });

describe("A — time-only custom move with a healthy practitioner", () => {
  it("enables, explains nothing, and is NOT a reassignment", () => {
    const s = state();
    expect(s.canConfirm).toBe(true);
    expect(s.disabledReason).toBeNull();
    expect(s.isReassign).toBe(false);
    // The brief is explicit: never show the practitioner message for a
    // legitimate time-only custom move.
    expect(s.reassignmentRequired).toBe(false);
    expect(s.reassignmentNotice).toBeNull();
  });

  it("works identically on a Legacy / capacity-OFF studio (no selector at all)", () => {
    const s = state({ reassignEnabled: false, target: "", currentPractitionerId: "" });
    expect(s.canConfirm).toBe(true);
    expect(s.reassignmentNotice).toBeNull();
  });
});

describe("the reported case — the current practitioner can no longer hold it", () => {
  // The DB refuses to PRESERVE this practitioner, so blocking is correct.
  const ineligible = { eligibleIds: ["p-b"], target: "", currentPractitionerId: "p-a" };

  it("blocks the custom-time move and names the missing prerequisite", () => {
    const s = state(ineligible);
    expect(s.canConfirm).toBe(false);
    expect(s.disabledReason).toBe(MOVE_REASON.reassignmentRequired);
    expect(s.reassignmentNotice).toBe(MOVE_NOTICE.ineligibleHolder);
  });

  it("says WHY even when the appointment holds NO practitioner (the silent case)", () => {
    // practitioner_id is ON DELETE SET NULL. The old gate required a non-empty
    // current id before showing any notice, so this state explained nothing.
    const s = state({ eligibleIds: ["p-b"], target: "", currentPractitionerId: "" });
    expect(s.canConfirm).toBe(false);
    expect(s.disabledReason).toBe(MOVE_REASON.reassignmentRequired);
    expect(s.reassignmentNotice).toBe(MOVE_NOTICE.unassigned);
  });

  it("reports the practitioner blocker AHEAD of any time prerequisite", () => {
    // No date/time entry can satisfy it, so telling the owner to pick a time
    // would send them down a dead end.
    const s = state({ ...ineligible, date: "", customTime: "", ackOverride: false });
    expect(s.disabledReason).toBe(MOVE_REASON.reassignmentRequired);
  });

  it("C — an explicit eligible target unblocks the SAME custom time", () => {
    const s = state({ eligibleIds: ["p-b"], target: "p-b", currentPractitionerId: "p-a" });
    expect(s.canConfirm).toBe(true);
    expect(s.disabledReason).toBeNull();
    expect(s.isReassign).toBe(true);
  });

  it("D — a forged / non-eligible target is never accepted as a choice", () => {
    const s = state({ eligibleIds: ["p-b"], target: "p-forged", currentPractitionerId: "p-a" });
    expect(s.canConfirm).toBe(false);
    expect(s.disabledReason).toBe(MOVE_REASON.reassignmentRequired);
  });
});

describe("B — available-slot mode keeps its own authority", () => {
  const slotMode = { mode: "available_slot" as const, hasSlot: false };

  it("still requires a deliberate target; it never falls back to a time prompt", () => {
    const s = state({ ...slotMode, eligibleIds: ["p-b"], target: "", currentPractitionerId: "p-a" });
    expect(s.canConfirm).toBe(false);
    expect(s.disabledReason).toBe(MOVE_REASON.reassignmentRequired);
  });

  it("asks for a time once a valid target exists", () => {
    expect(state(slotMode).disabledReason).toBe(MOVE_REASON.chooseSlot);
  });

  it("does not offer confirmation while the list is still loading", () => {
    const s = state({ ...slotMode, hasSlot: true, loadingSlots: true });
    expect(s.canConfirm).toBe(false);
    expect(s.disabledReason).toBe(MOVE_REASON.loadingSlots);
  });

  it("confirms a loaded, changed slot", () => {
    expect(state({ ...slotMode, hasSlot: true }).canConfirm).toBe(true);
  });
});

describe("F/G/H — custom-time prerequisites each explain themselves", () => {
  it("F — an unchecked acknowledgement blocks and says so", () => {
    const s = state({ ackOverride: false });
    expect(s.canConfirm).toBe(false);
    expect(s.disabledReason).toBe(MOVE_REASON.acknowledge);
  });

  it("G — a missing time", () => {
    expect(state({ customTime: "" }).disabledReason).toBe(MOVE_REASON.chooseTime);
  });

  it("H — a missing date", () => {
    expect(state({ date: "" }).disabledReason).toBe(MOVE_REASON.chooseDate);
  });

  it("neither entered yet", () => {
    expect(state({ date: "", customTime: "" }).disabledReason).toBe(MOVE_REASON.chooseDateAndTime);
  });

  it("rejects malformed values rather than trusting the input element", () => {
    expect(state({ customTime: "5:00" }).disabledReason).toBe(MOVE_REASON.chooseTime);
    expect(state({ date: "15-09-2031" }).disabledReason).toBe(MOVE_REASON.chooseDate);
  });
});

describe("I — the no_change contract is preserved, not spent on a round trip", () => {
  it("refuses a custom move to the instant the appointment already occupies", () => {
    const s = state({ timeChanged: false });
    expect(s.canConfirm).toBe(false);
    expect(s.disabledReason).toBe(MOVE_REASON.noChange);
  });

  it("still allows a SAME-TIME reassignment (a real change)", () => {
    const s = state({ timeChanged: false, target: "p-b" });
    expect(s.canConfirm).toBe(true);
    expect(s.isReassign).toBe(true);
  });

  it("applies in available-slot mode too", () => {
    const s = state({ mode: "available_slot", hasSlot: true, timeChanged: false });
    expect(s.disabledReason).toBe(MOVE_REASON.noChange);
  });
});

describe("submission", () => {
  it("blocks while a mutation is in flight and adds no second sentence", () => {
    const s = state({ submitting: true });
    expect(s.canConfirm).toBe(false);
    // The button itself already reads "Moving appointment…".
    expect(s.disabledReason).toBeNull();
  });
});

describe("the invariant that keeps copy and button state together", () => {
  const bools = [true, false];
  it("a reason is present for EVERY blocked state except an in-flight submit", () => {
    let blocked = 0;
    for (const mode of ["available_slot", "custom_time"] as const)
      for (const reassignEnabled of bools)
        for (const target of ["", "p-a", "p-b", "p-forged"])
          for (const currentPractitionerId of ["", "p-a"])
            for (const hasSlot of bools)
              for (const loadingSlots of bools)
                for (const date of ["", "2031-09-15"])
                  for (const customTime of ["", "05:00"])
                    for (const ackOverride of bools)
                      for (const timeChanged of bools) {
                        const s = moveConfirmState({
                          ...base,
                          mode,
                          reassignEnabled,
                          target,
                          currentPractitionerId,
                          hasSlot,
                          loadingSlots,
                          date,
                          customTime,
                          ackOverride,
                          timeChanged,
                        });
                        if (s.canConfirm) {
                          expect(s.disabledReason).toBeNull();
                        } else {
                          blocked++;
                          expect(s.disabledReason).not.toBeNull();
                        }
                      }
    expect(blocked).toBeGreaterThan(0);
  });
});
