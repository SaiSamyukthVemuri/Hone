import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { metaAdapter } from "@/lib/conversion/adapters/meta";
import { sha256Hex, normalizeEmailForMeta } from "@/lib/conversion/meta-capi";
import type { ConversionEvent, ProviderConfig } from "@/lib/conversion/types";

const config: ProviderConfig = { provider: "meta", enabled: true, browserTagId: "PX1" };

function event(over: Partial<ConversionEvent> = {}): ConversionEvent {
  return {
    name: "booking_confirmed",
    studioId: "s1",
    eventId: "hone_booking_appt_9",
    eventTimeUnixSeconds: 1_780_000_000,
    email: "Jane.Doe@Gmail.com",
    phone: "(416) 555-1234",
    serviceCategory: "electrolysis",
    eventSourceUrl: "https://hone.care/book/willow-electrolysis",
    ...over,
  };
}

describe("meta adapter — buildPayload", () => {
  it("maps booking_confirmed → Meta Schedule with the deterministic event_id", () => {
    const p = metaAdapter.buildPayload(event(), config)!;
    expect(p).not.toBeNull();
    const ev = (p.body as { data: Array<Record<string, unknown>> }).data[0];
    expect(ev.event_name).toBe("Schedule");
    expect(ev.event_id).toBe("hone_booking_appt_9");
    expect(ev.action_source).toBe("website");
    expect(p.eventId).toBe("hone_booking_appt_9");
  });

  it("hashes email + phone (never raw in the payload)", () => {
    const p = metaAdapter.buildPayload(event(), config)!;
    const ev = (p.body as { data: Array<{ user_data: { em?: string[]; ph?: string[] } }> }).data[0];
    expect(ev.user_data.em).toEqual([sha256Hex(normalizeEmailForMeta("Jane.Doe@Gmail.com")!)]);
    expect(ev.user_data.ph).toEqual([sha256Hex("14165551234")]);
    const json = JSON.stringify(p);
    expect(json).not.toContain("Jane.Doe@Gmail.com");
    expect(json).not.toContain("jane.doe@gmail.com");
    expect(json).not.toContain("4165551234");
  });

  it("sends only a GENERIC service_category — a free-text name collapses to 'other'", () => {
    const clean = metaAdapter.buildPayload(event({ serviceCategory: "electrolysis" }), config)!;
    expect((clean.body as { data: Array<{ custom_data: unknown }> }).data[0].custom_data).toEqual({
      service_category: "electrolysis",
    });
    const leaky = metaAdapter.buildPayload(event({ serviceCategory: "Brazilian Electrolysis" }), config)!;
    expect((leaky.body as { data: Array<{ custom_data: { service_category: string } }> }).data[0].custom_data).toEqual({
      service_category: "other",
    });
    expect(JSON.stringify(leaky)).not.toMatch(/brazilian/i);
  });

  it("returns null for events it does not map (only booking_confirmed today)", () => {
    for (const name of ["lead_submitted", "booking_started", "appointment_completed", "client_converted", "referral_created"] as const) {
      expect(metaAdapter.buildPayload(event({ name }), config)).toBeNull();
    }
  });

  it("returns null when disabled or missing pixel id", () => {
    expect(metaAdapter.buildPayload(event(), { provider: "meta", enabled: false, browserTagId: "PX" })).toBeNull();
    expect(metaAdapter.buildPayload(event(), { provider: "meta", enabled: true, browserTagId: null })).toBeNull();
  });

  it("carries NO clinical/PII field names in the payload", () => {
    const json = JSON.stringify(metaAdapter.buildPayload(event(), config));
    for (const forbidden of ["notes", "intake", "contraindication", "allergie", "fitzpatrick", "cancellation", "client_name", "full_name", "body_area"]) {
      expect(json.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("meta adapter — send() is NOT wired (no data leaves)", () => {
  it("returns a not-wired skip and performs no network", async () => {
    const p = metaAdapter.buildPayload(event(), config)!;
    const res = await metaAdapter.send(p, config);
    expect(res).toEqual({ ok: false, retryable: true, errorSafe: "sender_not_wired" });
  });
  it("adapter source is server-only and has no live Graph API fetch", () => {
    const SRC = readFileSync(path.resolve(__dirname, "../../../lib/conversion/adapters/meta.ts"), "utf8");
    expect(SRC).toContain('import "server-only"');
    expect(SRC).not.toContain("fetch(");
    expect(SRC).not.toContain("graph.facebook");
    expect(SRC).not.toContain("process.env");
  });
});
