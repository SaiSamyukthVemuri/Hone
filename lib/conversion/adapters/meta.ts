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
  SendContext,
  SendResult,
} from "@/lib/conversion/types";

const META_GRAPH_VERSION = "v21.0";
const DEFAULT_TIMEOUT_MS = 12_000;

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

  // Real delivery: POST the (already minimized + hashed) payload to the Meta
  // Graph API events endpoint for the studio's pixel. The access token is
  // passed in the request BODY (never the URL, so it can't leak into request
  // logs) and comes from ctx (server-resolved). Timed out, and every failure
  // returns a REDACTED, PII-free/token-free errorSafe — the raw provider
  // response is never surfaced.
  async send(
    payload: ProviderPayload,
    config: ProviderConfig,
    ctx?: SendContext,
  ): Promise<SendResult> {
    // Token is the studio's OWN token, decrypted server-side by the dispatcher
    // and passed via ctx — never a global env token, never on the config.
    const token = ctx?.token;
    if (!token) return { ok: false, retryable: false, errorSafe: "missing_token" };
    const pixelId = config.browserTagId;
    if (!pixelId) return { ok: false, retryable: false, errorSafe: "missing_pixel_id" };

    // URL carries NO secret. Token goes in the JSON body.
    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(pixelId)}/events`;
    const body = { ...(payload.body as Record<string, unknown>), access_token: token };

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      ctx?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) {
        // Do NOT echo the raw provider response (may contain ids). Success only.
        return { ok: true, providerEventId: null };
      }
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, retryable, errorSafe: `meta_http_${res.status}` };
    } catch {
      // Timeout / network — never include the raw error object.
      return { ok: false, retryable: true, errorSafe: "meta_network_or_timeout" };
    } finally {
      clearTimeout(timer);
    }
  },
};
