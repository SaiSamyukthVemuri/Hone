import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR: booking-drawer behavior (Chloe calendar friction), updated by the
// smart-suggestions-vs-availability split.
//
// The behaviours these pins protect are UNCHANGED and still required:
//   * the manual-time / outside-hours state must reset OFF for each new booking
//     attempt (never sticky across slots or after a failure);
//   * the practitioner's clicked time must be preserved, never snapped to a
//     different suggested slot;
//   * booking genuinely OUTSIDE availability must require an explicit
//     acknowledgement.
//
// What changed is that "choose another time" and "book outside availability"
// are no longer the same state. The identifiers were renamed accordingly
// (overrideEnabled -> manualTimeEnabled, overrideConfirmed ->
// outsideHoursConfirmed, overrideLocalTime -> manualLocalTime), and the
// acknowledgement is now CONDITIONAL on the chosen time actually being outside
// the working-hours window. vitest env is "node" (no DOM) → verified by source
// pins; the behavioural proof lives in
// tests/app/calendar/manual-time-inside-availability.test.ts.
const DRAWER = readFileSync(
  path.resolve(__dirname, "../../../app/(app)/calendar/QuickBookDrawer.tsx"),
  "utf8",
);

describe("manual-time + outside-hours state resets for each booking attempt (not sticky)", () => {
  it("resets on drawer close (fresh draft) — both off", () => {
    // THE ANCHOR MUST EXIST. This slice used to end at
    // `"}, [open, firstServiceId]"`, which has never appeared in the drawer —
    // the dependency array has always carried currentPractitionerId too. So
    // indexOf returned -1, slice(start, -1) spanned nearly the whole file, and
    // the two assertions below passed on any occurrence anywhere in the
    // component instead of proving anything about the close block. Asserting
    // the anchor resolves is what makes the slice non-vacuous.
    const start = DRAWER.indexOf("if (!open) {");
    const end = DRAWER.indexOf("}, [open, firstServiceId, currentPractitionerId]);");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const closeBlock = DRAWER.slice(start, end);
    expect(closeBlock).toMatch(/setManualTimeEnabled\(false\)/);
    expect(closeBlock).toMatch(/setOutsideHoursConfirmed\(false\)/);
    // ANTI-VACUITY: the slice must be the close effect, not the whole file.
    expect(closeBlock.length).toBeLessThan(DRAWER.length / 2);
  });
  it("resets on a NEW bare-click slot (the else branch no longer leaks the prior state)", () => {
    expect(DRAWER).toMatch(
      /Bare click on a NEW slot[\s\S]*setManualTimeEnabled\(false\)[\s\S]*setOutsideHoursConfirmed\(false\)/,
    );
  });
  it("resets after a FAILED submit so it is not stuck on for the next attempt", () => {
    expect(DRAWER).toMatch(
      /A failed attempt must NOT leave[\s\S]*?setManualTimeEnabled\(false\);[\s\S]*?setOutsideHoursConfirmed\(false\);/,
    );
  });
  it("successful submit closes the drawer → the close reset clears the state", () => {
    expect(DRAWER).toMatch(/router\.refresh\(\);\s*\n\s*onClose\(\);/);
  });
  it("a drag still SOFT-enables the manual-time path (that hint is per-attempt)", () => {
    // The only literal true-enable is the drag branch; the checkbox uses
    // e.target.checked. A SECOND auto-enable path would make the state sticky
    // again, which is the regression this count exists to catch.
    expect(DRAWER.match(/setManualTimeEnabled\(true\)/g)?.length).toBe(1);
    expect(DRAWER).toMatch(
      /if \(dragMinutes && dragMinutes > 0\) \{[\s\S]*?setManualTimeEnabled\(true\)/,
    );
  });
});

describe("practitioner clicked time is preserved (never snapped to a different slot)", () => {
  it("the manual time is seeded from the clicked draft time and submitted exactly", () => {
    expect(DRAWER).toMatch(/setManualLocalTime\(draft\.localTime\)/);
    expect(DRAWER).toMatch(
      /utcInstantFromLocal\(\s*draft!\.localDate,\s*manualLocalTime,\s*studioTimezone,?\s*\)/,
    );
  });
  it("preselects an EXACT-match suggestion by INSTANT, never a different suggestion", () => {
    // Exact match on the clicked time, else null — no nearest-slot substitution.
    //
    // This must compare INSTANTS. The previous pin accepted
    // `s.startLabel === targetHint`, which compared a 12-hour rendered label
    // ("3:10 PM") against a 24-hour machine value ("15:10") and could therefore
    // never be true for any input — so the pin passed while the behaviour it
    // claimed to protect had never once executed. Pinning the instant
    // comparison is what makes this guard non-vacuous.
    expect(DRAWER).toMatch(
      /const exact = futureSlots\.find\(\s*\(s\) => new Date\(s\.start\)\.getTime\(\) === hintMs,?\s*\)/,
    );
    expect(DRAWER).toMatch(/setPickedSlot\(exact \?\? null\)/);
    // and the broken label comparison must not come back
    expect(DRAWER).not.toMatch(/s\.startLabel === targetHint/);
  });
});

describe("booking outside availability still requires an explicit acknowledgement", () => {
  it("submit is blocked unless an OUTSIDE-HOURS time is confirmed", () => {
    expect(DRAWER).toMatch(
      /if \(requiresOutsideOverride && !outsideHoursConfirmed\) return;/,
    );
  });
  it("Save stays disabled until an outside-hours time is confirmed", () => {
    expect(DRAWER).toMatch(
      /\(!requiresOutsideOverride \|\| outsideHoursConfirmed\)/,
    );
  });
  it("the acknowledgement is NOT demanded for a time inside working hours", () => {
    // The whole point of the split: `requiresOutsideOverride` gates both the
    // acknowledgement and the flag, and it comes from the SHARED decision
    // function over the real window rather than from "is the manual field
    // open?". The decision itself is proved behaviourally in
    // tests/lib/booking/availability-window.test.ts.
    expect(DRAWER).toMatch(/decideManualTime\(\{/);
    expect(DRAWER).toMatch(
      /const requiresOutsideOverride =\s*\n?\s*manualTimeEnabled && manualDecision\.requiresOutsideOverride;/,
    );
  });
  it("allow_outside_availability is posted ONLY for an acknowledged reason", () => {
    // A bare `fd.set("allow_outside_availability", "true")` outside the guarded
    // branch would re-create the original defect: an ordinary working time
    // filed as an out-of-hours exception.
    //
    // The guard has two arms because the DB flag bypasses two different soft
    // rules — working hours, and the 0152 buffer. Each arm requires its own
    // explicit acknowledgement, so neither fires on its own.
    expect(DRAWER).toMatch(
      /const postsOutsideAvailability =\s*\n?\s*requiresOutsideOverride \|\| \(bufferOverrideOffered && bufferOverrideConfirmed\);/,
    );
    expect(DRAWER).toMatch(
      /if \(postsOutsideAvailability\) \{\s*\n\s*fd\.set\("allow_outside_availability", "true"\);/,
    );
    expect(
      DRAWER.match(/fd\.set\("allow_outside_availability", "true"\)/g)?.length,
    ).toBe(1);
  });

  it("a buffer refusal keeps the typed time instead of resetting it away", () => {
    // The generic failure reset wipes manualTimeEnabled so a failed attempt is
    // not sticky. For buffer_conflict that would throw away the very time the
    // owner is being asked to confirm, leaving the offer unacceptable. The
    // buffer branch must return BEFORE that reset.
    expect(DRAWER).toMatch(
      /if \(r\.code === "buffer_conflict"\) \{[\s\S]*?setBufferOverrideOffered\(true\);[\s\S]*?return;\s*\n\s*\}/,
    );
    const bufferBranch = DRAWER.indexOf('if (r.code === "buffer_conflict")');
    const genericReset = DRAWER.indexOf(
      "A failed attempt must NOT leave the outside-availability override",
    );
    expect(bufferBranch).toBeGreaterThan(-1);
    expect(genericReset).toBeGreaterThan(bufferBranch);
  });
});
