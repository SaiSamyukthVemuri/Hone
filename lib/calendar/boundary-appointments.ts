import { getAppointmentsForRange } from "@/lib/booking/queries";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";

// The calendar loads appointments by START time inside the period, so one that began before the
// period and runs into it (a midnight-crossing visit) is not in the view's data. Time insights must
// count its minutes inside the period, so this reads the day before through the SAME function and
// the SAME studio scope as the view (same RLS, same rows a viewer already sees: it cannot widen
// access) and keeps only those that end after the period starts. They feed the totals only, never
// the grid.

const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function crossesInto<T extends { ends_at: string }>(rows: ReadonlyArray<T>, periodStartMs: number): T[] {
  return rows.filter((r) => Date.parse(r.ends_at) > periodStartMs);
}

export async function getBoundaryCrossingAppointments(
  studioId: string,
  periodStart: Date,
): Promise<AppointmentWithPractitionerColor[]> {
  const rows = await getAppointmentsForRange(
    studioId,
    new Date(periodStart.getTime() - LOOKBACK_MS).toISOString(),
    periodStart.toISOString(),
  );
  return crossesInto(rows, periodStart.getTime());
}
