// Which appointment VERSION Reschedule is allowed to describe.
//
// The week grid is rendered once and then sits on screen. If the appointment
// moves — another tab, another practitioner, a drag on another device — that
// payload is stale, and the drawer's own re-read is the only fresh copy the page
// has. The drawer ALREADY prefers the re-read row for the action gate, which is
// why Cancel and Reschedule correctly appear and disappear; this applies the
// same preference to the values those actions carry.
//
// TWO DISTINCT FACTS, NEITHER DERIVED FROM THE OTHER.
//
//   expected version   starts_at + ends_at. MoveAppointmentDialog forwards these
//                      as 0133's p_expected_starts_at / p_expected_ends_at, and
//                      0133 refuses ANY drift with `stale_appointment` —
//                      deliberately, because that check is what stops two
//                      practitioners silently overwriting each other's move.
//
//   duration           duration_minutes, the STORED column. 0133 preserves it
//                      from the LOCKED row and computes the new end from it:
//                        v_new_ends_at := p_new_starts_at
//                                         + make_interval(mins => v_appt.duration_minutes)
//                      It never trusts a caller-supplied end.
//
// Reconstructing the duration as `ends_at - starts_at` looks equivalent and is
// not. `duration_minutes` carries only a range check (0010: between 5 and 480);
// nothing in the schema ties it to the span, so a row where they disagree is
// valid. On such a row a reconstructed value makes the dialog announce
// "Duration unchanged: 90 min" over an operation that will preserve 60 — the UI
// stating a number the command has already decided to ignore.
//
// ALL OR NOTHING. Whichever source wins supplies all three values. A fresh pair
// of timestamps married to the grid's duration is a hybrid that never described
// any real appointment version, and it is exactly the shape that reads as
// "mostly fresh" while being wrong. So the fallback is total, not per-field.
//
// Pure: no React, no clock, no I/O. It lives here rather than inline in the
// drawer for the same reason shouldApplyPreviewResponse does — this repo's
// vitest runs `environment: "node"` with no DOM, so a rule left inside a
// component is a rule no unit test can reach.

export type MoveDialogSchedule = {
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
};

export type MoveDialogScheduleInput = {
  // The week-grid payload's copy, which may be arbitrarily old.
  grid: MoveDialogSchedule;
  // The drawer's re-read of the same appointment, or null before it lands.
  detail: MoveDialogSchedule | null;
};

function isInstant(value: string | null | undefined): boolean {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function isDuration(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function moveDialogSchedule(
  input: MoveDialogScheduleInput,
): MoveDialogSchedule {
  const d = input.detail;

  // No re-read yet. In practice unreachable from the drawer — `canAct` requires
  // a loaded detail before either action is offered — but the type permits it
  // and a total fallback is the honest answer.
  if (!d) return input.grid;

  // An unusable re-read is not fresher than the grid, it is just unusable.
  // Fail BACK to a coherent older version rather than forward an expected value
  // the server is certain to reject, or a duration it will not honour.
  if (!isInstant(d.startsAt) || !isInstant(d.endsAt) || !isDuration(d.durationMinutes)) {
    return input.grid;
  }

  // One version, reported as stored. Note that a span disagreeing with
  // durationMinutes is NOT corrected here: both are facts about the same row,
  // and the move command reads the duration, so silently "fixing" either one
  // would be inventing a version to make the two agree.
  return {
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    durationMinutes: d.durationMinutes,
  };
}
