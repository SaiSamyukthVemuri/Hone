import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  bookingEventId,
  buildCapiRequestBody,
  buildScheduleEvent,
  normalizeEmailForMeta,
  normalizePhoneForMeta,
  safeServiceCategory,
  sha256Hex,
  type MetaTrackingConfig,
} from "@/lib/conversion/meta-capi";

const enabled: MetaTrackingConfig = { pixelId: "123", enabled: true };

describe("normalization + hashing (Meta spec)", () => {
  it("normalizeEmailForMeta lowercases + trims; null when unusable", () => {
    expect(normalizeEmailForMeta("  Jane.Doe@GMAIL.com ")).toBe("jane.doe@gmail.com");
    expect(normalizeEmailForMeta("nope")).toBeNull();
    expect(normalizeEmailForMeta(null)).toBeNull();
  });
  it("normalizePhoneForMeta strips formatting + adds country code", () => {
    expect(normalizePhoneForMeta("+1 (416) 555-1234")).toBe("14165551234");
    expect(normalizePhoneForMeta("416-555-1234")).toBe("14165551234"); // 10-digit → +1
    expect(normalizePhoneForMeta("")).toBeNull();
    expect(normalizePhoneForMeta("123")).toBeNull();
  });
  it("sha256Hex matches a known vector (unsalted)", () => {
    const v = "jane.doe@gmail.com";
    expect(sha256Hex(v)).toBe(createHash("sha256").update(v, "utf8").digest("hex"));
    expect(sha256Hex(v)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("safeServiceCategory (body-area leak guard)", () => {
  it("passes known generic modalities through", () => {
    expect(safeServiceCategory("electrolysis")).toBe("electrolysis");
    expect(safeServiceCategory("Laser")).toBe("laser");
    expect(safeServiceCategory("consultation")).toBe("consultation");
  });
  it("collapses ANY free-text service name to 'other' (never leaks a body area)", () => {
    expect(safeServiceCategory("Brazilian Electrolysis")).toBe("other");
    expect(safeServiceCategory("Bikini Laser")).toBe("other");
    expect(safeServiceCategory("Underarm")).toBe("other");
    expect(safeServiceCategory(null)).toBe("other");
  });
});

describe("buildScheduleEvent — gating", () => {
  it("skips when tracking disabled", () => {
    const r = buildScheduleEvent({ pixelId: "1", enabled: false }, base());
    expect(r).toEqual({ ok: false, skippedReason: "tracking_disabled" });
  });
  it("skips when pixel id missing", () => {
    const r = buildScheduleEvent({ pixelId: null, enabled: true }, base());
    expect(r).toEqual({ ok: false, skippedReason: "missing_pixel_id" });
  });
  it("skips when appointment id missing", () => {
    const r = buildScheduleEvent(enabled, base({ appointmentId: "" }));
    expect(r).toEqual({ ok: false, skippedReason: "missing_appointment_id" });
  });
});

describe("buildScheduleEvent — event shape + safety", () => {
  const r = buildScheduleEvent(
    enabled,
    base({
      email: "Jane.Doe@Gmail.com",
      phone: "(416) 555-1234",
      clientIp: "203.0.113.7",
      userAgent: "Mozilla/5.0",
      serviceModality: "electrolysis",
      eventSourceUrl: "https://hone.care/book/willow-electrolysis",
    }),
  );
  if (!r.ok) throw new Error("expected ok");

  it("has the required Meta Schedule fields + deterministic event_id", () => {
    expect(r.event.event_name).toBe("Schedule");
    expect(r.event.action_source).toBe("website");
    expect(r.event.event_id).toBe("hone_booking_appt_1");
    expect(r.eventId).toBe(bookingEventId("appt_1"));
    expect(r.event.event_source_url).toBe("https://hone.care/book/willow-electrolysis");
    expect(r.event.custom_data).toEqual({ service_category: "electrolysis" });
  });

  it("email + phone are SHA-256 hashed, NEVER raw", () => {
    expect(r.event.user_data.em).toEqual([sha256Hex("jane.doe@gmail.com")]);
    expect(r.event.user_data.ph).toEqual([sha256Hex("14165551234")]);
    const json = JSON.stringify(r.event);
    expect(json).not.toContain("Jane.Doe@Gmail.com");
    expect(json).not.toContain("jane.doe@gmail.com");
    expect(json).not.toContain("4165551234"); // raw phone digits absent
    expect(r.event.user_data.em![0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("IP + UA pass through unhashed (per Meta spec) only when provided", () => {
    expect(r.event.user_data.client_ip_address).toBe("203.0.113.7");
    expect(r.event.user_data.client_user_agent).toBe("Mozilla/5.0");
    const none = buildScheduleEvent(enabled, base());
    if (!none.ok) throw new Error("ok");
    expect(none.event.user_data.client_ip_address).toBeUndefined();
    expect(none.event.user_data.client_user_agent).toBeUndefined();
  });

  it("deterministic: same appointment id → same event_id (dedup/retry safe)", () => {
    const a = buildScheduleEvent(enabled, base());
    const b = buildScheduleEvent(enabled, base());
    if (!a.ok || !b.ok) throw new Error("ok");
    expect(a.event.event_id).toBe(b.event.event_id);
  });

  it("a free-text service NAME passed as modality is genericized to 'other'", () => {
    const leaky = buildScheduleEvent(
      enabled,
      base({ serviceModality: "Brazilian Electrolysis" }),
    );
    if (!leaky.ok) throw new Error("ok");
    expect(leaky.event.custom_data).toEqual({ service_category: "other" });
    expect(JSON.stringify(leaky.event)).not.toMatch(/brazilian/i);
  });
});

describe("buildCapiRequestBody", () => {
  it("wraps events in { data } and only adds test_event_code when set", () => {
    const r = buildScheduleEvent(enabled, base());
    if (!r.ok) throw new Error("ok");
    expect(buildCapiRequestBody([r.event])).toEqual({ data: [r.event] });
    expect(buildCapiRequestBody([r.event], "TEST123")).toEqual({
      data: [r.event],
      test_event_code: "TEST123",
    });
  });
});

// Static data-minimization guard: the module must never reference any clinical/
// PII field name, so it is impossible to add one to the payload by accident.
describe("data-minimization source guard", () => {
  const SRC = readFileSync(
    path.resolve(__dirname, "../../../lib/conversion/meta-capi.ts"),
    "utf8",
  );
  const FORBIDDEN = [
    "notes",
    "contraindication",
    "allergie",
    "skin_notes",
    "fitzpatrick",
    "intake",
    "cancellation_reason",
    "service.name",
    "service_name",
    "client.name",
    "full_name",
    ".area",
    "body_area",
  ];
  for (const f of FORBIDDEN) {
    it(`never references "${f}"`, () => {
      // Allowed in comments as a NEGATIVE reference; assert it is not used as a
      // code token by checking it never appears followed by ':' or '=' or '.'
      // Simpler: it must not appear at all outside the contract comment block.
      const code = SRC.split("DATA-MINIMIZATION CONTRACT")[1] ?? SRC;
      const afterComment = code.split("---------------------------------------------------------------------------")[1] ?? "";
      expect(afterComment.toLowerCase()).not.toContain(f.toLowerCase());
    });
  }
});

function base(over: Record<string, unknown> = {}) {
  return {
    appointmentId: "appt_1",
    eventTimeUnixSeconds: 1_780_000_000,
    ...over,
  } as Parameters<typeof buildScheduleEvent>[1];
}
