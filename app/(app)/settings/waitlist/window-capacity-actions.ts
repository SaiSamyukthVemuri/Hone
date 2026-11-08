"use server";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { fetchPublicSlotsForDates } from "@/lib/booking/public-slot-range";
import { localDateString } from "@/lib/booking/tz";
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

    // STUDIO-LOCAL dates from tomorrow forward, the same days an invitation's
    // scope would permit.
    const dates: string[] = [];
    const now = Date.now();
    for (let i = 1; i <= input.windowDays; i += 1) {
      const d = localDateString(new Date(now + i * 86_400_000), row.timezone as string);
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
    const live = await admin
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
