import { localTimeString } from "@/lib/booking/tz";
import { HOUR_END, HOUR_START } from "./calendar-constants";

type CalendarColumn = {
  availability: { isOpen: boolean; openTime: string | null } | null;
  appts: ReadonlyArray<{ starts_at: string }>;
  timedBlocks: ReadonlyArray<{ starts_at: string }>;
  recurringBreaks: ReadonlyArray<{ starts_at: string }>;
};

export function firstVisibleHour(columns: ReadonlyArray<CalendarColumn>, timezone: string): number {
  let earliest = HOUR_END;
  for (const column of columns) {
    const hours = column.availability;
    if (!hours || (hours.isOpen && !hours.openTime)) return HOUR_START;
    if (hours.isOpen && hours.openTime) earliest = Math.min(earliest, Number(hours.openTime.slice(0, 2)));

    // Include events outside working hours and on closed days.
    for (const group of [column.appts, column.timedBlocks, column.recurringBreaks]) {
      for (const event of group) {
        const clock = localTimeString(new Date(event.starts_at), timezone);
        earliest = Math.min(earliest, Number(clock.slice(0, 2)));
      }
    }
  }
  return earliest < HOUR_END ? Math.max(HOUR_START, earliest) : HOUR_START;
}
