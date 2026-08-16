import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { moveDialogSchedule } from "../../../app/(app)/calendar/move-dialog-schedule";

// The rule that decides which schedule Reschedule sends as its expected version.
//
// Why this is worth a dedicated test rather than a source grep: these values are
// not decoration. MoveAppointmentDialog forwards them as 0133's
// p_expected_starts_at / p_expected_ends_at, and 0133 refuses ANY drift with
// `stale_appointment`. Sending the week grid's copy of a schedule that has since
// moved does not produce a cosmetic error — it makes a legitimate reschedule
// impossible for as long as the drawer is open, because the props never change
// while it is.

const GRID = {
  startsAt: "2026-08-20T17:00:00.000Z",
  endsAt: "2026-08-20T18:00:00.000Z",
  durationMinutes: 60,
};

describe("the re-read row wins over the week payload", () => {
  it("uses the DETAIL schedule when the appointment moved under the grid", () => {
    // The exact production case: grid says 17:00, the row is now 18:00.
    const r = moveDialogSchedule({
      grid: GRID,
      detail: {
        startsAt: "2026-08-20T18:00:00.000Z",
        endsAt: "2026-08-20T19:00:00.000Z",
      },
    });
    expect(r.startsAt).toBe("2026-08-20T18:00:00.000Z");
    expect(r.endsAt).toBe("2026-08-20T19:00:00.000Z");
    // Neither stale value survives anywhere in the payload.
    expect(r.startsAt).not.toBe(GRID.startsAt);
    expect(r.endsAt).not.toBe(GRID.endsAt);
  });

  it("still prefers detail when it AGREES with the grid (no accidental grid path)", () => {
    // A positive control. If the implementation only switched to detail on a
    // mismatch, this would still pass by coincidence — so assert identity with
    // the detail object's values, which is what the server will be told.
    const r = moveDialogSchedule({
      grid: GRID,
      detail: { startsAt: GRID.startsAt, endsAt: GRID.endsAt },
    });
    expect(r.startsAt).toBe(GRID.startsAt);
    expect(r.endsAt).toBe(GRID.endsAt);
    expect(r.durationMinutes).toBe(60);
  });

  it("derives duration from the winning pair, never carried over from the grid", () => {
    // The row was lengthened elsewhere: 60 -> 90. Reporting "Duration
    // unchanged: 60 min" beside an 18:00-19:30 span would be a statement the
    // timestamps do not support.
    const r = moveDialogSchedule({
      grid: GRID,
      detail: {
        startsAt: "2026-08-20T18:00:00.000Z",
        endsAt: "2026-08-20T19:30:00.000Z",
      },
    });
    expect(r.durationMinutes).toBe(90);
  });
});

describe("fail back, never forward, when the re-read pair is unusable", () => {
  it("falls back to the grid before any detail has loaded", () => {
    const r = moveDialogSchedule({ grid: GRID, detail: null });
    expect(r).toEqual(GRID);
  });

  it("falls back when a timestamp does not parse, rather than sending garbage", () => {
    // An expected value the server is certain to reject is worse than the stale
    // one: it guarantees the refusal instead of merely risking it.
    const r = moveDialogSchedule({
      grid: GRID,
      detail: { startsAt: "not-a-date", endsAt: "2026-08-20T19:00:00.000Z" },
    });
    expect(r).toEqual(GRID);
  });

  it("keeps the grid duration when the re-read span is non-positive", () => {
    // ends_at at or before starts_at is corrupt, not a zero-minute appointment.
    const r = moveDialogSchedule({
      grid: GRID,
      detail: {
        startsAt: "2026-08-20T18:00:00.000Z",
        endsAt: "2026-08-20T18:00:00.000Z",
      },
    });
    expect(r.durationMinutes).toBe(60);
    // The timestamps themselves are still the fresh ones — only the derived
    // number falls back.
    expect(r.startsAt).toBe("2026-08-20T18:00:00.000Z");
  });
});

describe("the drawer actually routes through this rule", () => {
  const DRAWER = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/calendar/AppointmentPreviewDrawer.tsx"),
    "utf8",
  );

  it("supplies the dialog's schedule THROUGH the rule, not as raw props", () => {
    // The result is SPREAD into the appointment props, which is what makes it
    // the source of startsAt/endsAt/durationMinutes. A direct
    // `startsAt: a.starts_at` prop is what shipped the bug; the grid values now
    // appear only as an INPUT to the rule, which is why this asserts the spread
    // rather than the mere absence of `a.starts_at` anywhere in the file.
    expect(DRAWER).toContain("...moveDialogSchedule({");
  });

  it("feeds the rule the RE-READ detail, not a second copy of the grid", () => {
    expect(DRAWER).toMatch(
      /detail:\s*\{\s*startsAt:\s*detail\.startsAt,\s*endsAt:\s*detail\.endsAt\s*\}/,
    );
  });
});
