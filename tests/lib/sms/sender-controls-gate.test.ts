import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { senderControlsGate } from "@/lib/sms/sender-controls";

// SMS-SENDER-CONTROL-01: the controls open ONLY in the explicit fake mode,
// never in production and never with live provisioning armed.

const never = () => false;
const armed = () => true;

describe("senderControlsGate", () => {
  it("opens only for HONE_SMS_SENDER_CONTROLS=fake", () => {
    expect(senderControlsGate({ HONE_SMS_SENDER_CONTROLS: "fake" }, never)).toEqual({ open: true, mode: "fake" });
    for (const v of [undefined, "", "true", "live", "FAKE"]) {
      expect(senderControlsGate({ HONE_SMS_SENDER_CONTROLS: v }, never), String(v)).toEqual({ open: false, reason: "not_enabled" });
    }
  });

  it("stays shut on a Vercel PREVIEW, which uses the production database (Codex P1 4251747841)", () => {
    for (const env of ["preview", "staging", "anything-hosted"]) {
      expect(senderControlsGate({ HONE_SMS_SENDER_CONTROLS: "fake", VERCEL_ENV: env }, never), env).toEqual({ open: false, reason: "hosted_deployment" });
    }
    expect(senderControlsGate({ HONE_SMS_SENDER_CONTROLS: "fake", VERCEL_ENV: "development" }, never)).toEqual({ open: true, mode: "fake" });
    expect(senderControlsGate({ HONE_SMS_SENDER_CONTROLS: "fake" }, never)).toEqual({ open: true, mode: "fake" });
  });

  it("stays shut in production, whatever the flag says", () => {
    expect(senderControlsGate({ HONE_SMS_SENDER_CONTROLS: "fake", VERCEL_ENV: "production" }, never)).toEqual({ open: false, reason: "production" });
  });

  it("stays shut when live provisioning is armed (a click could buy a number)", () => {
    expect(senderControlsGate({ HONE_SMS_SENDER_CONTROLS: "fake" }, armed)).toEqual({ open: false, reason: "live_provisioning_armed" });
  });
});

describe("the actions can only reach the fake provider (source guard)", () => {
  const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const actions = strip(readFileSync("app/(app)/settings/integrations/sender-control-actions.ts", "utf8"));
  const lib = strip(readFileSync("lib/sms/sender-controls.ts", "utf8"));

  it("the actions pass the controls' own seeded FAKE explicitly and never resolve a provider", () => {
    // Per studio (Codex P2 4251747847): every action, release included.
    expect(actions.match(/senderControlsFakeProvider\(getRequiredAppOrigin\(\), ctx\.studioId\)/g)).toHaveLength(4);
    expect(lib).toMatch(/new FakeSmsProvisioningProvider\(\{/);
    for (const forbidden of ["resolveProvisioningProvider", "twilioProvisioningProvider", "twilio-provider"]) {
      expect(actions, forbidden).not.toContain(forbidden);
      expect(lib, forbidden).not.toContain(forbidden);
    }
  });

  it("every action checks the gate before anything else", () => {
    for (const name of ["searchSenderNumbersAction", "provisionSenderNumberAction", "adoptSenderNumberAction", "releaseSenderClaimAction"]) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      const firstAwait = body.indexOf("await ");
      expect(body.slice(firstAwait, firstAwait + 30), name).toContain("ownerContext()");
    }
    expect(actions).toMatch(/const gate = senderControlsGate\(\);\s*\n\s*if \(!gate\.open\)/);
  });
});

describe("numberMatchesCountry / areaCodeMatchesCountry (Codex P2 4250699105)", () => {
  it("uses the NANP classifier: CA is CA, US is US, toll-free and other NANP are neither", async () => {
    const { numberMatchesCountry, areaCodeMatchesCountry } = await import("@/lib/sms/sender-controls");
    expect(numberMatchesCountry("+14165550101", "CA")).toBe(true);
    expect(numberMatchesCountry("+14165550101", "US")).toBe(false);
    expect(numberMatchesCountry("+12125550101", "US")).toBe(true);
    expect(numberMatchesCountry("+18885550101", "US")).toBe(false);
    expect(numberMatchesCountry("+18765550101", "US")).toBe(false);
    expect(numberMatchesCountry("not a number", "CA")).toBe(false);
    expect(areaCodeMatchesCountry("604", "CA")).toBe(true);
    expect(areaCodeMatchesCountry("604", "US")).toBe(false);
    expect(areaCodeMatchesCountry("12", "US")).toBe(false);
  });
});
