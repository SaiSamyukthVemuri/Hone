import "server-only";
import type {
  ConversionEvent,
  ConversionProviderAdapter,
  DeliveryRecord,
  MarketingConsent,
  ProviderConfig,
} from "@/lib/conversion/types";

// Generic, provider-agnostic conversion delivery service.
//
// Contract (all enforced + unit-tested here):
//   * Gates on per-studio provider config (enabled) AND marketing consent.
//   * Only ever iterates the CALLER-SUPPLIED configs: the caller passes ONE
//     studio's configs, so there is no cross-studio mixing at this layer.
//   * Dedupes by (eventId, provider) via a caller-supplied delivered-set
//     (backed by conversion_event_deliveries once the migration lands).
//   * NEVER throws: a provider failure must not break a booking.
//   * Emits only DeliveryRecord status (no email/phone/token/clinical data).
//
// It performs no network itself; adapters do. In this PR no real adapter's
// send() is implemented, and nothing calls this service from the booking flow,
// it is wired only in tests (with fake adapters) until the sender-wiring PR.

export type DeliverContext = {
  // This studio's provider configs ONLY (caller-scoped → per-studio isolation).
  configs: ProviderConfig[];
  consent: MarketingConsent;
  // Provider adapters available to attempt delivery (dependency-injected).
  adapters: Partial<Record<string, ConversionProviderAdapter>>;
  // (eventId:provider) keys already delivered: dedup / retry-safety.
  delivered?: Set<string>;
  // Safe status sink. MUST only receive DeliveryRecord (never raw PII).
  onRecord?: (record: DeliveryRecord) => void;
};

function deliveryKey(eventId: string, provider: string): string {
  return `${eventId}:${provider}`;
}

export async function deliverConversionEvent(
  event: ConversionEvent,
  ctx: DeliverContext,
): Promise<DeliveryRecord[]> {
  const out: DeliveryRecord[] = [];

  for (const config of ctx.configs) {
    const record: DeliveryRecord = {
      studioId: event.studioId,
      provider: config.provider,
      internalEventName: event.name,
      eventId: event.eventId,
      status: "skipped",
    };

    if (!config.enabled) {
      record.skippedReason = "provider_disabled";
    } else if (!ctx.consent.granted) {
      record.skippedReason = "marketing_consent_absent";
    } else if (ctx.delivered?.has(deliveryKey(event.eventId, config.provider))) {
      record.skippedReason = "already_delivered";
    } else {
      const adapter = ctx.adapters[config.provider];
      if (!adapter) {
        record.skippedReason = "adapter_not_available";
      } else {
        let payload = null as ReturnType<typeof adapter.buildPayload>;
        try {
          payload = adapter.buildPayload(event, config);
        } catch {
          payload = null;
        }
        if (!payload) {
          record.skippedReason = "no_payload_for_event";
        } else {
          try {
            const res = await adapter.send(payload, config);
            if (res.ok) {
              record.status = "sent";
              record.providerEventId = res.providerEventId ?? null;
              ctx.delivered?.add(deliveryKey(event.eventId, config.provider));
            } else {
              record.status = "failed";
              record.lastErrorSafe = res.errorSafe;
            }
          } catch {
            // A thrown adapter must NEVER propagate: the booking is already
            // committed and must not fail because ad tracking failed.
            record.status = "failed";
            record.lastErrorSafe = "adapter_threw";
          }
        }
      }
    }

    out.push(record);
    ctx.onRecord?.(record);
  }

  return out;
}
