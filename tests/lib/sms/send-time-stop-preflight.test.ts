import { describe, expect, it, vi } from "vitest";
import type { RecordedStopPreflight } from "@/lib/sms/stop-preflight-record";
import { TEST_WEBHOOK_BASE, provenStopPreflight, withProvenSenderEnv, verifiedBinding } from "./helpers/proven-sender";

// ===========================================================================
// HON-50 G6: a listed studio sends NOTHING from its own number until its
// sender's inbound STOP path was proven and recorded (0230), for EVERY
// destination. STOP is phone-wide: a client who cannot opt out of the studio's
// number must not be texted from it, whoever they are.
// ===========================================================================
//
// Per the pending product decision (Sam), a refusal never falls back to the
// platform sender: it refuses before the claim, so no attempt is spent and the
// row is reconsidered intact once the preflight is recorded.

const h = vi.hoisted(() => ({ verdictBypassed: false }));

vi.mock("@/lib/sms/stop-preflight-record", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms/stop-preflight-record")>();
  return {
    ...real,
    stopPreflightVerdict: (...args: Parameters<typeof real.stopPreflightVerdict>) =>
      h.verdictBypassed ? { ok: true } : real.stopPreflightVerdict(...args),
  };
});

const { decideStudioRoute, resolveSendTimeRoute, STUDIO_ROUTING_ENV } = await import("@/lib/sms/send-time-route");
type Read = Parameters<typeof decideStudioRoute>[0]["read"];

withProvenSenderEnv();

const A = "11111111-1111-4111-8111-111111111111";
const CA_RECIPIENT = "+16475550123";
const US_RECIPIENT = "+12125550123";
const TOLL_FREE = "+18885550100";
const US_LONG_CODE = "+12125550100";
const MSID = `MG${"a".repeat(32)}`;

const sender = (over: Record<string, unknown> = {}) => ({
  id: "sender-a-1",
  studio_id: A,
  status: "active" as const,
  phone_number: TOLL_FREE,
  messaging_service_sid: MSID,
  provisioned_at: "2026-10-01T10:00:00.000Z",
  ...over,
});

const tollFreeEvidence = {
  studio_id: A,
  sender_id: "sender-a-1",
  phone_number: TOLL_FREE,
  kind: "toll_free_verification" as const,
  status: "approved" as const,
  missing_information: null,
};

const proven = (over: Partial<RecordedStopPreflight> = {}): RecordedStopPreflight => ({
  ...provenStopPreflight(sender() as never),
  ...over,
});

const tollFreeRead = (stopPreflights?: unknown, senderOver: Record<string, unknown> = {}): Read =>
  ({
    ok: true,
    senders: [sender(senderOver)],
    registrations: [tollFreeEvidence],
    ...(stopPreflights === undefined ? {} : { stopPreflights }),
  }) as Read;

const decide = (read: Read, recipientE164 = CA_RECIPIENT, env?: Record<string, string>) =>
  decideStudioRoute({ studioId: A, recipientE164, read, env });

