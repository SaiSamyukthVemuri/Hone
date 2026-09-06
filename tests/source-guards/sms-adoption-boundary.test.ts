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
  // DECISION 1 added the two configuration writes to this list. An existing
  // studio-owned Messaging Service is not Hone's to reconfigure: adoption
  // COMPARES and refuses, and the mutation needs an explicit human decision.
  const FORBIDDEN = [
    "purchaseNumber",
    "createMessagingService",
    "attachNumberToService",
    "searchAvailableNumbers",
    "isNumberAvailable",
    "configureInboundWebhook",
    "configureStatusCallback",
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

  it("PROVE, then act: ownership → configuration comparison → test", () => {
    // The order is the design. Reading configuration before ownership is proven
    // would probe a service on behalf of a number the account may not own, and
    // sending the test before either would spend a message on an unverified
    // sender.
    const lookupAt = ADOPTION.indexOf("provider.lookupOwnedNumber");
    const configAt = ADOPTION.indexOf("provider.readMessagingServiceConfig");
    const testAt = ADOPTION.indexOf("provider.sendProvisioningTest");
    expect(lookupAt).toBeGreaterThan(-1);
    expect(configAt).toBeGreaterThan(lookupAt);
    expect(testAt).toBeGreaterThan(configAt);
  });

  it("every association verdict is handled, and only one of them proceeds", () => {
    // The five states exist so "we could not finish the census" cannot read as
    // "the number is free to attach".
    for (const kind of [
      "in_expected_service",
      "in_other_service",
      "not_associated",
      "ambiguous",
      "unavailable",
    ]) {
      expect(ADOPTION, `association ${kind} unhandled`).toContain(kind);
    }
    // Exactly one verdict falls through to the rest of the flow.
    expect((ADOPTION.match(/case "in_expected_service":\s*\n\s*break;/g) ?? []).length).toBe(1);
  });

  it("adoption reads the service configuration and compares rather than writing", () => {
    expect(ADOPTION).toContain("readMessagingServiceConfig");
    expect(ADOPTION).toContain("provider_configuration_required");
    expect(ADOPTION).toMatch(/inboundRequestUrl !== input\.requiredInboundWebhookUrl/);
    expect(ADOPTION).toMatch(/statusCallbackUrl !== input\.requiredStatusCallbackUrl/);
  });

  it("a configuration mismatch is NOT reported as a provider-test failure", () => {
    const mismatchAt = ADOPTION.indexOf("provider_configuration_required");
    const testAt = ADOPTION.indexOf("sendProvisioningTest");
    expect(mismatchAt).toBeGreaterThan(-1);
    // The refusal returns before the test is ever sent.
    expect(mismatchAt).toBeLessThan(testAt);
  });

  it("discovered identifiers are redacted before they leave", () => {
    // An operator must be able to recognise the service; a log line must not
    // carry a usable identifier.
    expect(ADOPTION).toContain("safeResourceId");
    expect(ADOPTION).not.toMatch(/safeServiceIds: \[association\.messagingServiceSid\]/);
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
    expect(ADOPTION).toMatch(/requiredInboundWebhookUrl: string;/);
    expect(ADOPTION).not.toMatch(/messagingServiceSid\s*(\?\?|\|\|)\s*/);
  });
});

describe("both new provider methods are READ-ONLY", () => {
  for (const method of ["lookupOwnedNumber", "readMessagingServiceConfig"]) {
    it(`${method} issues no write verb`, () => {
      const start = TWILIO_ADAPTER.indexOf(`async ${method}(`);
      expect(start, `${method} not found`).toBeGreaterThan(-1);
      const end = TWILIO_ADAPTER.indexOf("\n  async ", start + 10);
      const body = TWILIO_ADAPTER.slice(start, end === -1 ? TWILIO_ADAPTER.length : end);
      for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(body, `${method} issues a ${verb}`).not.toContain(`"${verb}"`);
      }
      expect((body.match(/method: "GET"/g) ?? []).length).toBeGreaterThanOrEqual(1);
    });
  }

  it("the census never claims absence from an incomplete walk", () => {
    const start = TWILIO_ADAPTER.indexOf("async lookupOwnedNumber(");
    const end = TWILIO_ADAPTER.indexOf("\n  async ", start + 10);
    const body = TWILIO_ADAPTER.slice(start, end);
    // Every early exit from the walk is `unavailable`, never `not_associated`.
    expect(body).not.toContain('kind: "not_associated"');
    for (const reason of [
      "service_page_limit",
      "service_page_unreadable",
      "service_pagination_unreadable",
      "membership_probe_failed",
    ]) {
      expect(body, `missing fail-closed reason ${reason}`).toContain(reason);
    }
    // Only an EXPLICIT null ends the walk.
    expect(body).toMatch(/cursor === null/);
  });
});

describe("the fence classification stays total", () => {
  it("the new read is classified as claim-scoped, not left unfenced", () => {
    for (const read of ["lookupOwnedNumber", "readMessagingServiceConfig"]) {
      expect([...CLAIM_SCOPED_READS]).toContain(read);
      expect([...BILLABLE_OR_MUTATING_EFFECTS]).not.toContain(read);
    }
  });

  it("every port method is classified — adding one breaks tsc, this catches drift", () => {
    const types = read("lib/sms/provider/types.ts");
    const portStart = types.indexOf("export interface SmsProvisioningProvider");
    const port = types.slice(portStart, types.indexOf("\n}", portStart));
    const methods = [...port.matchAll(/^\s{2}([a-zA-Z]+)\(/gm)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThanOrEqual(11);
    const classified = new Set<string>([
      ...BILLABLE_OR_MUTATING_EFFECTS,
      ...CLAIM_SCOPED_READS,
      "searchAvailableNumbers",
    ]);
    expect(methods.filter((m) => !classified.has(m))).toEqual([]);
  });
});
