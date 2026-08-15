import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { shouldApplyPreviewResponse } from "@/app/(app)/calendar/preview-request";

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
    expect(DRAWER).toMatch(/requestSeq\.current \+= 1/);
  });

  it("clears the previous appointment's detail before loading the next", () => {
    // Without this the drawer would render A's prep under B's header for the
    // duration of B's load — a stale read that looks authoritative.
    expect(DRAWER).toMatch(/setDetail\(null\);\s*\n\s*load\(appointmentId\)/);
  });
});
