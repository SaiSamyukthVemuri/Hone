import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPublicSlotsForDates } from "@/lib/booking/public-slot-range";
import { addDays, localDateString } from "@/lib/booking/tz";
import { consultationsThatFit } from "@/lib/waitlist/consultation-capacity";

// ===========================================================================
// HOW MANY CONSULTATIONS FIT THE WINDOW BEING OFFERED — computed on the SERVER
// ===========================================================================
//
// One implementation, two callers: the owner's estimate (display) and the send
// (enforcement). The SEND calls this itself, at send time, from the slot engine
// and the exact selections being sent. A fit that arrives from the browser is
// never read: 0324's guard enforces whatever fit this module returns, so this is
// the only place that number may come from.
//
// RESIDUAL, NAMED: availability can change between this computation and the
// database's studio lock. A slot taken in that gap is not seen by the guard.
// Invitations do not reserve appointments.

export type FitInput = {
  /** The caller's own admin client (this module imports none, so it widens no service-role surface). */
  admin: Pick<SupabaseClient, "from">;
  studioId: string;
  serviceId: string;
  windowDays: number;
  allowedWeekdays: readonly number[] | null;
};

export type FitResult = { ok: true; fit: number; firstDate: string } | { ok: false };

export async function computeConsultationFit(input: FitInput): Promise<FitResult> {
  try {
    const { data: row, error } = await input.admin
      .from("studios")
      .select("slug, timezone, buffer_minutes")
      .eq("id", input.studioId)
      .maybeSingle();
    if (error || !row) return { ok: false };

    // The days an invitation's scope would permit: the SAME inclusive studio-local calendar-date range
    // the invitation is issued over (today through today + windowDays - 1). Stepping calendar dates,
    // not epoch milliseconds, keeps a DST change from skipping or repeating a day.
    const weekdays = input.allowedWeekdays;
    const first = localDateString(new Date(), row.timezone as string);
    const dates: string[] = [];
    for (let i = 0; i < input.windowDays; i += 1) {
      const d = addDays(first, i);
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (weekdays === null || weekdays.length === 0 || weekdays.includes(dow)) dates.push(d);
    }
    if (dates.length === 0) return { ok: true, fit: 0, firstDate: first };

    const range = await fetchPublicSlotsForDates({
      slug: row.slug as string,
      serviceId: input.serviceId,
      dates,
    });
    if (!range.ok) return { ok: false };
    return { ok: true, fit: consultationsThatFit(range.slots, Number(row.buffer_minutes ?? 0)), firstDate: first };
  } catch {
    return { ok: false };
  }
}
