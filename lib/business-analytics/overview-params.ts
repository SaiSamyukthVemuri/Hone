import { CUSTOM_COMPARISONS, PERIOD_KINDS, isWholeCalendarMonth, type CustomComparison, type PeriodKind } from "./period";
import { ALL_PRACTITIONERS, type PractitionerFilter } from "./visit-metrics";

// ===========================================================================
// Business → Analytics: THE OVERVIEW'S QUERY PARAMETERS. PURE.
// ===========================================================================
//
// Every parameter is untrusted input. Each is parsed to a closed vocabulary. A page (strict = false) falls back to the default for a bad value and SAYS
// so; a CSV or print route (strict = true) refuses a bad value outright, never silently using today's period. A repeated key is a bad value. A
// practitioner is accepted only when it is one of the studio's own practitioners.

export type SeriesChoice = "money" | "visits";
export const SERIES_CHOICES: readonly SeriesChoice[] = ["money", "visits"];

export type OverviewParams = {
  periodKind: PeriodKind;
  from?: string;
  to?: string;
  compare: CustomComparison;
  practitioner: PractitionerFilter;
  series: SeriesChoice;
};

export const DEFAULT_PERIOD_KIND: PeriodKind = "month_to_date";

export type RawParams = Readonly<Record<string, string | readonly string[] | undefined>>;
export type ParamsResult = { ok: true; params: OverviewParams; notices: string[] } | { ok: false; error: "bad_request" };

const single = (raw: RawParams, key: string): { present: boolean; value: string | undefined; repeated: boolean } => {
  const v = raw[key];
  if (v === undefined) return { present: false, value: undefined, repeated: false };
  if (typeof v === "string") return { present: true, value: v, repeated: false };
  return { present: true, value: v[0], repeated: v.length !== 1 };
};

export function parseOverviewParams(raw: RawParams, opts: { strict: boolean; practitionerIds: ReadonlySet<string> }): ParamsResult {
  const notices: string[] = [];
  let bad = false;
  const fallback = (what: string) => {
    bad = true;
    notices.push(`The ${what} in the address was not recognised, so the default is shown.`);
  };
  const pick = <T extends string>(key: string, allowed: readonly T[], dflt: T, what: string): T => {
    const s = single(raw, key);
    if (!s.present) return dflt;
    if (s.repeated || s.value === undefined || !(allowed as readonly string[]).includes(s.value)) {
      fallback(what);
      return dflt;
    }
    return s.value as T;
  };

  const periodKind = pick<PeriodKind>("period", PERIOD_KINDS, DEFAULT_PERIOD_KIND, "period");
  const compare = pick<CustomComparison>("compare", CUSTOM_COMPARISONS, "preceding", "comparison");
  const series = pick<SeriesChoice>("series", SERIES_CHOICES, "money", "chart choice");

  let practitioner: PractitionerFilter = ALL_PRACTITIONERS;
  const p = single(raw, "practitioner");
  if (p.present) {
    if (p.repeated || p.value === undefined) fallback("practitioner");
    else if (p.value === "all") practitioner = ALL_PRACTITIONERS;
    else if (p.value === "unattributed") practitioner = { kind: "unattributed" };
    else if (opts.practitionerIds.has(p.value)) practitioner = { kind: "one", practitionerId: p.value };
    else fallback("practitioner");
  }

  // Dates are passed through as text: the period resolver is the one place that decides whether they are real dates.
  const f = single(raw, "from");
  const t = single(raw, "to");
  if ((f.present && f.repeated) || (t.present && t.repeated)) fallback("dates");
  const from = f.present && !f.repeated ? f.value : undefined;
  const to = t.present && !t.repeated ? t.value : undefined;

  if (bad && opts.strict) return { ok: false, error: "bad_request" };
  // The comparison for LAST MONTH is the calendar month before it, by definition: whatever the address says, that is what is shown and resubmitted.
  // "The previous calendar month" only makes sense for ONE whole calendar month. Anything else that arrives with it (Last month switched to a Custom range
  // with the old choice still selected, with no script to change it) is compared with the period just before, and SAID, never refused and never quiet.
  let effective: CustomComparison = compare;
  if (periodKind === "previous_month") effective = "previous_month";
  else if (periodKind === "custom" && compare === "previous_month" && !isWholeCalendarMonth(from, to)) {
    effective = "preceding";
    notices.push("The previous calendar month applies to one whole calendar month, so this range is compared with the period just before it.");
  }
  return { ok: true, params: { periodKind, from, to, compare: effective, practitioner, series }, notices };
}

/**
 * The query string for a link to the Overview, from parsed parameters with optional changes. Defaults are left out so a link stays short. Values are
 * encoded; the practitioner value is passed on exactly as the request had it, to the owner-only page only.
 */
export function overviewQuery(params: OverviewParams, patch: Partial<OverviewParams> = {}): string {
  const p = { ...params, ...patch };
  const q = new URLSearchParams();
  if (p.periodKind !== DEFAULT_PERIOD_KIND) q.set("period", p.periodKind);
  if (p.periodKind === "custom") {
    if (p.from) q.set("from", p.from);
    if (p.to) q.set("to", p.to);
    if (p.compare !== "preceding") q.set("compare", p.compare);
  }
  if (p.practitioner.kind === "one") q.set("practitioner", p.practitioner.practitionerId);
  else if (p.practitioner.kind === "unattributed") q.set("practitioner", "unattributed");
  if (p.series !== "money") q.set("series", p.series);
  const s = q.toString();
  return s ? `?${s}` : "";
}
