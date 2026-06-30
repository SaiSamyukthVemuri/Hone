// Calendar return-to-date navigation (Chloe pilot feedback).
//
// When a practitioner opens an appointment from the calendar, we attach a
// small return context to the detail URL so the detail page's back link can
// send them to the SAME view/date they came from instead of resetting to the
// current week.
//
// Safety: we never accept or echo a full return URL (no open-redirect
// surface). The return target is ALWAYS `/calendar` plus a validated subset
// of the existing calendar params — `view` (week|month) and the date anchors
// `week`/`month` (strict YYYY-MM-DD). Anything else is dropped, so the back
// link can only ever point inside `/calendar`.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Next.js searchParams values are `string | string[] | undefined`.
type ParamValue = string | string[] | null | undefined;

export type CalendarReturnContext = {
  view?: ParamValue;
  week?: ParamValue;
  month?: ParamValue;
};

function firstValue(v: ParamValue): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// Build the query string (including the leading "?") to append to an
// appointment-detail link. Returns "" when there is no valid context.
export function buildCalendarReturnParams(ctx: CalendarReturnContext): string {
  const params = new URLSearchParams();

  const rawView = firstValue(ctx.view);
  const view = rawView === "month" ? "month" : rawView === "week" ? "week" : null;
  if (view) params.set("view", view);

  const week = firstValue(ctx.week);
  if (week && DATE_RE.test(week)) params.set("week", week);

  const month = firstValue(ctx.month);
  if (month && DATE_RE.test(month)) params.set("month", month);

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// Reconstruct the SAFE internal /calendar href from (untrusted) detail-page
// searchParams. Always returns a path under `/calendar` — never external.
// Falls back to bare `/calendar` when no valid context is present.
export function calendarReturnHref(ctx: CalendarReturnContext): string {
  return `/calendar${buildCalendarReturnParams(ctx)}`;
}
