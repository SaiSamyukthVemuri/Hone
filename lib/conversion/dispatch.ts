import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { metaAdapter } from "@/lib/conversion/adapters/meta";
import { bookingEventId } from "@/lib/conversion/meta-capi";
import {
  decryptTrackingProviderToken,
  type DecryptResult,
} from "@/lib/conversion/token-crypto";
import type {
  ConversionEvent,
  ConversionProviderAdapter,
  ProviderConfig,
  TrackingProvider,
} from "@/lib/conversion/types";

// DB-backed, provider-agnostic conversion dispatcher for a CONFIRMED booking.
//
// Gates (ALL must hold before any data leaves; otherwise skip safely):
//   1. marketing consent granted for this booking
//   2. a studio_tracking_providers row exists AND enabled = true
//   3. claim_conversion_delivery wins the atomic (studio, provider, event_id)
//      dedup claim
//   4. THIS studio's own token decrypts (AES-256-GCM from encrypted_server_token,
//      passed to the adapter via ctx) — no global shared token, no env ref
//
// Reliability: NEVER throws (the booking is already committed). Provider
// failures record a `failed` delivery row + a WARNING ops alert (not critical),
// with redacted, PII-free/token-free details. No clinical data, no raw
// email/phone, no service name — only a hashed identity + generic category.
//
// Production stays INERT after merge: no studio_tracking_providers rows exist,
// so gate 2 short-circuits every time; and no per-studio secret env is set.

export type BookingConversionParams = {
  studioId: string;
  appointmentId: string;
  eventTimeUnixSeconds: number;
  consentGranted: boolean;
  email?: string | null;
  phone?: string | null;
  serviceModality?: string | null;
  eventSourceUrl?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
};

type Deps = {
  admin?: ReturnType<typeof createAdminClient>;
  adapters?: Partial<Record<TrackingProvider, ConversionProviderAdapter>>;
  decrypt?: (encrypted: string | null | undefined) => DecryptResult;
};

const INTERNAL_EVENT = "booking_confirmed";

export async function dispatchBookingConversion(
  params: BookingConversionParams,
  deps: Deps = {},
): Promise<void> {
  try {
    // Gate 1: consent.
    if (!params.consentGranted) return;

    const admin = deps.admin ?? createAdminClient();
    const adapters = deps.adapters ?? { meta: metaAdapter };
    const decrypt = deps.decrypt ?? decryptTrackingProviderToken;

    // Gate 2: this studio's ENABLED providers only (no cross-studio; inert when
    // none exist).
    const { data: rows } = await admin
      .from("studio_tracking_providers")
      .select(
        "provider, enabled, browser_tag_id, encrypted_server_token, conversion_action_id, test_event_code, consent_mode",
      )
      .eq("studio_id", params.studioId)
      .eq("enabled", true);
    if (!rows || rows.length === 0) return;

    const eventId = bookingEventId(params.appointmentId);
    const event: ConversionEvent = {
      name: "booking_confirmed",
      studioId: params.studioId,
      eventId,
      eventTimeUnixSeconds: params.eventTimeUnixSeconds,
      email: params.email ?? null,
      phone: params.phone ?? null,
      clientIp: params.clientIp ?? null,
      userAgent: params.userAgent ?? null,
      // Raw modality in; the adapter's safeServiceCategory genericizes it so a
      // free-text service name can never leak.
      serviceCategory: params.serviceModality ?? null,
      eventSourceUrl: params.eventSourceUrl ?? null,
    };

    for (const row of rows) {
      const config: ProviderConfig = {
        provider: row.provider as TrackingProvider,
        enabled: row.enabled as boolean,
        browserTagId: (row.browser_tag_id as string | null) ?? null,
        conversionActionId: (row.conversion_action_id as string | null) ?? null,
        testEventCode: (row.test_event_code as string | null) ?? null,
        consentMode: (row.consent_mode as string | null) ?? null,
      };
      const adapter = adapters[config.provider];
      if (!adapter) continue;

      // Gate 3 (dedup): atomic claim. Only the winner proceeds; a loser means
      // the event was already claimed/sent for this (studio, provider) → skip.
      const { data: won } = await admin.rpc("claim_conversion_delivery", {
        p_studio_id: params.studioId,
        p_provider: config.provider,
        p_internal_event_name: INTERNAL_EVENT,
        p_event_id: eventId,
      });
      if (won !== true) continue;

      // Gate 4: decrypt THIS studio's own token (AES-256-GCM). If it can't be
      // decrypted (no key, absent, tampered), skip safely — never send.
      const decrypted = decrypt(
        (row.encrypted_server_token as string | null) ?? null,
      );
      if (!decrypted.ok) {
        await finishDelivery(admin, params.studioId, config.provider, eventId, {
          status: "skipped",
          skipped_reason: `token_${decrypted.reason}`,
        });
        continue;
      }

      const payload = adapter.buildPayload(event, config);
      if (!payload) {
        await finishDelivery(admin, params.studioId, config.provider, eventId, {
          status: "skipped",
          skipped_reason: "no_payload",
        });
        continue;
      }

      const res = await adapter.send(payload, config, { token: decrypted.token });
      if (res.ok) {
        await finishDelivery(admin, params.studioId, config.provider, eventId, {
          status: "sent",
          provider_event_id_redacted: res.providerEventId ?? null,
        });
      } else {
        await finishDelivery(admin, params.studioId, config.provider, eventId, {
          status: "failed",
          last_error_safe: res.errorSafe,
        });
        // WARNING (not critical) — normal provider failures shouldn't page.
        await recordOpsAlert({
          severity: "warning",
          event: "conversion_delivery_failed",
          message: `Conversion delivery to ${config.provider} failed (${res.errorSafe}).`,
          studioId: params.studioId,
          route: "book/[slug]",
          safeDetails: { provider: config.provider, error_safe: res.errorSafe },
        });
      }
    }
  } catch {
    // A confirmed booking must never fail because tracking failed.
  }
}

// Updates the claimed delivery row to a terminal status. Best-effort; a failure
// here is swallowed (never affects a booking).
async function finishDelivery(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
  provider: string,
  eventId: string,
  patch: {
    status: "sent" | "failed" | "skipped";
    skipped_reason?: string | null;
    last_error_safe?: string | null;
    provider_event_id_redacted?: string | null;
  },
): Promise<void> {
  try {
    await admin
      .from("conversion_event_deliveries")
      .update({ ...patch, attempted_at: new Date().toISOString() })
      .eq("studio_id", studioId)
      .eq("provider", provider)
      .eq("event_id", eventId);
  } catch {
    // swallow
  }
}
