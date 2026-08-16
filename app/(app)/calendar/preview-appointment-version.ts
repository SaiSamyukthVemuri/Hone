// Which VERSION of the appointment the preview drawer is describing.
//
// The drawer holds two copies of the same booking. The week payload was
// rendered once and then sat on screen; the drawer's own re-read is the fresh
// one. Every fact the drawer shows or acts on has to come from ONE of them, and
// the same one, or the drawer contradicts itself.
//
// It has done exactly that, twice, and both times because the choice was made
// per-field at the point of use rather than once:
//
//   * the status line read the re-read row while the time line read the grid,
//     so a moved appointment displayed its old time beside its new status, and
//     Reschedule opened on a third answer;
//   * the action gate read the re-read row while the move payload read the grid,
//     so a legitimate move was refused as `stale_appointment`.
//
// So the selection happens HERE, once, and callers take all of it or none of it.
//
// THE FACTS, AND WHY NONE IS DERIVED FROM ANOTHER.
//
//   startsAt / endsAt   the expected version. MoveAppointmentDialog forwards
//                       these as 0133's p_expected_starts_at / p_expected_ends_at
//                       and 0133 refuses ANY drift with `stale_appointment`.
//
//   durationMinutes     the STORED column. 0133 preserves it from the LOCKED row
//                       and computes the new end from it, never trusting a
//                       caller-supplied end. 0010 range-checks it (5..480) and
//                       says nothing about the span, so a row where the two
//                       disagree is valid and must be reported as stored —
//                       reconstructing it would announce a number the command
//                       has already decided to ignore.
//
//   status              what the row IS now. A booking cancelled in another
//                       window is cancelled here, and must not be labelled from
//                       the grid's memory of it.
//
// ALL OR NOTHING. A fresh pair of timestamps married to the grid's duration, or
// a fresh status over a stale time, describes an appointment version that never
// existed. That hybrid is the shape that reads as "mostly fresh" while being
// wrong, so the fallback is total, not per-field.
//
// `fresh` is the discriminator callers gate on. It means BOTH that the re-read
// row supplied every value below AND that the read is still the current one. It
// is deliberately NOT "a read was attempted", and NOT "a read once succeeded":
//
//   * an unusable re-read yields the grid snapshot with fresh === false;
//   * a detail held from an OLDER generation — because a refresh is in flight,
//     or because the current refresh failed — keeps supplying the DISPLAY (it is
//     still newer than the week grid) but reports fresh === false, so it can no
//     longer authorize Cancel or Reschedule.
//
// That second case is the difference between showing the last thing we saw and
// claiming it is true now. A failed refresh must never leave a supposedly
// verified version behind it.
//
// Pure: no React, no clock, no I/O.

export type PreviewAppointmentFacts = {
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: string;
};

export type PreviewAppointmentVersion = PreviewAppointmentFacts & {
  // True only when the re-read detail supplied every field above.
  fresh: boolean;
};

export type PreviewAppointmentVersionInput = {
  // The week-grid payload's copy, which may be arbitrarily old.
  grid: PreviewAppointmentFacts;
  // The drawer's re-read of the same appointment, or null before it lands.
  detail: PreviewAppointmentFacts | null;
  // Whether that detail came from the NEWEST read generation issued. Required,
  // not defaulted: a caller that forgets it is exactly the caller that would
  // hand stale data action authority.
  detailIsCurrent: boolean;
};

function isInstant(value: string | null | undefined): boolean {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function isDuration(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isStatus(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function previewAppointmentVersion(
  input: PreviewAppointmentVersionInput,
): PreviewAppointmentVersion {
  const d = input.detail;

  // No re-read yet: the grid snapshot is all there is, and saying so is the
  // honest answer. Callers that gate actions on `fresh` will not offer any.
  if (!d) return { ...input.grid, fresh: false };

  // An unusable re-read is not fresher than the grid, it is just unusable. Fail
  // BACK to a coherent older version rather than forward an expected value the
  // server is certain to reject, a duration it will not honour, or a blank
  // status that would render as "Upcoming".
  if (
    !isInstant(d.startsAt)
    || !isInstant(d.endsAt)
    || !isDuration(d.durationMinutes)
    || !isStatus(d.status)
  ) {
    return { ...input.grid, fresh: false };
  }

  // One version, reported as stored. A span that disagrees with durationMinutes
  // is NOT a reason to reject it: both are facts about the same row, and
  // "correcting" either would be inventing a version to make them agree.
  //
  // `fresh` carries the currency question, and only that: a superseded detail
  // still DISPLAYS (it beats the grid) while authorizing nothing.
  return {
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    durationMinutes: d.durationMinutes,
    status: d.status,
    fresh: input.detailIsCurrent,
  };
}
