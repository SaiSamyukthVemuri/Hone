import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalTwilioSignedUrl, twilioWebhookUrl } from "@/lib/sms/webhook-base";
import { smsStatusCallbackUrl, SMS_STATUS_CALLBACK_PATH } from "@/lib/sms/delivery-ledger";

// ONE base rule for every Twilio webhook URL Hone configures and every URL the
// signature-verifying routes rebuild. A URL Hone configures must, when Twilio
// calls it, be rebuilt by the route EXACTLY -- otherwise every callback,
// inbound STOP included, is a 403.

const INBOUND = "/api/twilio/inbound-sms";
const APP = "https://app.hone.example";
const BASE = "https://hone.care";
const INTERNAL = "https://hone-git-main-abc123.vercel.app";

describe("parity: what Hone configures is what the routes verify", () => {
  it("with TWILIO_WEBHOOK_BASE_URL set, the base wins over the app origin, whatever host the request arrives on", () => {
    const env = { TWILIO_WEBHOOK_BASE_URL: `${BASE}/` };
    for (const path of [INBOUND, SMS_STATUS_CALLBACK_PATH]) {
      const configured = twilioWebhookUrl(path, APP, env)!;
      expect(configured).toBe(`${BASE}${path}`);
      for (const arrivedOn of [configured, `${INTERNAL}${path}`, `${APP}${path}`]) {
        expect(canonicalTwilioSignedUrl(arrivedOn, env), arrivedOn).toBe(configured);
      }
    }
  });

  it("the status callback keeps its query and still matches", () => {
    const env = { TWILIO_WEBHOOK_BASE_URL: BASE };
    const id = "11111111-1111-4111-8111-111111111111";
    const ledger = smsStatusCallbackUrl(id, env as unknown as NodeJS.ProcessEnv)!;
    expect(ledger).toBe(`${twilioWebhookUrl(SMS_STATUS_CALLBACK_PATH, APP, env)}?m=${id}`);
    expect(canonicalTwilioSignedUrl(`${INTERNAL}${SMS_STATUS_CALLBACK_PATH}?m=${id}`, env)).toBe(ledger);
  });

  it("with no base, Hone configures the app origin and the route verifies the URL it was called on", () => {
    const configured = twilioWebhookUrl(INBOUND, `${APP}/`, {})!;
    expect(configured).toBe(`${APP}${INBOUND}`);
    expect(canonicalTwilioSignedUrl(configured, {})).toBe(configured);
  });

  it("no usable base configures nothing", () => {
    expect(twilioWebhookUrl(INBOUND, null, {})).toBeNull();
    expect(twilioWebhookUrl(INBOUND, APP, { TWILIO_WEBHOOK_BASE_URL: "hone.care" })).toBeNull();
    expect(twilioWebhookUrl(INBOUND, APP, { TWILIO_WEBHOOK_BASE_URL: "ftp://hone.care" })).toBeNull();
  });
});

describe("one rule, used everywhere (source guard)", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("both signature-verifying routes rebuild through canonicalTwilioSignedUrl and never read the base themselves", () => {
    for (const f of ["app/api/twilio/inbound-sms/route.ts", "app/api/twilio/message-status/route.ts"]) {
      const src = read(f);
      expect(src, f).toMatch(/const signedUrl = canonicalTwilioSignedUrl\(req\.url\);/);
      expect(src, f).not.toMatch(/process\.env\.TWILIO_WEBHOOK_BASE_URL/);
    }
  });

  it("the sender controls build every webhook URL through twilioWebhookUrl, never from the origin by hand", () => {
    const src = read("lib/sms/sender-controls.ts");
    expect(src).toMatch(/twilioWebhookUrl\("\/api\/twilio\/inbound-sms", appOrigin, env\)/);
    expect(src).toMatch(/twilioWebhookUrl\(SMS_STATUS_CALLBACK_PATH, appOrigin, env\)/);
    expect(src).not.toMatch(/\$\{origin\}\/api\/twilio/);
  });
});
