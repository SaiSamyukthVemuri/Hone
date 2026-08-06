// CIVIL-DATE formatting for clinical events.
//
// THE DEFECT THIS FIXES
// ---------------------
// `client_clinical_notes.occurred_at` is a CALENDAR DATE, not an instant. The
// form field is `<input type="date">`, so the value posted is `2026-07-21`;
// the column is `timestamptz`, so Postgres stores it as midnight UTC and reads
// it back as `2026-07-21T00:00:00+00:00`.
//
// Rendering that through `new Date(iso).toLocaleDateString()` converts an
// instant into the VIEWER's timezone. In every negative UTC offset — which is
// every Canadian and US studio, Willow included — midnight UTC on the 21st is
// 8pm on the 20th, so a consultation dated July 21 displayed as July 20. The
// note's own date input would then disagree with the date shown beside it.
//
// A calendar date has no timezone to convert FROM. The fix is to read the
// civil-date portion of the stored value and format it as that date, never as
// an instant.
//
// SCOPE — this module is ONLY for dates that are calendar dates:
//     clinical note occurred_at
// It must NEVER be used for real instants (session started_at, appointment
// times, created_at). Those are moments in time and SHOULD render in the
// viewer's zone — use <FormattedDateTime> for them.
//
// Pure. No I/O. Client-safe (imported by a "use client" component).

export type CivilDate = { year: number; month: number; day: number };

// Leading YYYY-MM-DD of an ISO-8601 value. Deliberately anchored at the start
// and deliberately NOT a full ISO parser: everything after the date portion is
// a time-of-day that a calendar date does not have.
const CIVIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

// The calendar date a stored clinical-event value denotes, or null when the
// value is absent or not a parseable date. Never throws.
export function civilDateParts(
  iso: string | null | undefined,
): CivilDate | null {
  if (typeof iso !== "string") return null;
  const m = CIVIL_DATE_RE.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip through a UTC instant so an impossible calendar date
  // (2026-02-30, 2027-02-29) is rejected rather than silently rolling over
  // into the next month. A real leap day (2028-02-29) round-trips cleanly.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

// HONE'S PRESENTATION LOCALE for clinical dates.
//
// `toLocaleDateString(undefined, …)` means "whatever locale THIS runtime
// defaults to", and a Client Component is rendered twice: once by Node on the
// server, once by the browser during hydration. Those two runtimes do not agree.
// A Vercel Node runtime defaults to en-US and emits "Jul 21, 2026"; a browser
// whose preference is fr-CA emits "21 juill. 2026". Same day, different text —
// a React hydration mismatch on a clinical screen.
//
// `timeZone: "UTC"` pins the DAY. It does not pin the locale-dependent TEXT.
// Both have to be explicit for the output to be deterministic.
//
// en-CA matches what the app already declares about itself: `<html lang="en">`
// and the `en_CA` public metadata locale.
export const HONE_CLINICAL_DATE_LOCALE = "en-CA";

// Format a clinical event's calendar date.
//
// DETERMINISTIC BY CONTRACT: the same `iso` produces the same string in every
// runtime, because BOTH axes are explicit — the locale defaults to Hone's
// declared presentation locale, and the zone is pinned to UTC and cannot be
// overridden. Nothing here reads the server's locale, the browser's preference,
// the client timezone, or the document language.
//
// `opts.locale` exists for deliberate, explicit callers (and for pure formatter
// tests). It is never derived from the environment — a component must not pass
// `navigator.language`, or the determinism this contract provides is gone.
//
// Returns "" for an absent or unparseable value rather than throwing, so a
// malformed row degrades to a blank date instead of taking a clinical screen
// down.
export function formatClinicalDate(
  iso: string | null | undefined,
  opts: { locale?: string | string[]; options?: Intl.DateTimeFormatOptions } = {},
): string {
  const parts = civilDateParts(iso);
  if (!parts) return "";
  const instant = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  );
  // Explicit, never `undefined` — `undefined` is the runtime-dependent default
  // that makes server and browser output diverge.
  const locale = opts.locale ?? HONE_CLINICAL_DATE_LOCALE;
  try {
    return instant.toLocaleDateString(locale, {
      ...DEFAULT_OPTIONS,
      ...opts.options,
      // Not overridable: dropping this is precisely the timezone defect.
      timeZone: "UTC",
    });
  } catch {
    // An invalid EXPLICIT locale tag must not break a clinical screen — and the
    // fallback must still be deterministic, so it uses the app locale rather
    // than the runtime's.
    return instant.toLocaleDateString(HONE_CLINICAL_DATE_LOCALE, {
      ...DEFAULT_OPTIONS,
      timeZone: "UTC",
    });
  }
}

// The stored value reduced to its `YYYY-MM-DD` form — the shape
// `<input type="date">` expects, and a stable, locale-free test handle.
export function clinicalDateInputValue(
  iso: string | null | undefined,
): string {
  const parts = civilDateParts(iso);
  if (!parts) return "";
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}
