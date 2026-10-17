import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { campaignReaderFor, runCampaignCheck } from "@/lib/sms/campaign-check";
import { twilioCampaignReader } from "@/lib/sms/provider/twilio-provider";
import type { SmsCampaignReader } from "@/lib/sms/provider/campaign-read";

// SMS-CAMPAIGN-CHECK-01 (HON-50 G4b): support's campaign check. The service
// checked is the one the snapshot says the sender holds now; the observation
// is recorded through 0229 only when the read succeeded; and no reader is
// available unless live provisioning is armed or the local fake mode is open.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const SENDER = "22222222-2222-4222-8222-222222222222";
const PHONE = "+12125550123";
const MG = `MG${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;

function admin(snapshot: unknown, recordAnswer: { data?: unknown; error?: unknown; throws?: boolean } = { data: [{ result: "recorded" }] }) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "get_live_studio_sms_sender_registration_state") return { data: snapshot, error: null };
    if (fn === "record_studio_sms_campaign_binding") {
      if (recordAnswer.throws) throw new Error("lost");
      return { data: recordAnswer.data ?? null, error: recordAnswer.error ?? null, args };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const snapshot = (service: string | null = MG, phone = PHONE) => ({
  senders: [{ id: SENDER, studio_id: STUDIO, status: "active", phone_number: phone, messaging_service_sid: service, provisioned_at: "2026-10-01T00:00:00Z" }],
  registrations: [],
  campaign_bindings: [],
});

function reader(answer: Awaited<ReturnType<SmsCampaignReader["readUsA2pCampaign"]>>) {
  const readUsA2pCampaign = vi.fn(async () => answer);
  return { reader: { readUsA2pCampaign } as SmsCampaignReader, readUsA2pCampaign };
}

const input = { studioId: STUDIO, expectedSenderId: SENDER, expectedPhone: PHONE, context: "evidence" as const };

describe("runCampaignCheck", () => {
  it("reads the SNAPSHOT's service and records the observation", async () => {
    const a = admin(snapshot());
    const r = reader({ ok: true, campaign: { campaignSid: QE, status: "verified" } });
    expect(await runCampaignCheck({ admin: a.client, reader: r.reader }, input)).toEqual({ result: "recorded", status: "verified", campaignSid: QE });
    expect(r.readUsA2pCampaign).toHaveBeenCalledWith({ messagingServiceSid: MG });
    expect(a.rpc).toHaveBeenCalledWith("record_studio_sms_campaign_binding", {
      p_studio_id: STUDIO,
      p_expected_sender_id: SENDER,
      p_expected_phone: PHONE,
      p_messaging_service_sid: MG,
      p_campaign_sid: QE,
      p_campaign_status: "verified",
      p_context: "evidence",
    });
  });

  it("no reader, an unreadable snapshot, a changed sender or no service: nothing read, nothing recorded", async () => {
    const r = reader({ ok: true, campaign: { campaignSid: null, status: "none" } });
    const cases: Array<[unknown, ReturnType<typeof reader>["reader"] | null, string]> = [
      [snapshot(), null, "not_available"],
      [{ senders: "x" }, r.reader, "unreadable"],
      [snapshot(MG, "+12125550199"), r.reader, "sender_changed"],
      [snapshot(null), r.reader, "no_service"],
    ];
    for (const [snap, rd, expected] of cases) {
      const a = admin(snap);
      expect(await runCampaignCheck({ admin: a.client, reader: rd }, input), expected).toEqual({ result: expected });
      expect(a.rpc.mock.calls.some(([fn]) => fn === "record_studio_sms_campaign_binding"), expected).toBe(false);
    }
    expect(r.readUsA2pCampaign).not.toHaveBeenCalled();
  });

  it("a provider error records nothing", async () => {
    const a = admin(snapshot());
    const r = reader({ ok: false, code: "provider_timeout", retryable: true });
    expect(await runCampaignCheck({ admin: a.client, reader: r.reader }, input)).toEqual({ result: "provider_error", code: "provider_timeout" });
    expect(a.rpc.mock.calls.some(([fn]) => fn === "record_studio_sms_campaign_binding")).toBe(false);
  });

  it("the command's refusal is reported; a lost or unreadable answer is outcome_unknown, never a refusal", async () => {
    const ok = reader({ ok: true, campaign: { campaignSid: QE, status: "pending" } });
    expect(await runCampaignCheck({ admin: admin(snapshot(), { data: [{ result: "sender_changed" }] }).client, reader: ok.reader }, input)).toEqual({ result: "record_refused", code: "sender_changed" });
    const progress = { dispatched: false };
    expect(await runCampaignCheck({ admin: admin(snapshot(), { throws: true }).client, reader: ok.reader }, input, progress)).toEqual({ result: "outcome_unknown" });
    expect(progress.dispatched).toBe(true);
    expect(await runCampaignCheck({ admin: admin(snapshot(), { data: null }).client, reader: ok.reader }, input)).toEqual({ result: "outcome_unknown" });
  });
});

describe("campaignReaderFor", () => {
  const LOCAL = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" } as unknown as NodeJS.ProcessEnv;
  it("armed: the real, GET-only reader, whatever the controls' mode", () => {
    expect(campaignReaderFor(STUDIO, "https://hone.care", {} as NodeJS.ProcessEnv, () => true)).toBe(twilioCampaignReader);
  });
  it("unarmed: the fake only where the local fake controls are open; otherwise none", () => {
    const fake = campaignReaderFor(STUDIO, "https://hone.care", { ...LOCAL, HONE_SMS_SENDER_CONTROLS: "fake" } as NodeJS.ProcessEnv, () => false);
    expect(fake).not.toBeNull();
    expect(fake).not.toBe(twilioCampaignReader);
    expect(campaignReaderFor(STUDIO, "https://hone.care", { ...LOCAL } as NodeJS.ProcessEnv, () => false)).toBeNull();
    expect(campaignReaderFor(STUDIO, "https://hone.care", { VERCEL_ENV: "production", HONE_SMS_SENDER_CONTROLS: "fake" } as unknown as NodeJS.ProcessEnv, () => false)).toBeNull();
  });
});
