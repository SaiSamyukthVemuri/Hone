// Provider-agnostic conversion-tracking types. Platform-neutral: Meta is the
// first adapter, but nothing here is Meta-specific. PURE type/const module — no
// server-only, no I/O. See docs/22 for the full plan.
//
// This layer is NOT wired into the booking flow and sends nothing (adapters'
// send() is not implemented in this PR). It exists so the routing, gating,
// dedup, and data-minimization contracts are typed + unit-tested ahead of the
// approval-gated migration + sender-wiring PRs.

export const TRACKING_PROVIDERS = [
  "meta",
  "google_ads",
  "ga4",
  "tiktok",
  "pinterest",
  "linkedin",
  "microsoft_ads",
  "custom",
] as const;
export type TrackingProvider = (typeof TRACKING_PROVIDERS)[number];

// Canonical internal events (provider-neutral). Adapters map these to their own
// event names (e.g. booking_confirmed → Meta "Schedule").
export const CONVERSION_EVENT_NAMES = [
  "lead_submitted",
  "booking_started",
  "booking_confirmed",
  "appointment_completed",
  "client_converted",
  "referral_created",
] as const;
export type ConversionEventName = (typeof CONVERSION_EVENT_NAMES)[number];

// A provider-agnostic conversion event. By CONSTRUCTION this type has NO field
// for clinical/sensitive data — no name, notes, intake, contraindications,
// body areas, photos, cancellation reasons, or free-text service names. Raw
// email/phone are carried in-process ONLY to be hashed by an adapter; they must
// never be logged.
export type ConversionEvent = {
  name: ConversionEventName;
  studioId: string;
  // Deterministic, stable id (e.g. `hone_booking_{appointmentId}`) so browser +
  // server events dedupe and retries reuse the same id.
  eventId: string;
  eventTimeUnixSeconds: number;
  eventSourceUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  // Generic category only ("consultation" | "electrolysis" | "laser" | ...);
  // adapters re-sanitize so a free-text service name can never leak.
  serviceCategory?: string | null;
};

// Per-studio provider configuration for the ADAPTER. It never carries the token
// itself: the studio's token is stored AES-256-GCM-encrypted in the DB, the
// dispatcher decrypts it server-side, and the plaintext is passed to send() via
// SendContext only. Nothing here is a secret beyond browserTagId (a public id).
export type ProviderConfig = {
  provider: TrackingProvider;
  enabled: boolean;
  browserTagId?: string | null; // e.g. Meta Pixel id / GA4 measurement id
  conversionActionId?: string | null; // e.g. Google Ads conversion action
  testEventCode?: string | null;
  consentMode?: string | null;
};

export type ProviderPayload = {
  provider: TrackingProvider;
  eventId: string;
  body: unknown; // the provider-shaped request body (already minimized + hashed)
};

export type SendResult =
  | { ok: true; providerEventId?: string | null }
  | { ok: false; retryable: boolean; errorSafe: string };

// Server-side send context. The dispatcher decrypts the studio's own token from
// the DB (AES-256-GCM) and passes the plaintext here — the token never lives on
// the config, in env, or in the client bundle, and is never logged.
export type SendContext = { token: string; timeoutMs?: number };

// The adapter contract every provider implements.
export type ConversionProviderAdapter = {
  provider: TrackingProvider;
  // Pure: build the provider payload from a generic event. Returns null when
  // this provider does not map the event (e.g. no mapping yet).
  buildPayload(
    event: ConversionEvent,
    config: ProviderConfig,
  ): ProviderPayload | null;
  // Deliver a built payload using the studio's own token supplied via
  // ctx.token (decrypted server-side by the dispatcher). Without a token it
  // skips safely (never throws, never logs the token or raw response).
  send(
    payload: ProviderPayload,
    config: ProviderConfig,
    ctx?: SendContext,
  ): Promise<SendResult>;
};

export type DeliveryStatus = "skipped" | "sent" | "failed";

// The ONLY thing safe to log/persist. Contains no email/phone/token/clinical
// data — mirrors the proposed conversion_event_deliveries row.
export type DeliveryRecord = {
  studioId: string;
  provider: TrackingProvider;
  internalEventName: ConversionEventName;
  eventId: string;
  status: DeliveryStatus;
  skippedReason?: string | null;
  providerEventId?: string | null;
  lastErrorSafe?: string | null;
};

export type MarketingConsent = {
  granted: boolean;
  policyVersion?: string | null;
};
