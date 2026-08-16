// Which schedule Reschedule is allowed to call "the current one".
//
// The week grid is rendered once and then sits on screen. If the appointment
// moves — another tab, another practitioner, a drag on another device — that
// payload is stale, and the drawer's own re-read is the only fresh copy the page
// has. The drawer ALREADY prefers the re-read row for the action gate, which is
// why Cancel and Reschedule correctly appear and disappear; this is the same
// decision applied to the values those actions carry.
//
// It is not a display preference. MoveAppointmentDialog forwards startsAt/endsAt
// as p_expected_starts_at / p_expected_ends_at, and 0133 refuses ANY drift with
// `stale_appointment` — deliberately, because that expected-version check is
// what stops two practitioners silently overwriting each other's move. Handing
// it the grid's copy therefore does not merely look wrong: it makes the move
// impossible, and it STAYS impossible for as long as the drawer is open, because
// the props never change while it is. The practitioner sees "This appointment
// changed in another window. Refresh and try again." on every retry, from a
// drawer that had just read the truth and then argued with it.
//
// So: prefer the re-read row whenever one has arrived, and fall back to the grid
// only before it does (the actions are not offered then anyway — `canAct`
// requires a loaded detail — so the fallback is a type-level courtesy, not a
// live path).
//
// Duration is DERIVED from whichever pair won, never carried across from the
// other, so the dialog's "Duration unchanged: N min" cannot end up describing a
// span that neither timestamp supports.
//
// Pure: no React, no clock, no I/O. Lives here rather than inline in the drawer
// for the same reason shouldApplyPreviewResponse does — a rule that can only be
// exercised through a rendered component is a rule nobody re-checks.

const MS_PER_MINUTE = 60_000;

export type MoveDialogSchedule = {
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
};

export type MoveDialogScheduleInput = {
  // The week-grid payload's copy, which may be arbitrarily old.
  grid: MoveDialogSchedule;
  // The drawer's re-read of the same appointment, or null before it lands.
  detail: { startsAt: string; endsAt: string } | null;
};

function instantOf(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function moveDialogSchedule(
  input: MoveDialogScheduleInput,
): MoveDialogSchedule {
  const startMs = instantOf(input.detail?.startsAt);
  const endMs = instantOf(input.detail?.endsAt);

  // An unparseable pair is not fresher than the grid, it is just unusable. Fail
  // back rather than forward an expected value the server is certain to reject.
  if (startMs === null || endMs === null) return input.grid;

  const derived = Math.round((endMs - startMs) / MS_PER_MINUTE);
  return {
    startsAt: input.detail!.startsAt,
    endsAt: input.detail!.endsAt,
    // A non-positive span is not a duration. Keep the grid's number rather than
    // render "0 min" next to two timestamps that plainly disagree with it.
    durationMinutes: derived > 0 ? derived : input.grid.durationMinutes,
  };
}
