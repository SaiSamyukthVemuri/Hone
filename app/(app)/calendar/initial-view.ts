// HON-48 (Sam decision 17): which view /calendar opens on.
//
// Day is the INITIAL view for a team studio (practitioner capacity on and more
// than one active practitioner). "Initial" is an entry with no calendar
// parameter at all: the nav link, the appointment back-link fallback, the
// upcoming list's "Calendar" link. Any ?view=, ?day=, ?week= or ?month= is an
// explicit choice and keeps its existing meaning, so a user's remembered view
// survives (every toggle, step and return link carries its view in the URL).
// A studio that is not a team calendar keeps the week. This changes which view
// renders, never which rows the viewer may read.

export type CalendarEntryParams = {
  view?: string;
  day?: string;
  week?: string;
  month?: string;
};

export function isInitialCalendarEntry(params: CalendarEntryParams): boolean {
  return (
    params.view === undefined &&
    params.day === undefined &&
    params.week === undefined &&
    params.month === undefined
  );
}

// One rule for every studio: a team calendar is capacity on with more than one
// active practitioner.
export function isTeamCalendar(
  capacityEnabled: boolean,
  activePractitioners: ReadonlyArray<unknown>,
): boolean {
  return capacityEnabled && activePractitioners.length > 1;
}
