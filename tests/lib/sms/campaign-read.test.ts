import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeUsA2pCampaigns } from "@/lib/sms/provider/campaign-read";
import { twilioCampaignReader } from "@/lib/sms/provider/twilio-provider";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";

// SMS-CAMPAIGN-CHECK-01 (HON-50 G4b): the READ-ONLY campaign read. The real
// adapter is exercised against a stubbed fetch (no network; dummy values in
// place of credentials, as tests/lib/sms/twilio-provider.test.ts does), and
// the fake normalises through the SAME function, so they cannot disagree.

const MG = `MG${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;

describe("normalizeUsA2pCampaigns", () => {
  it("no campaign is `none`; one campaign maps its status", () => {
    expect(normalizeUsA2pCampaigns({ compliance: [] })).toEqual({ campaignSid: null, status: "none" });
    for (const [raw, status] of [
      ["VERIFIED", "verified"],
      ["PENDING", "pending"],
      ["IN_PROGRESS", "in_progress"],
      ["FAILED", "failed"],
    ] as const) {
      expect(normalizeUsA2pCampaigns({ compliance: [{ sid: QE, campaign_status: raw }] })).toEqual({ campaignSid: QE, status });
    }
  });

  it("everything else is unreadable (null): nothing would be recorded", () => {
    for (const json of [
      null,
      "x",
      {},
      { compliance: "x" },
      { compliance: [null] },
      { compliance: [{ sid: QE, campaign_status: "VERIFIED" }, { sid: QE, campaign_status: "VERIFIED" }] },
      { compliance: [{ sid: "QE123", campaign_status: "VERIFIED" }] },
      { compliance: [{ sid: QE, campaign_status: "verified" }] },
      { compliance: [{ sid: QE, campaign_status: "APPROVED" }] },
      { compliance: [{ sid: QE }] },
    ]) {
      expect(normalizeUsA2pCampaigns(json), JSON.stringify(json)).toBeNull();
    }
  });
});

describe("twilioCampaignReader (stubbed fetch)", () => {
  let calls: Array<{ url: string; method: string }> = [];
  function stubFetch(status: number, json: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        return { ok: status >= 200 && status < 300, status, json: async () => json } as unknown as Response;
      }),
    );
  }
  beforeEach(() => {
    calls = [];
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "sekrit");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("GETs the service's Usa2p list, and only that", async () => {
    stubFetch(200, { compliance: [{ sid: QE, campaign_status: "VERIFIED" }] });
    expect(await twilioCampaignReader.readUsA2pCampaign({ messagingServiceSid: MG })).toEqual({
      ok: true,
      campaign: { campaignSid: QE, status: "verified" },
    });
    expect(calls).toEqual([{ url: `https://messaging.twilio.com/v1/Services/${MG}/Compliance/Usa2p?PageSize=2`, method: "GET" }]);
  });

  it("an unreadable body, an HTTP error or missing configuration is an error, never an observation", async () => {
    stubFetch(200, { compliance: [{ sid: QE, campaign_status: "SOMETHING_NEW" }] });
    expect(await twilioCampaignReader.readUsA2pCampaign({ messagingServiceSid: MG })).toMatchObject({ ok: false, code: "provider_response_unparseable" });
    stubFetch(404, { message: "not found" });
    expect((await twilioCampaignReader.readUsA2pCampaign({ messagingServiceSid: MG })).ok).toBe(false);
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    calls = [];
    expect(await twilioCampaignReader.readUsA2pCampaign({ messagingServiceSid: MG })).toMatchObject({ ok: false, code: "provider_not_configured" });
    expect(calls).toEqual([]);
  });

  it("is GET-only in source: the campaign read never writes", () => {
    const src = readFileSync("lib/sms/provider/twilio-provider.ts", "utf8");
    const body = src.slice(src.indexOf("export const twilioCampaignReader"));
    expect(body).toContain('{ method: "GET" }');
    expect(body).not.toMatch(/method: "POST"/);
  });
});

describe("the fake reads through the same normaliser", () => {
  it("no list is `none`; a scripted list is normalised; a malformed one is an error", async () => {
    const fake = new FakeSmsProvisioningProvider({
      accountServices: [
        { sid: MG, numbers: [] },
        { sid: `MG${"c".repeat(32)}`, numbers: [], usA2pList: { compliance: [{ sid: QE, campaign_status: "PENDING" }] } },
        { sid: `MG${"d".repeat(32)}`, numbers: [], usA2pList: { compliance: [{ sid: "bad", campaign_status: "VERIFIED" }] } },
      ],
    });
    expect(await fake.readUsA2pCampaign({ messagingServiceSid: MG })).toEqual({ ok: true, campaign: { campaignSid: null, status: "none" } });
    expect(await fake.readUsA2pCampaign({ messagingServiceSid: `MG${"c".repeat(32)}` })).toEqual({ ok: true, campaign: { campaignSid: QE, status: "pending" } });
    expect(await fake.readUsA2pCampaign({ messagingServiceSid: `MG${"d".repeat(32)}` })).toMatchObject({ ok: false, code: "provider_response_unparseable" });
    expect(await fake.readUsA2pCampaign({ messagingServiceSid: `MG${"e".repeat(32)}` })).toMatchObject({ ok: false });
    expect(fake.calls.campaignRead).toBe(4);
  });

  it("a service the fake CREATED through provisioning is recognised, with no campaign (Codex P2 4301615740)", async () => {
    const fake = new FakeSmsProvisioningProvider();
    const created = await fake.createMessagingService({ claimKey: "hone-sms-test-claim", serviceLabel: "Studio" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await fake.readUsA2pCampaign({ messagingServiceSid: created.messagingServiceSid })).toEqual({
      ok: true,
      campaign: { campaignSid: null, status: "none" },
    });
  });

  it("the campaign read is not a member of the fenced provisioning port", () => {
    const fenced = readFileSync("lib/sms/provider/fenced.ts", "utf8");
    const types = readFileSync("lib/sms/provider/types.ts", "utf8");
    expect(fenced).not.toContain("readUsA2pCampaign");
    expect(types).not.toContain("readUsA2pCampaign");
  });
});
