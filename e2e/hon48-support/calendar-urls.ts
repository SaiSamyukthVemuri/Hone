// PURE. The calendar URLs the five-user spec visits, built so a run never depends on the day it happens to run.
import { firstOfMonthString } from "../../lib/booking/month-grid";
import { SELECTION_PARAM } from "../../lib/calendar/practitioner-selection";

/**
 * `people=<every id>` is an EXPLICIT choice of everyone. Omitting the param is not the same thing: a link with no param restores the
 * viewer's own last selection (the sidebar's own-calendar-only default for a member), so a member's Day view would hide the other
 * four columns. An explicit list of every listed practitioner parses as "all" and is remembered as the choice.
 */
export function everyoneQuery(practitionerIds: ReadonlyArray<string>): string {
  return `${SELECTION_PARAM}=${practitionerIds.join(",")}`;
}

export function dayUrl(day: string, practitionerIds: ReadonlyArray<string>): string {
  return `/calendar?view=day&day=${day}&${everyoneQuery(practitionerIds)}`;
}

export function weekUrl(day: string, practitionerIds: ReadonlyArray<string>): string {
  return `/calendar?view=week&day=${day}&${everyoneQuery(practitionerIds)}`;
}

/**
 * The Month view defaults to the month of TODAY, not of the day being asked about. In the last days of a month the seeded day falls
 * in the next month, so the view must be anchored to the seeded day's own month with `month=`.
 */
export function monthUrl(day: string, practitionerIds: ReadonlyArray<string>): string {
  return `/calendar?view=month&month=${firstOfMonthString(day)}&day=${day}&${everyoneQuery(practitionerIds)}`;
}
