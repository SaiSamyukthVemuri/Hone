// Pure, client-safe helpers for OPTIONAL public-booking marketing/analytics
// consent capture. No server-only, no DB, no provider anything. The form uses
// the field name; the booking action uses parse + build to insert one
// booking_tracking_consents row (migration 0106). This consent is separate from
// clinical / payment / card consent, and declining it never blocks a booking.
//
// The row stores ONLY consent bookkeeping, no email/phone, no clinical data,
// no provider tokens.

export const MARKETING_CONSENT_FIELD = "marketing_analytics_consent";
export const MARKETING_CONSENT_TEXT_VERSION = "marketing_analytics_v1";

// Checkbox → boolean. Absent/unchecked (null) is false; only an explicit
// "true"/"on" is consent. Default is therefore always false (opt-in).
export function parseMarketingConsent(
  value: FormDataEntryValue | null | undefined,
): boolean {
  return value === "true" || value === "on";
}

export type BookingMarketingConsentRow = {
  studio_id: string;
  appointment_id: string;
  client_id: string | null;
  marketing_analytics_consent: boolean;
  consent_text_version: string;
  consent_source: "public_booking";
};

export function buildBookingMarketingConsentRow(input: {
  studioId: string;
  appointmentId: string;
  clientId?: string | null;
  consent: boolean;
}): BookingMarketingConsentRow {
  return {
    studio_id: input.studioId,
    appointment_id: input.appointmentId,
    client_id: input.clientId ?? null,
    marketing_analytics_consent: input.consent,
    consent_text_version: MARKETING_CONSENT_TEXT_VERSION,
    consent_source: "public_booking",
  };
}
