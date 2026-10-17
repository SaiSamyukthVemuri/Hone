import { describe, expect, it, vi } from "vitest";
import type { RecordedCampaignBinding } from "@/lib/sms/campaign-binding";
import { TEST_WEBHOOK_BASE, provenStopPreflight, withProvenSenderEnv } from "./helpers/proven-sender";

// ===========================================================================
// HON-50 G7: a US recipient from a 10DLC long code is served only when the
// sender's RECORDED campaign binding (0229) proves its messaging service is
// the one linked to the verified US A2P campaign.
// ===========================================================================
//
// Without it, a number sitting in a service that has no campaign reads as
// ready (approved 10DLC evidence) and carriers filter the traffic. The binding
// is recorded at evidence and cutover time by the SMS lane; the send path only
// reads it from the same snapshot as the sender, and refuses before the claim
// on anything but a verified, current, matching binding. Toll-free senders are
// held to toll-free verification instead, and Canadian recipients need no
// 10DLC campaign, so neither consults it.

const h = vi.hoisted(() => ({ verdictBypassed: false }));

// NEGATIVE CONTROL hook: with the verdict forced to ok, the missing-binding
// case must route, proving the assertions below are carried by the verdict.
vi.mock("@/lib/sms/campaign-binding", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms/campaign-binding")>();
  return {
    ...real,
    campaignBindingVerdict: (...args: Parameters<typeof real.campaignBindingVerdict>) =>
      h.verdictBypassed ? { ok: true } : real.campaignBindingVerdict(...args),
  };
});

const { decideStudioRoute, liveSendTimeRouteReader } = await import("@/lib/sms/send-time-route");
type Read = Parameters<typeof decideStudioRoute>[0]["read"];

const A = "11111111-1111-4111-8111-111111111111";
const US_RECIPIENT = "+12125550123";
const CA_RECIPIENT = "+16475550123";
const US_LONG_CODE = "+12125550100";
const TOLL_FREE = "+18885550100";
const MSID = `MG${"a".repeat(32)}`;
const OTHER_MSID = `MG${"b".repeat(32)}`;
const PROVISIONED_AT = "2026-10-01T10:00:00.000Z";

const sender = (over: Record<string, unknown> = {}) => ({
  id: "sender-a-1",
  studio_id: A,
  status: "active" as const,
  phone_number: US_LONG_CODE,
  messaging_service_sid: MSID,
  provisioned_at: PROVISIONED_AT,
  ...over,
});

const evidence = (phone: string, kind: "us_10dlc" | "toll_free_verification") => ({
  studio_id: A,
  sender_id: "sender-a-1",
  phone_number: phone,
  kind,
  status: "approved" as const,
  missing_information: null,
});

const binding = (over: Partial<RecordedCampaignBinding> = {}): RecordedCampaignBinding => ({
  senderId: "sender-a-1",
  studioId: A,
  phoneNumber: US_LONG_CODE,
  messagingServiceSid: MSID,
  campaignSid: `CM${"c".repeat(32)}`,
  campaignStatus: "verified",
  checkedAt: "2026-10-02T10:00:00.000Z",
  verifiedAt: "2026-10-02T10:00:00.000Z",
  ...over,
});

const longCodeRead = (bindings?: unknown, senderOver: Record<string, unknown> = {}): Read =>
  ({
    ok: true,
    senders: [sender(senderOver)],
    registrations: [evidence(US_LONG_CODE, "us_10dlc")],
    stopPreflights: stopFor(senderOver),
    ...(bindings === undefined ? {} : { campaignBindings: bindings }),
  }) as Read;

// G6 runs first and is not under test here: every sender's STOP path is proven.
withProvenSenderEnv();
const stopFor = (over: Record<string, unknown> = {}) => [provenStopPreflight({ ...sender(), ...over } as never)];

const decide = (read: Read, recipientE164 = US_RECIPIENT) => decideStudioRoute({ studioId: A, recipientE164, read });

