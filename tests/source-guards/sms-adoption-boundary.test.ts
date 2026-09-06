import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BILLABLE_OR_MUTATING_EFFECTS, CLAIM_SCOPED_READS } from "@/lib/sms/provider/fenced";

// WILLOW ADOPTION — the boundary guard.
//
// The behavioural suite proves the fake was never asked to purchase. This
// proves the SOURCE cannot ask, which is the stronger and cheaper statement:
// a future edit that reintroduces a purchase, a service creation, an attach, or
// the deployment-global sender fallback fails here rather than on someone's
// Twilio invoice.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments explain the rules; they must never satisfy them. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const ADOPTION = codeOnly(read("lib/sms/adoption.ts"));
const TWILIO_ADAPTER = read("lib/sms/provider/twilio-provider.ts");

describe("adoption cannot purchase, create or move", () => {
  const FORBIDDEN = [
    "purchaseNumber",
    "createMessagingService",
    "attachNumberToService",
    "searchAvailableNumbers",
    "isNumberAvailable",
  ];
  for (const effect of FORBIDDEN) {
    it(`never calls ${effect}`, () => {
      expect(ADOPTION, `adoption references ${effect}`).not.toContain(effect);
    });
  }

  it("adoption reaches the provider ONLY through the fenced wrapper", () => {
    // A raw `input.provider.` call would bypass the fence entirely.
    expect(ADOPTION).toContain("fenceProviderMutations");
    expect(ADOPTION).not.toMatch(/input\.provider\.[a-zA-Z]/);
  });

  it("the ownership read happens BEFORE any configuration call", () => {
    const lookupAt = ADOPTION.indexOf("lookupOwnedNumber");
    const inboundAt = ADOPTION.indexOf("configureInboundWebhook");
    const testAt = ADOPTION.indexOf("sendProvisioningTest");
    expect(lookupAt).toBeGreaterThan(-1);
    expect(lookupAt).toBeLessThan(inboundAt);
    expect(lookupAt).toBeLessThan(testAt);
  });

  it("an unknown membership answer is refused, never treated as absence", () => {
    // Reading `unknown` as "not a member" is what would license an attach that
    // silently moves the number out of another service.
    expect(ADOPTION).toMatch(/inNamedService !== "yes"/);
    expect(ADOPTION).toContain("service_membership_unknown");
  });
});

describe("activation still requires a genuine provider test", () => {
  it("adoption never finalizes with testOk true outside the success branch", () => {
    const trueFinalizes = (ADOPTION.match(/testOk: true/g) ?? []).length;
    expect(trueFinalizes).toBe(1);
  });

  it("the failed-test branch finalizes with testOk FALSE", () => {
    expect(ADOPTION).toMatch(/testOk: false/);
  });

  it("adoption writes no status of its own", () => {
    // Activation is 0191's decision, taken inside finalize.
    expect(ADOPTION).not.toMatch(/status:\s*"active"/);
    expect(ADOPTION).not.toMatch(/\.update\(|\.insert\(|\.upsert\(/);
  });
});

describe("no deployment-global sender fallback is reintroduced", () => {
  it("adoption never reads the global sender credentials or number", () => {
    for (const env of [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_MESSAGING_SERVICE_SID",
      "TWILIO_FROM",
      "TWILIO_PHONE_NUMBER",
      "process.env",
    ]) {
      expect(ADOPTION, `adoption reads ${env}`).not.toContain(env);
    }
  });

  it("adoption requires a per-studio messaging service, with no default", () => {
    expect(ADOPTION).toMatch(/messagingServiceSid: string;/);
    expect(ADOPTION).not.toMatch(/messagingServiceSid\s*(\?\?|\|\|)\s*/);
  });
});

describe("the new provider read is READ-ONLY", () => {
  it("lookupOwnedNumber issues no write verb", () => {
    const start = TWILIO_ADAPTER.indexOf("async lookupOwnedNumber(");
    expect(start).toBeGreaterThan(-1);
    const end = TWILIO_ADAPTER.indexOf("\n  async ", start + 10);
    const body = TWILIO_ADAPTER.slice(start, end === -1 ? TWILIO_ADAPTER.length : end);
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(body, `lookupOwnedNumber issues a ${verb}`).not.toContain(`"${verb}"`);
    }
    expect((body.match(/method: "GET"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("the fence classification stays total", () => {
  it("the new read is classified as claim-scoped, not left unfenced", () => {
    expect([...CLAIM_SCOPED_READS]).toContain("lookupOwnedNumber");
    expect([...BILLABLE_OR_MUTATING_EFFECTS]).not.toContain("lookupOwnedNumber");
  });

  it("every port method is classified — adding one breaks tsc, this catches drift", () => {
    const types = read("lib/sms/provider/types.ts");
    const portStart = types.indexOf("export interface SmsProvisioningProvider");
    const port = types.slice(portStart, types.indexOf("\n}", portStart));
    const methods = [...port.matchAll(/^\s{2}([a-zA-Z]+)\(/gm)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThanOrEqual(10);
    const classified = new Set<string>([
      ...BILLABLE_OR_MUTATING_EFFECTS,
      ...CLAIM_SCOPED_READS,
      "searchAvailableNumbers",
    ]);
    expect(methods.filter((m) => !classified.has(m))).toEqual([]);
  });
});
