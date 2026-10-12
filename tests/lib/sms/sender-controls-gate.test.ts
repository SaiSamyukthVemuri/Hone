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

  it("the actions pass the process FAKE explicitly and never resolve a provider", () => {
    expect(actions).toMatch(/fakeSmsProvisioningProvider\(\)/);
    for (const forbidden of ["resolveProvisioningProvider", "twilioProvisioningProvider", "twilio-provider"]) {
      expect(actions, forbidden).not.toContain(forbidden);
      expect(lib, forbidden).not.toContain(forbidden);
    }
  });

  it("every action checks the gate before anything else", () => {
    for (const name of ["searchSenderNumbersAction", "provisionSenderNumberAction", "adoptSenderNumberAction"]) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      const firstAwait = body.indexOf("await ");
      expect(body.slice(firstAwait, firstAwait + 30), name).toContain("ownerContext()");
    }
    expect(actions).toMatch(/const gate = senderControlsGate\(\);\s*\n\s*if \(!gate\.open\)/);
  });
});
