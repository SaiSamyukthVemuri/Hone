// Practitioner-only Birthday row inside the Client info card on the
// client profile Overview tab.
//
// PR #199 (Chloe iPad retest): this was a nested card with its own
// border, a reminders helper line, and
// inline month/day/year editor; inside the PR #198 Client info card
// that read as a box-in-a-box with two Edit affordances. It is now a
// plain row like Emergency contact and Address. Editing happens
// through the Client info card's single Edit link (the edit client
// page has the full Date of birth field), so the inline editor and
// its extra Edit/Clear buttons are gone. The "Birthday today / month"
// callouts keep the studio accent (migration 0040), never red/rose.
//
// Practitioner-facing only. Never imported by public/email/cron/api
// surfaces (audited by grep in PR #28).

import { resolveBirthdayColor } from "@/lib/birthday-colors";
import type { BirthdayReminderColor } from "@/lib/types/database";

type Props = {
  // YYYY-MM-DD from clients.date_of_birth, or null when unset.
  dateOfBirth: string | null;
  // Studio-local today, used to compute the "today" and "this month"
  // callouts. Computed by the server component from todayInTz().
  studioToday: { month: number; day: number };
  // Studio-chosen birthday accent (migration 0040). Never red/rose.
  // Falls back to purple if unset.
  accentColor: BirthdayReminderColor;
};

const MONTHS: ReadonlyArray<string> = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseMonthDay(
  dob: string | null,
): { month: number; day: number } | null {
  if (!dob) return null;
  const parts = dob.split("-");
  if (parts.length !== 3) return null;
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

export function ClientBirthdayCard({
  dateOfBirth,
  studioToday,
  accentColor,
}: Props) {
  const md = parseMonthDay(dateOfBirth);
  // PR #194: surface a REAL stored year (sentinel/placeholder years
  // outside the plausible range stay hidden).
  const storedYear = dateOfBirth ? parseInt(dateOfBirth.slice(0, 4), 10) : NaN;
  const realYear =
    Number.isFinite(storedYear) &&
    storedYear >= 1900 &&
    storedYear <= new Date().getFullYear()
      ? storedYear
      : null;
  const accent = resolveBirthdayColor(accentColor);

  const isToday =
    md != null && md.month === studioToday.month && md.day === studioToday.day;
  const isThisMonth = md != null && md.month === studioToday.month && !isToday;

  return (
    <section>
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
        Birthday
      </h2>
      {md ? (
        <p className="mt-2 text-sm text-neutral-800 dark:text-neutral-200">
          {MONTHS[md.month - 1]} {md.day}
          {realYear ? `, ${realYear}` : ""}
        </p>
      ) : (
        <p className="mt-2 text-sm text-neutral-500">Not added yet.</p>
      )}

      {isToday && (
        <div
          className={`mt-2 flex items-center gap-2 rounded-md border px-3 py-2 ${accent.card}`}
        >
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${accent.badge}`}
          >
            Today
          </span>
          <p
            className={`text-xs font-semibold uppercase tracking-wider ${accent.strongText}`}
          >
            Birthday today
          </p>
        </div>
      )}
      {isThisMonth && (
        <div className={`mt-2 rounded-md border px-3 py-2 ${accent.card}`}>
          <p
            className={`text-xs font-semibold uppercase tracking-wider ${accent.strongText}`}
          >
            Birthday month
          </p>
          <p className={`mt-0.5 text-xs ${accent.strongText}`}>
            Wish them a happy birth month.
          </p>
        </div>
      )}
    </section>
  );
}
