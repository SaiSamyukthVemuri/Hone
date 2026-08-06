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

// Format a clinical event's calendar date.
//
// Month names come from the viewer's locale (so a French browser reads
// "21 juil. 2026"), but the DATE ITSELF is pinned by `timeZone: "UTC"` against
// a UTC-constructed instant — so the rendered day is the stored day in every
// zone, from Asia/Kolkata to America/Los_Angeles.
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
  try {
    return instant.toLocaleDateString(opts.locale, {
      ...DEFAULT_OPTIONS,
      ...opts.options,
      // Not overridable: dropping this is precisely the defect.
      timeZone: "UTC",
    });
  } catch {
    // An invalid locale tag must not break a clinical screen.
    return instant.toLocaleDateString(undefined, {
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