describe("G6: a proven STOP path is required before any studio-routed message", () => {
  it("a passing preflight: served to both countries from the checked number", () => {
    expect(decide(tollFreeRead([proven()]), CA_RECIPIENT)).toMatchObject({ ok: true, fromNumber: TOLL_FREE, destination: "CA" });
    expect(decide(tollFreeRead([proven()]), US_RECIPIENT)).toMatchObject({ ok: true, fromNumber: TOLL_FREE, destination: "US" });
  });

  it.each<[string, Read, string]>([
    ["no preflight recorded (absent key, 0230 unapplied)", tollFreeRead(undefined), "stop_preflight_missing"],
    ["no preflight recorded (empty list)", tollFreeRead([]), "stop_preflight_missing"],
    ["only another sender's preflight", tollFreeRead([proven({ senderId: "sender-a-0" })]), "stop_preflight_missing"],
    ["recorded for another number", tollFreeRead([proven({ phoneNumber: "+18885550199" })]), "stop_preflight_mismatch"],
    ["recorded for another service", tollFreeRead([proven({ messagingServiceSid: `MG${"b".repeat(32)}` })]), "stop_preflight_mismatch"],
    ["the preflight did not pass", tollFreeRead([proven({ ready: false, checks: [{ id: "inbound_reaches", status: "fail" }] })]), "stop_preflight_not_ready"],
    ["an unknown check", tollFreeRead([proven({ checks: [{ id: "signature_account", status: "unknown" }] })]), "stop_preflight_not_ready"],
    ["checked before the sender was provisioned", tollFreeRead([proven({ checkedAt: "2026-09-30T10:00:00.000Z" })]), "stop_preflight_stale"],
  ])("%s: refused before the claim, to EVERY destination (%s)", (_name, read, reason) => {
    expect(decide(read, CA_RECIPIENT)).toEqual({ ok: false, reason });
    expect(decide(read, US_RECIPIENT)).toEqual({ ok: false, reason });
  });

  it("the webhook base moved since the preflight: refused (the signed URL changed)", () => {
    expect(decide(tollFreeRead([proven()]), CA_RECIPIENT, { TWILIO_WEBHOOK_BASE_URL: "https://moved.test" })).toEqual({
      ok: false,
      reason: "stop_preflight_base_changed",
    });
  });

  it("a stopPreflights answer that is not a list is unreadable", () => {
    expect(decide(tollFreeRead({ not: "a list" }))).toEqual({ ok: false, reason: "sender_read_failed" });
  });

  it("G6 runs before G7: a US 10DLC send with a verified binding but no preflight refuses on the preflight", () => {
    const s = sender({ phone_number: US_LONG_CODE });
    const read = {
      ok: true,
      senders: [s],
      registrations: [{ ...tollFreeEvidence, phone_number: US_LONG_CODE, kind: "us_10dlc" as const }],
      campaignBindings: [verifiedBinding(s as never)],
      stopPreflights: [],
    } as Read;
    expect(decide(read, US_RECIPIENT)).toEqual({ ok: false, reason: "stop_preflight_missing" });
  });
});

describe("G6 never touches the platform route", () => {
  it("an unlisted studio routes through the platform sender with no read at all", async () => {
    const reader = vi.fn();
    const r = await resolveSendTimeRoute({
      studioId: A,
      recipientE164: CA_RECIPIENT,
      reader,
      env: { [STUDIO_ROUTING_ENV]: "", TWILIO_WEBHOOK_BASE_URL: TEST_WEBHOOK_BASE },
    });
    expect(r).toEqual({ ok: true, mode: "platform" });
    expect(reader).not.toHaveBeenCalled();
  });

  it("a listed studio without a preflight REFUSES; it never falls back to the platform sender", async () => {
    const r = await resolveSendTimeRoute({
      studioId: A,
      recipientE164: CA_RECIPIENT,
      reader: async () => tollFreeRead([]),
      env: { [STUDIO_ROUTING_ENV]: A, TWILIO_WEBHOOK_BASE_URL: TEST_WEBHOOK_BASE },
    });
    expect(r).toEqual({ ok: false, reason: "stop_preflight_missing" });
  });

  it("resolveSendTimeRoute compares against the env it was given", async () => {
    const r = await resolveSendTimeRoute({
      studioId: A,
      recipientE164: CA_RECIPIENT,
      reader: async () => tollFreeRead([proven()]),
      env: { [STUDIO_ROUTING_ENV]: A, TWILIO_WEBHOOK_BASE_URL: "https://moved.test" },
    });
    expect(r).toEqual({ ok: false, reason: "stop_preflight_base_changed" });
  });
});

describe("NEGATIVE CONTROL: the refusals are carried by the verdict", () => {
  it("with the verdict forced to ok, a listed studio with NO preflight routes", () => {
    h.verdictBypassed = true;
    try {
      expect(decide(tollFreeRead([]))).toMatchObject({ ok: true, fromNumber: TOLL_FREE });
    } finally {
      h.verdictBypassed = false;
    }
  });
});
