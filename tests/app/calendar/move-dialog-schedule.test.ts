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
    const detail = {
      startsAt: "2026-08-20T18:00:00.000Z",
      endsAt: "2026-08-20T19:00:00.000Z",
      durationMinutes: 60,
    };
    const r = moveDialogSchedule({ grid: GRID, detail });
    expect(r.startsAt).toBe("2026-08-20T18:00:00.000Z");
    expect(r.endsAt).toBe("2026-08-20T19:00:00.000Z");
    // Neither stale value survives anywhere in the payload.
    expect(r.startsAt).not.toBe(GRID.startsAt);
    expect(r.endsAt).not.toBe(GRID.endsAt);
  });

  it("still prefers detail when the TIMESTAMPS agree (falsifiable positive control)", () => {
    // A positive control has to be able to fail. An earlier version of this test
    // gave grid and detail identical primitives, so an implementation that
    // wrongly returned `grid` passed it by coincidence — it asserted nothing.
    //
    // The timestamps still agree (that is the case under test), but the STORED
    // duration differs, so the two sources are observably distinguishable and
    // picking the wrong one is now visible. Proved by mutation: forcing the rule
    // to `return input.grid` turns this red.
    const detail = {
      startsAt: GRID.startsAt,
      endsAt: GRID.endsAt,
      durationMinutes: 45,
    };
    const r = moveDialogSchedule({ grid: GRID, detail });
    expect(r.startsAt).toBe(GRID.startsAt);
    expect(r.endsAt).toBe(GRID.endsAt);
    expect(r.durationMinutes).toBe(45);
    expect(r.durationMinutes).not.toBe(GRID.durationMinutes);
  });
});

describe("stored duration is a FACT, never reconstructed from the span", () => {
  // THE DEFECT THIS PINS. `duration_minutes` carries only a range check
  // (0010: between 5 and 480). NOTHING in the schema ties it to
  // ends_at - starts_at, so a row where they disagree is perfectly valid.
  //
  // And the move command does not treat them as interchangeable: 0133 preserves
  // duration_minutes from the LOCKED row and computes the new end from it —
  //   v_new_ends_at := p_new_starts_at + make_interval(mins => v_appt.duration_minutes)
  // — explicitly never trusting a caller-supplied end.
  //
  // So reconstructing the duration from the span makes the dialog state a
  // number the command will not honour: "Duration unchanged: 90 min" over an
  // operation that preserves 60.
  const MISMATCH = {
    startsAt: "2026-08-20T17:00:00.000Z", // 13:00 local
    endsAt: "2026-08-20T18:30:00.000Z", // 14:30 local — a 90 minute SPAN
    durationMinutes: 60, // but the STORED duration is 60
  };

  it("reports the stored 60, not the 90 minute span", () => {
    const detail = { ...MISMATCH };
    const r = moveDialogSchedule({ grid: MISMATCH, detail });
    expect(r.durationMinutes).toBe(60);
    // The span is 90. If this ever reads 90 the dialog is describing an
    // appointment version that does not exist.
    const spanMinutes =
      (new Date(MISMATCH.endsAt).getTime() - new Date(MISMATCH.startsAt).getTime()) / 60_000;
    expect(spanMinutes).toBe(90);
    expect(r.durationMinutes).not.toBe(spanMinutes);
  });

  it("carries the refreshed timestamps and the refreshed duration TOGETHER", () => {
    // Expected-version values and the stored duration are distinct facts, but
    // they must come from the SAME appointment version. A fresh pair of
    // timestamps married to the grid's duration is a hybrid that never existed.
    const detail = {
      startsAt: "2026-08-20T18:00:00.000Z",
      endsAt: "2026-08-20T19:30:00.000Z",
      durationMinutes: 75,
    };
    const r = moveDialogSchedule({ grid: MISMATCH, detail });
    expect(r.startsAt).toBe(detail.startsAt);
    expect(r.endsAt).toBe(detail.endsAt);
    expect(r.durationMinutes).toBe(75);
    // Nothing from the grid leaked in alongside the fresh pair.
    expect(r.durationMinutes).not.toBe(MISMATCH.durationMinutes);
  });

  it("never forces the span and the duration into agreement", () => {
    const detail = { ...MISMATCH };
    const r = moveDialogSchedule({ grid: MISMATCH, detail });
    // The rule reports both facts as stored; it does not "correct" either one.
    expect(r.endsAt).toBe(MISMATCH.endsAt);
    expect(r.durationMinutes).toBe(MISMATCH.durationMinutes);
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
    const detail = {
      startsAt: "not-a-date",
      endsAt: "2026-08-20T19:00:00.000Z",
      durationMinutes: 90,
    };
    const r = moveDialogSchedule({ grid: GRID, detail });
    expect(r).toEqual(GRID);
  });

  it("falls back TOTALLY when the stored duration is unusable — never a hybrid", () => {
    // The fresh timestamps are perfectly good here. They are still not used,
    // because pairing them with the grid's duration would describe an
    // appointment version that never existed. Fallback is per-VERSION, not
    // per-field.
    const detail = {
      startsAt: "2026-08-20T18:00:00.000Z",
      endsAt: "2026-08-20T19:00:00.000Z",
      durationMinutes: 0,
    };
    const r = moveDialogSchedule({ grid: GRID, detail });
    expect(r).toEqual(GRID);
    expect(r.startsAt).not.toBe(detail.startsAt);
  });

  it("a span disagreeing with the stored duration is NOT a reason to fall back", () => {
    // The row is valid: 0010 constrains duration_minutes to 5..480 and says
    // nothing about the span. Both facts are reported as stored.
    const detail = {
      startsAt: "2026-08-20T18:00:00.000Z",
      endsAt: "2026-08-20T19:30:00.000Z",
      durationMinutes: 60,
    };
    const r = moveDialogSchedule({ grid: GRID, detail });
    expect(r.startsAt).toBe(detail.startsAt);
    expect(r.endsAt).toBe(detail.endsAt);
    expect(r.durationMinutes).toBe(60);
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

  it("feeds the rule the RE-READ detail, including its STORED duration", () => {
    expect(DRAWER).toMatch(/startsAt:\s*detail\.startsAt/);
    expect(DRAWER).toMatch(/endsAt:\s*detail\.endsAt/);
    // The regression that made this round necessary: the duration must come
    // from the re-read row, not be reconstructed downstream from the span.
    expect(DRAWER).toMatch(/durationMinutes:\s*detail\.durationMinutes/);
  });

  it("the loader actually carries duration_minutes for it to use", () => {
    const LOADER = readFileSync(
      path.resolve(__dirname, "../../../lib/calendar/appointment-preview-detail.ts"),
      "utf8",
    );
    // Selected from the row...
    expect(LOADER).toMatch(/duration_minutes/);
    // ...and surfaced on the payload rather than left for a caller to derive.
    expect(LOADER).toMatch(/durationMinutes:\s*raw\.duration_minutes/);
  });
});
