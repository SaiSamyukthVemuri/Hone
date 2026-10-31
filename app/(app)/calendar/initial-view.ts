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

// HON-48: who gets the Day view at all. Sam's requirement is that ONE working
// practitioner sees their name, appointments, availability and a visible slot
// grid in a normal compact column. So the Day view is offered when capacity is on
// and there is at least one active practitioner, or when capacity is off and there
// is EXACTLY one (a solo studio). Capacity off with two or more active keeps the
// week grid: changing that is a product call nobody made. It is NOT the initial
// view for a lone practitioner (isTeamCalendar still decides that), and week and
// month are unchanged. A studio with no active practitioner has no day to show.
export function hasDayView(
  capacityEnabled: boolean,
  activePractitioners: ReadonlyArray<unknown>,
): boolean {
  const n = activePractitioners.length;
  return capacityEnabled ? n >= 1 : n === 1;
}