describe("G7: US traffic from a 10DLC long code requires a verified, current, matching binding", () => {
  it("a verified binding recorded after provisioning: served, From is the checked number", () => {
    expect(decide(longCodeRead([binding()]))).toMatchObject({
      ok: true,
      mode: "studio",
      fromNumber: US_LONG_CODE,
      messagingServiceSid: MSID,
      senderId: "sender-a-1",
      destination: "US",
    });
  });

  it.each([
    ["no binding recorded (absent key, 0229 unapplied)", longCodeRead(undefined), "campaign_binding_missing"],
    ["no binding recorded (empty list)", longCodeRead([]), "campaign_binding_missing"],
    ["only ANOTHER sender's binding", longCodeRead([binding({ senderId: "sender-a-0" })]), "campaign_binding_missing"],
    ["a binding for another messaging service", longCodeRead([binding({ messagingServiceSid: OTHER_MSID })]), "campaign_binding_mismatch"],
    ["a binding for another number", longCodeRead([binding({ phoneNumber: "+12125550199" })]), "campaign_binding_mismatch"],
    ["a binding recorded for another studio", longCodeRead([binding({ studioId: "22222222-2222-4222-8222-222222222222" })]), "campaign_binding_mismatch"],
    ["a pending campaign", longCodeRead([binding({ campaignStatus: "pending", verifiedAt: null })]), "campaign_binding_unverified"],
    ["a service with no campaign", longCodeRead([binding({ campaignStatus: "none", campaignSid: null, verifiedAt: null })]), "campaign_binding_unverified"],
    ["checked BEFORE the sender was provisioned", longCodeRead([binding({ checkedAt: "2026-09-30T10:00:00.000Z" })]), "campaign_binding_stale"],
    // Unknown provisioning makes the G6 STOP preflight stale first (G6 runs
    // before G7); campaignBindingVerdict's own stale rule is pinned in #901.
    ["the sender's provisioned_at unknown (absent before 0229)", longCodeRead([binding()], { provisioned_at: undefined }), "stop_preflight_stale"],
  ])("%s: refused before the claim (%s)", (_name, read, reason) => {
    expect(decide(read)).toEqual({ ok: false, reason });
  });

  it("a campaignBindings answer that is not a list is unreadable, never 'no binding'", () => {
    expect(decide(longCodeRead({ not: "a list" }))).toEqual({ ok: false, reason: "sender_read_failed" });
  });
});

describe("G7 leaves the other routes exactly as they were", () => {
  it("a toll-free sender with approved verification serves the US with NO binding (toll-free verification governs it)", () => {
    const read = {
      ok: true,
      senders: [sender({ phone_number: TOLL_FREE })],
      registrations: [evidence(TOLL_FREE, "toll_free_verification")],
      stopPreflights: stopFor({ phone_number: TOLL_FREE }),
    } as Read;
    expect(decide(read, US_RECIPIENT)).toMatchObject({ ok: true, fromNumber: TOLL_FREE, destination: "US" });
    expect(decide(read, CA_RECIPIENT)).toMatchObject({ ok: true, fromNumber: TOLL_FREE, destination: "CA" });
  });

  it("a Canadian recipient is decided by readiness alone, binding or not", () => {
    const withBinding = decide(longCodeRead([binding()]), CA_RECIPIENT);
    const without = decide(longCodeRead([]), CA_RECIPIENT);
    expect(withBinding).toEqual(without);
    expect(without).toMatchObject({ ok: false, reason: "destination_not_ready" });
  });
});

describe("G7 reads the binding from the SAME snapshot as the sender", () => {
  const rpcAnswer = (data: unknown) =>
    ({ rpc: async () => ({ data, error: null }) }) as unknown as Parameters<typeof liveSendTimeRouteReader>[0];
  const snapshot = (campaign_bindings?: unknown[]) => ({
    senders: [sender()],
    registrations: [{ ...evidence(US_LONG_CODE, "us_10dlc"), provider_reference: null, updated_at: PROVISIONED_AT }],
    ...(campaign_bindings ? { campaign_bindings } : {}),
    stop_preflights: [
      {
        sender_id: "sender-a-1",
        studio_id: A,
        phone_number: US_LONG_CODE,
        messaging_service_sid: MSID,
        ready: true,
        checks: [{ id: "one_base", status: "pass" }],
        webhook_base: TEST_WEBHOOK_BASE,
        credentials_epoch: null,
        checked_at: "2026-10-02T10:00:00.000Z",
      },
    ],
  });
  const rawBinding = {
    sender_id: "sender-a-1",
    studio_id: A,
    phone_number: US_LONG_CODE,
    messaging_service_sid: MSID,
    campaign_sid: `CM${"c".repeat(32)}`,
    campaign_status: "verified",
    checked_at: "2026-10-02T10:00:00.000Z",
    verified_at: "2026-10-02T10:00:00.000Z",
  };

  it("a verified binding in the snapshot serves the US", async () => {
    const read = await liveSendTimeRouteReader(rpcAnswer(snapshot([rawBinding])))(A);
    expect(decide(read)).toMatchObject({ ok: true, destination: "US" });
  });

  it("a snapshot without campaign_bindings (0229 unapplied) refuses as missing", async () => {
    const read = await liveSendTimeRouteReader(rpcAnswer(snapshot()))(A);
    expect(decide(read)).toEqual({ ok: false, reason: "campaign_binding_missing" });
  });

  it("two bindings for one sender make the WHOLE read unreadable", async () => {
    const read = await liveSendTimeRouteReader(rpcAnswer(snapshot([rawBinding, rawBinding])))(A);
    expect(decide(read)).toEqual({ ok: false, reason: "sender_read_failed" });
  });
});

describe("NEGATIVE CONTROL: the refusals are carried by the verdict", () => {
  it("with the verdict forced to ok, a US long code with NO binding routes", () => {
    h.verdictBypassed = true;
    try {
      expect(decide(longCodeRead([]))).toMatchObject({ ok: true, destination: "US" });
    } finally {
      h.verdictBypassed = false;
    }
  });
});
