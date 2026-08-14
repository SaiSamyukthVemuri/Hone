import { describe, expect, it, vi } from "vitest";
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

describe("meta adapter: buildPayload", () => {
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

  it("sends only a GENERIC service_category, a free-text name collapses to 'other'", () => {
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

describe("meta adapter: send() (token via ctx; no global env)", () => {
  it("skips with missing_token when no token is supplied (no network)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const p = metaAdapter.buildPayload(event(), config)!;
    const res = await metaAdapter.send(p, config); // no ctx.token
    expect(res).toEqual({ ok: false, retryable: false, errorSafe: "missing_token" });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POSTs to the Graph API with the token in the BODY (never the URL), on success returns ok", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init: unknown) => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const p = metaAdapter.buildPayload(event(), config)!;
    const res = await metaAdapter.send(p, config, { token: "SECRET_TOKEN" });
    expect(res).toEqual({ ok: true, providerEventId: null });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/PX1/events");
    expect(String(url)).not.toContain("SECRET_TOKEN"); // token NOT in URL
    const body = JSON.parse((init as unknown as RequestInit).body as string);
    expect(body.access_token).toBe("SECRET_TOKEN"); // token in body
    vi.unstubAllGlobals();
  });

  it("maps HTTP failures to a redacted errorSafe (no raw provider response)", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const p = metaAdapter.buildPayload(event(), config)!;
    const res = await metaAdapter.send(p, config, { token: "T" });
    expect(res).toEqual({ ok: false, retryable: true, errorSafe: "meta_http_500" });
    vi.unstubAllGlobals();
  });

  it("does not read a global env token (no process.env in the adapter source)", () => {
    const SRC = readFileSync(path.resolve(__dirname, "../../../lib/conversion/adapters/meta.ts"), "utf8");
    expect(SRC).toContain('import "server-only"');
    expect(SRC).not.toContain("process.env");
    expect(SRC).not.toContain("META_CAPI_TOKEN");
  });
});
