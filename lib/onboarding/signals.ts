import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  getActiveServices,
  getAvailabilityDefaults,
} from "@/lib/booking/queries";
import {
  computeBookingReadiness,
  isPubliclyBookable,
} from "@/lib/booking/readiness";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { deriveConnectCapability } from "@/lib/payments/payment-status-presenter";
import type { Studio } from "@/lib/types/database";
import type { OnboardingSignals } from "./steps";

// Derived onboarding signals from REAL data. Reuses the exact same sources the
// dashboard + public booking already trust:
//   * getActiveServices           -> service step
//   * getAvailabilityDefaults     -> availability step (open-day filter matches
//                                    app/(app)/dashboard/page.tsx exactly)
//   * computeBookingReadiness /
//     isPubliclyBookable          -> honest "booking page is live" + public URL
//   * get_studio_payment_settings_display + deriveConnectCapability
//                                 -> REAL Stripe-ready (not the hard-coded
//                                    done:true getting-started faked)
//
// Owner-only: the payments RPC is is_studio_owner-gated inside; call this only
// for the studio owner (the wizard + progress card are owner surfaces).

type SignalStudio = Pick<
  Studio,
  | "id"
  | "name"
  | "slug"
  | "address"
  | "timezone"
  | "default_appointment_duration_minutes"
  | "buffer_minutes"
  | "public_booking_horizon_months"
>;

export async function getOnboardingSignals(
  studio: SignalStudio,
): Promise<OnboardingSignals> {
  const supabase = await createClient();

  const [services, availabilityDefaults, payment] = await Promise.all([
    getActiveServices(studio.id),
    getAvailabilityDefaults(studio.id),
    supabase.rpc("get_studio_payment_settings_display", {
      p_studio_id: studio.id,
      p_stripe_livemode: inferStripeLivemode(),
    }),
  ]);

  const activeServicesCount = services.length;
  const openAvailabilityDaysCount = availabilityDefaults.filter(
    (d) =>
      d.is_open === true &&
      typeof d.open_time === "string" &&
      typeof d.close_time === "string",
  ).length;

  const readiness = computeBookingReadiness({
    studio,
    activeServicesCount,
    openAvailabilityDaysCount,
    appOrigin: getRequiredAppOrigin(),
  });

  const hasSlug =
    typeof studio.slug === "string" && studio.slug.trim().length > 0;
  const bookable =
    hasSlug && isPubliclyBookable({ activeServicesCount, openAvailabilityDaysCount });

  // Real Stripe-ready state (never the faked done:true). Read error -> unknown
  // -> not ready (never a false all-clear); no row for this mode -> not_connected.
  const rows = payment.data as
    | Array<{
        account_status: string | null;
        charges_enabled: boolean | null;
        payouts_enabled: boolean | null;
      }>
    | null;
  const row = Array.isArray(rows) ? rows[0] : (rows ?? null);
  const capability = deriveConnectCapability(
    row
      ? {
          accountStatus: row.account_status ?? null,
          chargesEnabled: row.charges_enabled === true,
          payoutsEnabled: row.payouts_enabled === true,
        }
      : payment.error
        ? undefined
        : null,
  );

  return {
    studioName: studio.name,
    hasSlug,
    hasService: activeServicesCount >= 1,
    hasAvailability: openAvailabilityDaysCount >= 1,
    isPubliclyBookable: bookable,
    paymentsReady: capability === "ready",
    publicBookingUrl: readiness.publicBookingUrl,
  };
}
