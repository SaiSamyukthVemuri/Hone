import "server-only";
import { createHash } from "node:crypto";

// Meta Conversions API (CAPI) payload + hashing layer for the "Schedule"
// booking-conversion event. PURE and server-only: this module builds payloads
// and hashes identifiers — it performs NO network I/O, NO DB reads, and is not
// wired into the booking flow yet (that wiring + the per-studio config live
// behind a migration + owner/legal approval; see
// docs/22_META_CONVERSION_TRACKING_PLAN.md).
//
// DATA-MINIMIZATION CONTRACT (clinic-adjacent business — this is load-bearing):
// The builder ACCEPTS ONLY the whitelisted, non-clinical fields below. There is
// deliberately NO parameter for: client name, appointment/booking notes, intake
// answers, contraindications, allergies, skin notes, body areas, photos,
// cancellation reasons, or the free-text service NAME (which for electrolysis
// encodes intimate body areas, e.g. "Brazilian"). Service is reduced to a
// generic modality category via an allowlist. Email/phone are SHA-256 hashed
// (Meta spec) and never sent raw.

// ---------------------------------------------------------------------------
// Normalization + hashing (Meta requires SHA-256 of normalized, lowercased,
// trimmed values, UNSALTED — distinct from lib/portal/tokens' salted
// hashFingerprint, which is for internal logs only).
// ---------------------------------------------------------------------------

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Lowercase + trim; require an '@'. Returns null when unusable (→ omitted).
export function normalizeEmailForMeta(
  email: string | null | undefined,
): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e.length > 2 && e.includes("@") ? e : null;
}

// Digits only, with country code, no '+' / spaces / punctuation (Meta spec).
// Defaults a bare 10-digit number to North America (+1) — Willow is Ontario.
export function normalizePhoneForMeta(
  phone: string | null | undefined,
  defaultCountryCode = "1",
): string | null {
  const digits = (phone ?? "").replace(/[^\d]/g, "");
  if (!digits) return null;
  const withCc = digits.length === 10 ? `${defaultCountryCode}${digits}` : digits;
  return withCc.length >= 11 && withCc.length <= 15 ? withCc : null;
}

// Generic, non-revealing service category. NEVER pass a free-text service NAME
// here — anything outside the allowlist collapses to "other" so a name like
// "Brazilian Electrolysis" can never leak a body area to Meta.
const SAFE_MODALITIES = ["electrolysis", "laser", "consultation"] as const;
export function safeServiceCategory(
  modality: string | null | undefined,
): string {
  const m = (modality ?? "").trim().toLowerCase();
  return (SAFE_MODALITIES as readonly string[]).includes(m) ? m : "other";
}

// ---------------------------------------------------------------------------
// Event + request builders.
// ---------------------------------------------------------------------------

export type MetaTrackingConfig = {
  pixelId: string | null;
  enabled: boolean;
  testEventCode?: string | null;
};

// The ONLY inputs the builder accepts — no clinical/PII fields exist here.
export type BookingConversionInput = {
  appointmentId: string;
  eventTimeUnixSeconds: number;
  email?: string | null;
  phone?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  serviceModality?: string | null; // reduced to a generic category
  eventSourceUrl?: string | null;
};

export type MetaUserData = {
  em?: string[];
  ph?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
};

export type MetaScheduleEvent = {
  event_name: "Schedule";
  event_time: number;
  event_id: string;
  action_source: "website";
  event_source_url?: string;
  user_data: MetaUserData;
  custom_data?: { service_category: string };
};

export type BuildResult =
  | { ok: true; eventId: string; event: MetaScheduleEvent }
  | { ok: false; skippedReason: string };

// Deterministic, stable event_id so a browser Pixel "Schedule" and this
// server event deduplicate, and any retry reuses the same id.
export function bookingEventId(appointmentId: string): string {
  return `hone_booking_${appointmentId}`;
}

export function buildScheduleEvent(
  config: MetaTrackingConfig,
  booking: BookingConversionInput,
): BuildResult {
  if (!config.enabled) return { ok: false, skippedReason: "tracking_disabled" };
  if (!config.pixelId) return { ok: false, skippedReason: "missing_pixel_id" };
  if (!booking.appointmentId) {
    return { ok: false, skippedReason: "missing_appointment_id" };
  }

  const eventId = bookingEventId(booking.appointmentId);

  const user_data: MetaUserData = {};
  const em = normalizeEmailForMeta(booking.email);
  if (em) user_data.em = [sha256Hex(em)];
  const ph = normalizePhoneForMeta(booking.phone);
  if (ph) user_data.ph = [sha256Hex(ph)];
  // IP + UA are sent unhashed per Meta spec (they are not PII identifiers Meta
  // asks to hash). Only included when lawfully available from the request.
  if (booking.clientIp) user_data.client_ip_address = booking.clientIp;
  if (booking.userAgent) user_data.client_user_agent = booking.userAgent;

  const event: MetaScheduleEvent = {
    event_name: "Schedule",
    event_time: booking.eventTimeUnixSeconds,
    event_id: eventId,
    action_source: "website",
    user_data,
  };
  if (booking.eventSourceUrl) event.event_source_url = booking.eventSourceUrl;
  if (booking.serviceModality != null) {
    event.custom_data = {
      service_category: safeServiceCategory(booking.serviceModality),
    };
  }
  return { ok: true, eventId, event };
}

// Wraps events into the CAPI POST body. test_event_code is a TOP-LEVEL field
// (Meta routes matching events to the Test Events tab), never inside an event.
export function buildCapiRequestBody(
  events: MetaScheduleEvent[],
  testEventCode?: string | null,
): { data: MetaScheduleEvent[]; test_event_code?: string } {
  const body: { data: MetaScheduleEvent[]; test_event_code?: string } = {
    data: events,
  };
  if (testEventCode) body.test_event_code = testEventCode;
  return body;
}
