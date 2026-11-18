import type { Studio, StudioAvailabilityDefault } from "@/lib/types/database";
import { computeBookingReadiness, isPubliclyBookable } from "@/lib/booking/readiness";
import { isOpenDay, type NewClientReadiness } from "@/lib/booking/new-client-readiness";
import { onboardingBookingReadiness } from "./booking-readiness";
import type { OnboardingSignals } from "./steps";

// PURE. The one place the wizard's booking-side signals are computed, so the page and the tests call the SAME function and a
// change to the open-day filter or to the readiness call cannot slip past a test that mirrored it.
//
// Inputs are what signals.ts has already read. `readiness` is the canonical new-client readiness verdict, or `null` when that
// read threw: null becomes `unknown`, never ready. The open-day predicate is the canonical `isOpenDay`, the same one the
// canonical readiness applies, so the wizard's "an open day exists" and the authority's cannot disagree.

export type BookingSignalStudio = Pick<
  Studio,
  | "name"
  | "slug"
  | "address"
  | "timezone"
  | "default_appointment_duration_minutes"
  | "buffer_minutes"
  | "public_booking_horizon_months"
>;

export type BookingSignals = Pick<
  OnboardingSignals,
  "hasSlug" | "hasService" | "hasAvailability" | "isPubliclyBookable" | "bookingReadiness" | "publicBookingUrl"
>;

export function deriveBookingSignals(input: {
  studio: BookingSignalStudio;
  activeServicesCount: number;
  availabilityDefaults: Pick<StudioAvailabilityDefault, "is_open" | "open_time" | "close_time">[];
  readiness: NewClientReadiness | null;
  appOrigin: string;
}): BookingSignals {
  const { studio, activeServicesCount, availabilityDefaults, readiness, appOrigin } = input;
  const openAvailabilityDaysCount = availabilityDefaults.filter((d) => isOpenDay(d)).length;

  const hasSlug = typeof studio.slug === "string" && studio.slug.trim().length > 0;
  return {
    hasSlug,
    hasService: activeServicesCount >= 1,
    hasAvailability: openAvailabilityDaysCount >= 1,
    isPubliclyBookable: hasSlug && isPubliclyBookable({ activeServicesCount, openAvailabilityDaysCount }),
    bookingReadiness: readiness ? onboardingBookingReadiness(readiness) : { state: "unknown" },
    publicBookingUrl: computeBookingReadiness({ studio, activeServicesCount, openAvailabilityDaysCount, appOrigin })
      .publicBookingUrl,
  };
}
