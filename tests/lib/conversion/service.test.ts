import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deliverConversionEvent } from "@/lib/conversion/service";
import type {
  ConversionEvent,
  ConversionProviderAdapter,
  ProviderConfig,
} from "@/lib/conversion/types";

// A fake adapter so the SERVICE routing/gating/dedup can be proven without any
// real provider, network, or the (not-wired) Meta adapter.
function fakeAdapter(
  over: Partial<ConversionProviderAdapter> = {},
): ConversionProviderAdapter & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    provider: "meta",
    sent,
    buildPayload: (e) => ({ provider: "meta", eventId: e.eventId, body: {} }),
    send: async (p) => {
      sent.push(p);
      return { ok: true, providerEventId: "prov_1" };
    },
    ...over,
  } as ConversionProviderAdapter & { sent: unknown[] };
}

function event(over: Partial<ConversionEvent> = {}): ConversionEvent {
  return {
    name: "booking_confirmed",
    studioId: "studio_A",
    eventId: "hone_booking_appt_1",
    eventTimeUnixSeconds: 1_780_000_000,
    email: "jane@example.com",
    phone: "4165551234",
    ...over,
  };
}

const enabledMeta: ProviderConfig = { provider: "meta", enabled: true, browserTagId: "PX" };

describe("deliverConversionEvent — gating", () => {
  it("disabled provider sends nothing (skipped: provider_disabled)", async () => {
    const a = fakeAdapter();
    const recs = await deliverConversionEvent(event(), {
      configs: [{ provider: "meta", enabled: false }],
      consent: { granted: true },
      adapters: { meta: a },
    });
    expect(a.sent).toHaveLength(0);
    expect(recs[0]).toMatchObject({ status: "skipped", skippedReason: "provider_disabled" });
  });

  it("missing marketing consent sends nothing (skipped: marketing_consent_absent)", async () => {
    const a = fakeAdapter();
    const recs = await deliverConversionEvent(event(), {
      configs: [enabledMeta],
      consent: { granted: false },
      adapters: { meta: a },
    });
    expect(a.sent).toHaveLength(0);
    expect(recs[0].skippedReason).toBe("marketing_consent_absent");
  });

  it("enabled provider + consent sends exactly one event", async () => {
    const a = fakeAdapter();
    const recs = await deliverConversionEvent(event(), {
      configs: [enabledMeta],
      consent: { granted: true },
      adapters: { meta: a },
    });
    expect(a.sent).toHaveLength(1);
    expect(recs[0]).toMatchObject({ status: "sent", providerEventId: "prov_1" });
  });
});

describe("deliverConversionEvent — reliability + dedup", () => {
  it("does NOT throw / fail booking when a provider send fails", async () => {
    const throwing = fakeAdapter({
      send: async () => {
        throw new Error("provider 500");
      },
    });
    const recs = await deliverConversionEvent(event(), {
      configs: [enabledMeta],
      consent: { granted: true },
      adapters: { meta: throwing },
    });
    expect(recs[0]).toMatchObject({ status: "failed", lastErrorSafe: "adapter_threw" });
    // the safe error carries no exception message / PII
    expect(JSON.stringify(recs)).not.toContain("provider 500");
  });

  it("deterministic event_id prevents duplicate delivery", async () => {
    const a = fakeAdapter();
    const delivered = new Set<string>();
    const ctx = { configs: [enabledMeta], consent: { granted: true }, adapters: { meta: a }, delivered };
    await deliverConversionEvent(event(), ctx); // sends, records key
    const second = await deliverConversionEvent(event(), ctx); // same event_id → skip
    expect(a.sent).toHaveLength(1);
    expect(second[0]).toMatchObject({ status: "skipped", skippedReason: "already_delivered" });
  });
});

describe("deliverConversionEvent — isolation + redaction", () => {
  it("only processes the caller-supplied (single-studio) configs; records carry that studioId", async () => {
    const a = fakeAdapter();
    const recs = await deliverConversionEvent(event({ studioId: "studio_A" }), {
      configs: [enabledMeta], // studio A's configs only
      consent: { granted: true },
      adapters: { meta: a },
    });
    expect(recs.every((r) => r.studioId === "studio_A")).toBe(true);
  });

  it("emits status records with NO raw email/phone/token/clinical data", async () => {
    const records: unknown[] = [];
    await deliverConversionEvent(event({ email: "jane@example.com", phone: "4165551234" }), {
      configs: [enabledMeta],
      consent: { granted: true },
      adapters: { meta: fakeAdapter() },
      onRecord: (r) => records.push(r),
    });
    const json = JSON.stringify(records);
    expect(json).not.toContain("jane@example.com");
    expect(json).not.toContain("4165551234");
    expect(json).not.toMatch(/token|notes|intake|contraindication/i);
  });

  it("skips a provider with no registered adapter (no throw)", async () => {
    const recs = await deliverConversionEvent(event(), {
      configs: [{ provider: "google_ads", enabled: true, browserTagId: "G" }],
      consent: { granted: true },
      adapters: {}, // none registered
    });
    expect(recs[0]).toMatchObject({ status: "skipped", skippedReason: "adapter_not_available" });
  });
});

describe("service is server-only + does no network itself", () => {
  const SRC = readFileSync(path.resolve(__dirname, "../../../lib/conversion/service.ts"), "utf8");
  it("declares server-only and never calls fetch", () => {
    expect(SRC).toContain('import "server-only"');
    expect(SRC).not.toContain("fetch(");
    expect(SRC).not.toContain("process.env");
  });
});
