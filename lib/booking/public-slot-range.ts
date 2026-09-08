import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStudioBySlug } from "@/lib/booking/queries";
import { filterFutureSlots, getAvailableSlots, type Slot } from "@/lib/booking/slots";
import { isPubliclyBookable } from "@/lib/booking/readiness";
import { horizonRangeInStudioTz } from "@/lib/booking/horizon";

// ===========================================================================
// PUBLIC SLOTS FOR A RANGE OF DATES — resolved once, throttled by the caller
// ===========================================================================
//
// WHY THIS EXISTS SEPARATELY FROM `fetchPublicSlotsAction`.
//
// That action answers for ONE date and rate-limits itself on every call, which
// is exactly right for the public booking page: a person picks a day, one
// request goes out. It is exactly wrong for a caller that must cover a whole
// authorized window, because the limiter counts per (IP, slug) per minute — so
// a window wider than the allowance exhausts its own quota, the remaining days
// come back refused, and the caller cannot tell "refused by the throttle" from
// "nothing is open". Availability then vanishes silently, which is the failure
// this module exists to end.
//
// The fix is not a bigger allowance. It is asking the question once: the caller
// throttles the OPERATION, and this helper resolves the studio, its readiness
// and the service duration a single time before walking the days.
//
// IT DOES NOT RATE LIMIT. That is deliberate and is the whole point — a caller
// that skips its own gate would turn this into an unthrottled public fan-out,
// so every caller must hold `limitPublicSlots` (or an equivalent) around it.
// The one caller today is the invitation surface, which gates before calling.
//
// THE HORIZON IS THE AUTHORITY ON HOW FAR "FORWARD" GOES. A caller may ask for
// any dates; anything outside the studio's own public booking horizon is
// dropped here rather than queried, because `fetchPublicSlotsAction` would
// refuse it anyway and a caller that trusted its own range would spend reads
// discovering that one date at a time.

export type PublicSlotRangeResult =
  | {
      ok: true;
      slots: Slot[];
      /** The dates actually queried, after the horizon clamp. */
      scanned: string[];
      /** Dates the caller asked for that the horizon excluded. */
      skippedOutsideHorizon: string[];
    }
  | { ok: false; error: string };

/**
 * Slots for a set of dates, in one resolved pass.
 *
 * `dates` is taken as given apart from the horizon clamp — the caller owns
 * which days are worth asking about (a weekday-scoped offer, for instance,
 * should not be handing over days it does not permit).
 */
export async function fetchPublicSlotsForDates(params: {
  slug: string;
  serviceId: string;
  dates: readonly string[];
  /** How many days may be queried at once. Bounds the fan-out on the database
   *  without serialising the whole walk. */
  batchSize?: number;
}): Promise<PublicSlotRangeResult> {
  const studio = await getStudioBySlug(params.slug);
  if (!studio) return { ok: false, error: "Studio not found." };

  const admin = createAdminClient();

  // Same soft-gate the single-date action applies, asked ONCE rather than per
  // day: a studio that is not publicly bookable is not bookable on any date.
  const [{ count: activeServicesCount }, { data: availabilityRows }] =
    await Promise.all([
      admin
        .from("services")
        .select("id", { count: "exact", head: true })
        .eq("studio_id", studio.id)
        .eq("active", true),
      admin
        .from("studio_availability_default")
        .select("is_open,open_time,close_time")
        .eq("studio_id", studio.id),
    ]);
  // The same "open day" definition the public booking action uses: a day counts
  // only when it is open AND carries both bounds.
  const openAvailabilityDaysCount = (
    (availabilityRows ?? []) as Array<{
      is_open: boolean | null;
      open_time: string | null;
      close_time: string | null;
    }>
  ).filter(
    (d) =>
      d.is_open === true &&
      typeof d.open_time === "string" &&
      typeof d.close_time === "string",
  ).length;
  if (
    !isPubliclyBookable({
      activeServicesCount: activeServicesCount ?? 0,
      openAvailabilityDaysCount,
    })
  ) {
    return { ok: false, error: "This studio is not accepting bookings online." };
  }

  const { data: service } = await admin
    .from("services")
    .select("default_duration_minutes")
    .eq("id", params.serviceId)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (!service) return { ok: false, error: "Service not found." };

  // THE HORIZON CLAMP. Dates beyond it are dropped rather than queried; the
  // single-date action refuses them anyway, and discovering that one read at a
  // time is how an over-wide range spends its whole budget on nothing.
  const horizon = horizonRangeInStudioTz(
    studio.timezone,
    studio.public_booking_horizon_months,
  );
  const scanned: string[] = [];
  const skippedOutsideHorizon: string[] = [];
  for (const d of params.dates) {
    if (d < horizon.minDateStr || d > horizon.maxDateStr) skippedOutsideHorizon.push(d);
    else scanned.push(d);
  }

  const batchSize = Math.max(1, params.batchSize ?? 7);
  const collected: Slot[] = [];
  for (let i = 0; i < scanned.length; i += batchSize) {
    const batch = await Promise.all(
      scanned.slice(i, i + batchSize).map((date) =>
        getAvailableSlots(
          admin,
          {
            id: studio.id,
            timezone: studio.timezone,
            default_appointment_duration_minutes:
              studio.default_appointment_duration_minutes,
            buffer_minutes: studio.buffer_minutes,
          },
          date,
          service.default_duration_minutes as number,
        ),
      ),
    );
    // The SAME past-time guard the single-date action applies, so the two
    // cannot drift about whether today's earlier hours are offerable.
    for (const slots of batch) collected.push(...filterFutureSlots(slots));
  }

  return { ok: true, slots: collected, scanned, skippedOutsideHorizon };
}
