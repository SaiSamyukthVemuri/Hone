// Self-serve booking-publish readiness.
//
// Pure compute. Callers load the two counts via the existing queries
// (getActiveServices / getAvailabilityDefaults) and pass them in. Keeping
// this pure means the dashboard checklist and the public booking soft-gate
// share one source of truth without double-querying.
//
// No publish/active flag is stored in the database; readiness is derived
// from data that already exists (slug + active services + open availability
// days + booking-settings defaults).

import type { Studio } from "@/lib/types/database";

export type ReadinessItemKey =
  | "studio_profile"
  | "booking_link"
  | "visible_service"
  | "availability"
  | "booking_settings"
  | "public_location";

export type ReadinessItem = {
  key: ReadinessItemKey;
  label: string;
  ok: boolean;
  // `required: true` items contribute to the overall status. `required:
  // false` items are informational warnings (e.g. address) that surface
  // missing setup without blocking "ready".
  required: boolean;
  href: string;
};

export type BookingReadiness = {
  status: "not_ready" | "ready";
  items: ReadinessItem[];
  publicBookingUrl: string;
};

// Shared sanitized message for any incomplete-state surface that's visible
// to a public visitor: the page itself, plus fetchPublicSlotsAction /
// publicBookAppointmentAction. Same string everywhere so we never leak
// "why exactly" (no services vs no availability) to a client.
export const UNAVAILABLE_PUBLIC_BOOKING_MESSAGE =
  "Online booking is not available for this studio yet. Please contact the studio directly.";

type StudioReadinessShape = Pick<
  Studio,
  | "name"
  | "slug"
  | "address"
  | "timezone"
  | "default_appointment_duration_minutes"
  | "buffer_minutes"
  | "public_booking_horizon_months"
>;

export function computeBookingReadiness(opts: {
  studio: StudioReadinessShape;
  activeServicesCount: number;
  openAvailabilityDaysCount: number;
  appOrigin: string;
}): BookingReadiness {
  const {
    studio,
    activeServicesCount,
    openAvailabilityDaysCount,
    appOrigin,
  } = opts;

  const hasStudioName =
    typeof studio.name === "string" && studio.name.trim().length > 0;
  const hasSlug =
    typeof studio.slug === "string" && studio.slug.trim().length > 0;
  const hasService = activeServicesCount >= 1;
  const hasOpenDay = openAvailabilityDaysCount >= 1;
  const hasBookingSettings =
    typeof studio.timezone === "string" &&
    studio.timezone.length > 0 &&
    typeof studio.default_appointment_duration_minutes === "number" &&
    typeof studio.buffer_minutes === "number" &&
    typeof studio.public_booking_horizon_months === "number";
  const hasPublicLocation =
    typeof studio.address === "string" && studio.address.trim().length > 0;

  const items: ReadinessItem[] = [
    {
      key: "studio_profile",
      label: "Studio name set",
      ok: hasStudioName,
      required: true,
      href: "/settings/studio",
    },
    {
      key: "booking_link",
      label: "Booking link set",
      ok: hasSlug,
      required: true,
      href: "/settings/booking",
    },
    {
      key: "visible_service",
      label: "At least one visible service",
      ok: hasService,
      required: true,
      href: "/settings/services",
    },
    {
      key: "availability",
      label: "Weekly availability configured",
      ok: hasOpenDay,
      required: true,
      href: "/settings/availability",
    },
    {
      key: "booking_settings",
      label: "Booking settings",
      ok: hasBookingSettings,
      required: true,
      href: "/settings/booking",
    },
    {
      key: "public_location",
      label: "Public location reviewed",
      ok: hasPublicLocation,
      required: false,
      href: "/settings/booking",
    },
  ];

  const allRequiredOk = items.every((it) => !it.required || it.ok);
  const status: "ready" | "not_ready" = allRequiredOk ? "ready" : "not_ready";

  // Build the public URL only when there's a slug to address. Anything
  // else would render a broken /book/ link.
  const origin = appOrigin.replace(/\/$/, "");
  const publicBookingUrl = hasSlug ? `${origin}/book/${studio.slug}` : "";

  return { status, items, publicBookingUrl };
}

// Narrower gate for the public-facing surfaces. Slug presence is already
// enforced upstream (no slug -> getStudioBySlug returns null -> 404); the
// only checks the public booking page + actions need to perform are
// "is there a bookable service" + "is there at least one open day".
export function isPubliclyBookable(opts: {
  activeServicesCount: number;
  openAvailabilityDaysCount: number;
}): boolean {
  return opts.activeServicesCount >= 1 && opts.openAvailabilityDaysCount >= 1;
}
