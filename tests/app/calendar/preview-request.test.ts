import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  shouldApplyPreviewResponse,
  detailRemainsCurrent,
  shouldApplyPreviewFailure,
} from "@/app/(app)/calendar/preview-request";

// The A -> B race. A practitioner scanning a week clicks fast; server actions
// carry no ordering guarantee, so appointment A's response can land after
// appointment B's. If it were applied, the drawer would show B's client name
// above A's last treatment, intake state and notes.
//
// NC5 ("remove stale-request protection") turns the guarded cases below red.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("shouldApplyPreviewResponse — the happy path is genuinely reachable", () => {
  it("the newest response for the open appointment IS applied", () => {
    // The positive control. Without it every guard below could be satisfied by
    // a function that always returns false.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestSeq: 7,
        currentSeq: 7,
        openAppointmentId: A,
      }),
    ).toBe(true);
  });
});

describe("shouldApplyPreviewResponse — sequence", () => {
  it("A's late response is dropped once B has been requested", () => {
    // Click A (seq 1), click B (seq 2), A resolves last.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestSeq: 1,
        currentSeq: 2,
        openAppointmentId: B,
      }),
    ).toBe(false);
  });

  it("a superseded response for the SAME appointment is still dropped", () => {
    // Re-opening A, or reloading after a save, issues a new sequence. The older
    // in-flight response for the same id must not overwrite the newer one.
    // Identity alone would not catch this; the sequence is what does.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestSeq: 3,
        currentSeq: 4,
        openAppointmentId: A,
      }),
    ).toBe(false);
  });
});

describe("shouldApplyPreviewResponse — identity", () => {
  it("a response describing a DIFFERENT appointment is dropped even when the sequence matches", () => {
    // The structural backstop: this holds even if the sequence bookkeeping is
    // wrong, which is exactly when it matters.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestSeq: 5,
        currentSeq: 5,
        openAppointmentId: B,
      }),
    ).toBe(false);
  });
});

describe("shouldApplyPreviewResponse — closed drawer", () => {
  it("nothing is applied to a closed drawer", () => {
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestSeq: 9,
        currentSeq: 9,
        openAppointmentId: null,
      }),
    ).toBe(false);
  });
});

describe("the drawer actually uses the rule", () => {
  const DRAWER = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/calendar/AppointmentPreviewDrawer.tsx"),
    "utf8",
  );

  it("routes every successful response through shouldApplyPreviewResponse", () => {
    expect(DRAWER).toMatch(/shouldApplyPreviewResponse\(\{/);
    expect(DRAWER).toMatch(/responseAppointmentId: res\.detail\.appointmentId/);
    expect(DRAWER).toMatch(/openAppointmentId: id/);
  });

  it("takes a fresh sequence per request and closing invalidates in-flight work", () => {
    expect(DRAWER).toMatch(/const seq = \+\+requestSeq\.current/);
    // Closing bumps the sequence too, so a response still in flight is
    // abandoned rather than populating a drawer that is no longer open. It is
    // asserted as "the counter advances", not as one particular increment
    // spelling — the close path now also has to publish the new generation.
    expect(DRAWER).toMatch(/\+\+requestSeq\.current;\s*\n\s*setIssuedSeq\(seq\);\s*\n\s*setDetail\(null\)/);
  });

  it("publishes the issued generation into state so RENDER can see it", () => {
    // A ref read during render would not re-render when it changes, so the
    // currency check would go stale exactly when it matters.
    expect(DRAWER).toMatch(/setIssuedSeq\(seq\)/);
    expect(DRAWER).toMatch(/detailRemainsCurrent\(\{/);
    expect(DRAWER).toMatch(/issuedSeq,/);
  });

  it("routes BOTH failure paths through shouldApplyPreviewFailure", () => {
    // The !ok branch and the rejection branch. Either one applying a superseded
    // failure would report a stale error over a newer verified read.
    const matches = DRAWER.match(/shouldApplyPreviewFailure\(\{/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("holds the detail WITH the generation that produced it", () => {
    expect(DRAWER).toMatch(/setDetail\(\{ value: res\.detail, seq \}\)/);
  });

  it("clears the previous appointment's detail before loading the next", () => {
    // Without this the drawer would render A's prep under B's header for the
    // duration of B's load — a stale read that looks authoritative.
    expect(DRAWER).toMatch(/setDetail\(null\);\s*\n\s*load\(appointmentId\)/);
  });
});

// FRESHNESS HAS A LIFETIME, AND IT BELONGS TO A READ GENERATION.
//
// The drawer refreshes itself after a notes save. That refresh does not clear
// the detail it already holds, so a FAILED refresh used to leave the previous
// detail in place still marked current — and the drawer went on offering Cancel
// and Reschedule, on a schedule that may have changed, next to a load-error
// message. "Verified" is a statement about the newest read, not a property the
// retained object keeps forever.
//
// These are the sequence halves of that rule, kept pure for the same reason
// shouldApplyPreviewResponse is.
describe("detail currency is scoped to the newest read generation", () => {
  it("a detail from the newest issued generation IS current", () => {
    expect(detailRemainsCurrent({ detailSeq: 3, issuedSeq: 3 })).toBe(true);
  });

  it("STARTING a refresh immediately withdraws currency from the held detail", () => {
    // Requirement 1. Nothing has failed yet — the mere existence of a newer
    // in-flight generation means the held copy is no longer being asserted.
    expect(detailRemainsCurrent({ detailSeq: 1, issuedSeq: 2 })).toBe(false);
  });

  it("a FAILED current refresh leaves the held detail non-current", () => {
    // Requirement 2. Failure does not advance the detail, so the generation gap
    // persists and the drawer cannot call the old copy verified.
    expect(detailRemainsCurrent({ detailSeq: 1, issuedSeq: 2 })).toBe(false);
  });

  it("no detail at all is never current", () => {
    expect(detailRemainsCurrent({ detailSeq: null, issuedSeq: 1 })).toBe(false);
  });

  it("a RETRY that succeeds restores currency", () => {
    // Requirement 6.
    expect(detailRemainsCurrent({ detailSeq: 3, issuedSeq: 3 })).toBe(true);
  });
});

describe("a superseded failure may not disturb a newer success", () => {
  it("applies a failure only when it belongs to the newest generation", () => {
    expect(shouldApplyPreviewFailure({ requestSeq: 2, currentSeq: 2 })).toBe(true);
  });

  it("IGNORES generation N's failure once N+1 has been issued", () => {
    // Requirement 5. N+1 may already have succeeded; N arriving late and
    // errorless-ly clearing state would undo a verified newer read.
    expect(shouldApplyPreviewFailure({ requestSeq: 1, currentSeq: 2 })).toBe(false);
  });
});
