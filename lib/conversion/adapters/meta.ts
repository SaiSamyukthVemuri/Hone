import "server-only";
import {
  normalizeEmailForMeta,
  normalizePhoneForMeta,
  safeServiceCategory,
  sha256Hex,
  buildCapiRequestBody,
  type MetaScheduleEvent,
} from "@/lib/conversion/meta-capi";
import type {
  ConversionEvent,
  ConversionProviderAdapter,
  ProviderConfig,
  ProviderPayload,
  SendResult,
} from "@/lib/conversion/types";

// Meta Conversions API adapter — the first provider adapter. buildPayload is
// pure and reuses the inert, tested primitives from lib/conversion/meta-capi.ts
// (PR #345). send() is intentionally NOT wired (returns a not-wired skip); the
// real POST to the Graph API lands in the approved sender-wiring PR.
//
// Mapping (only booking_confirmed is mapped today):
//   booking_confirmed → Meta "Schedule"

export const metaAdapter: ConversionProviderAdapter = {
  provider: "meta",

  buildPayload(
    event: ConversionEvent,
    config: ProviderConfig,
  ): ProviderPayload | null {
    // Only the confirmed booking maps to a Meta conversion for now.
    if (event.name !== "booking_confirmed") return null;
    if (!config.enabled || !config.browserTagId) return null;

    // Hashed contact identifiers only (Meta spec). Raw values never leave here.
    const user_data: MetaScheduleEvent["user_data"] = {};
    const em = normalizeEmailForMeta(event.email);
    if (em) user_data.em = [sha256Hex(em)];
    const ph = normalizePhoneForMeta(event.phone);
    if (ph) user_data.ph = [sha256Hex(ph)];
    if (event.clientIp) user_data.client_ip_address = event.clientIp;
    if (event.userAgent) user_data.client_user_agent = event.userAgent;

    const metaEvent: MetaScheduleEvent = {
      event_name: "Schedule",
      event_time: event.eventTimeUnixSeconds,
      event_id: event.eventId,
      action_source: "website",
      user_data,
    };
    if (event.eventSourceUrl) metaEvent.event_source_url = event.eventSourceUrl;
    if (event.serviceCategory != null) {
      // Generic category ONLY — a free-text service name collapses to "other".
      metaEvent.custom_data = {
        service_category: safeServiceCategory(event.serviceCategory),
      };
    }

    return {
      provider: "meta",
      eventId: event.eventId,
      body: buildCapiRequestBody([metaEvent], config.testEventCode),
    };
  },

  // NOT WIRED in this PR. The real delivery (an HTTP POST to the Meta Graph
  // API events endpoint for the studio's pixel, with a server-only token +
  // timeout) is added only after approval. Returning a not-wired skip means
  // that even if this were called, no data is sent.
  async send(
    _payload: ProviderPayload,
    _config: ProviderConfig,
  ): Promise<SendResult> {
    return { ok: false, retryable: true, errorSafe: "sender_not_wired" };
  },
};
