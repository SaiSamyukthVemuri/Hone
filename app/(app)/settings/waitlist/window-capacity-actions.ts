"use server";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { fetchPublicSlotsForDates } from "@/lib/booking/public-slot-range";
import { addDays, localDateString } from "@/lib/booking/tz";
import { consultationsThatFit, estimateCapacity } from "@/lib/waitlist/consultation-capacity";

// ===========================================================================
// HOW MANY CONSULTATIONS FIT THE WINDOW BEING OFFERED
// ===========================================================================
//
// Owner-only, and everything but the three inputs comes from the SESSION: the
// studio, its buffer and its timezone are never taken from the browser. The
// answer is an ESTIMATE of availability right now. It reserves nothing, and the
// copy beside it says so.

export type WindowCapacityResult =
  | { ok: true; fit: number; outstanding: number; open: number }
  | { ok: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WINDOW_DAYS = 365;

export async function estimateWindowCapacityAction(input: {
  serviceId: string;
  windowDays: number;
  allowedWeekdays: number[] | null;
}): Promise<WindowCapacityResult> {
  try {
    if (
      typeof input?.serviceId !== "string" || !UUID.test(input.serviceId) ||
      !Number.isInteger(input.windowDays) || input.windowDays < 1 || input.windowDays > MAX_WINDOW_DAYS
    ) {
      return { ok: false };
    }
    const weekdays = input.allowedWeekdays;
    if (weekdays !== null && (!Array.isArray(weekdays) || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
      return { ok: false };
    }

    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner") return { ok: false };

    const admin = createAdminClient();
    const { data: row, error } = await admin
      .from("studios")
      .select("slug, timezone, buffer_minutes")
      .eq("id", studio.id)
      .maybeSingle();
    if (error || !row) return { ok: false };

    // The days an invitation's scope would permit: the SAME inclusive
    // studio-local calendar-date range the invitation is issued over (today
    // through today + windowDays - 1, see windowToDates). Stepping calendar
    // dates, not epoch milliseconds, keeps a DST change from skipping or
    // repeating a day.
    const dates: string[] = [];
    const first = localDateString(new Date(), row.timezone as string);
    for (let i = 0; i < input.windowDays; i += 1) {
      const d = addDays(first, i);
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (weekdays === null || weekdays.length === 0 || weekdays.includes(dow)) dates.push(d);
    }
    if (dates.length === 0) return { ok: true, ...estimateCapacity(0, 0) };

    const range = await fetchPublicSlotsForDates({
      slug: row.slug as string,
      serviceId: input.serviceId,
      dates,
    });
    if (!range.ok) return { ok: false };

    // LIVE invitations for EVERY service, from every batch: the studio is one
    // calendar, so an invitation for another service competes for the same
    // window. Sent, not expired, not redeemed, not released, not declined. A booked one is already an
    // appointment in the slot list and is not counted again.
    //
    // READ THROUGH THE OWNER'S OWN SESSION, NOT THE ADMIN CLIENT. service_role has
    // no SELECT on this table (0188 grants it to `authenticated` alone, behind
    // the owner policy), so the admin path answered 42501 every time and the
    // panel always said "couldn't check". The session client is scoped by RLS to
    // the owner's studio; the explicit studio_id filter is belt and braces.
    const session = await createClient();
    const live = await session
      .from("new_client_waitlist_invitations")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studio.id)
      .is("redeemed_at", null)
      .is("expired_at", null)
      .is("released_at", null)
      .is("declined_at", null)
      .gt("expires_at", new Date().toISOString());
    if (live.error) return { ok: false };

    const fit = consultationsThatFit(range.slots, Number(row.buffer_minutes ?? 0));
    return { ok: true, ...estimateCapacity(fit, live.count ?? 0) };
  } catch {
    return { ok: false };
  }
}
