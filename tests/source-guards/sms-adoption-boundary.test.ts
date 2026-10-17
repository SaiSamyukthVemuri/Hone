import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BILLABLE_OR_MUTATING_EFFECTS, CLAIM_SCOPED_READS } from "@/lib/sms/provider/fenced";
import { PROVIDER_ERROR_CODES } from "@/lib/sms/provider/types";
import { REFUSAL_TO_STORE_CODE } from "@/lib/sms/adoption";

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

const ADOPTION_RAW = read("lib/sms/adoption.ts");
const ADOPTION = codeOnly(ADOPTION_RAW);
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
    // SUPERSEDED LIST, SAME PROPERTY. `service_page_unreadable` and
    // `membership_probe_failed` are gone on purpose: they represented HTTP
    // failures, which now keep their own provider classification instead of
    // being flattened into a retryable census gap. What remains are the genuine
    // 200-but-incomplete cases, and those must still fail closed.
    for (const reason of [
      "service_page_limit",
      "service_page_unparseable",
      "service_pagination_unreadable",
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

describe("CODEX P2-B — the refusal mapping is total by construction", () => {
  it("every AdoptionRefusal member in the SOURCE has a mapping entry", () => {
    // Read the union out of the source rather than importing it: a type cannot
    // be enumerated at runtime, and a hand-kept list is the thing that drifted.
    const start = ADOPTION_RAW.indexOf("export type AdoptionRefusal =");
    const block = ADOPTION_RAW.slice(start, ADOPTION_RAW.indexOf(";", start));
    const members = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(members.length).toBeGreaterThanOrEqual(8);

    const mapped = Object.keys(REFUSAL_TO_STORE_CODE);
    expect(members.filter((m) => !mapped.includes(m)), "unmapped refusal").toEqual([]);
    expect(mapped.filter((m) => !members.includes(m)), "stale mapping entry").toEqual([]);
  });

  it("every mapped value is vocabulary 0191 actually accepts", () => {
    const valid = new Set<string>([
      ...PROVIDER_ERROR_CODES,
      "finalize_failed",
      "finalize_conflict",
      "lease_lost",
    ]);
    for (const [refusal, code] of Object.entries(REFUSAL_TO_STORE_CODE)) {
      expect(valid.has(code), `${refusal} -> ${code}`).toBe(true);
    }
  });

  it("A SYNTHETIC UNMAPPED MEMBER IS CAUGHT — the guard is not vacuous", () => {
    // Simulate the future edit this exists to catch: a new member added to the
    // union with no mapping entry. The check above must reject it.
    const members = [...Object.keys(REFUSAL_TO_STORE_CODE), "number_some_future_refusal"];
    const mapped = Object.keys(REFUSAL_TO_STORE_CODE);
    expect(members.filter((m) => !mapped.includes(m))).toEqual(["number_some_future_refusal"]);
  });

  it("no adoption-only string can reach the store", () => {
    // The single call site must go through the map.
    expect(ADOPTION).toMatch(/errorCode: storeCodeFor\(reason\)/);
    expect(ADOPTION).not.toMatch(/errorCode: reason\b/);
  });
});

describe("CODEX P2-A — activation evidence names the adopted number", () => {
  it("the sender is compared to the canonical number, not assumed", () => {
    expect(ADOPTION).toMatch(/test\.sentFrom !== phoneNumber/);
    expect(ADOPTION).toContain("provider_test_sender_mismatch");
  });

  it("the comparison happens BEFORE the activating finalize", () => {
    const cmpAt = ADOPTION.indexOf("test.sentFrom !== phoneNumber");
    const okAt = ADOPTION.indexOf("testOk: true");
    expect(cmpAt).toBeGreaterThan(-1);
    expect(cmpAt).toBeLessThan(okAt);
  });

  it("a mismatch records the identifiers WITHOUT activating", () => {
    // Search FROM the comparison: `provider_test_sender_mismatch` also appears
    // in the type union near the top of the file, and slicing to that earlier
    // occurrence produced an empty window that would have passed anything.
    const at = ADOPTION.indexOf("test.sentFrom !== phoneNumber");
    const branch = ADOPTION.slice(
      at,
      ADOPTION.indexOf("provider_test_sender_mismatch", at),
    );
    expect(branch.length).toBeGreaterThan(50);
    expect(branch).toContain("testOk: false");
  });

  it("the adapter reads the sender off the message it already created", () => {
    // No second send, and no second provider call, for the proof.
    expect(TWILIO_ADAPTER).toMatch(/sentFrom: asE164\(rec\?\.from\)/);
  });
});

describe("CODEX P2 — the parking verdict travels with the failure", () => {
  it("adoption reports parked and parkResult, mirroring the purchase path", () => {
    expect(ADOPTION).toMatch(/parked: parked === "failed"/);
    expect(ADOPTION).toMatch(/parkResult: parked/);
  });

  it("the contract matches provisionStudioSmsSender's, field for field", () => {
    // Not a second model. If the purchase path's shape changes, this fails and
    // someone has to decide deliberately rather than letting the two drift.
    const purchase = read("lib/sms/provisioning.ts");
    for (const field of ["parked: boolean;", "parkResult: FailResult;"]) {
      expect(purchase, `purchase lost ${field}`).toContain(field);
      expect(ADOPTION_RAW, `adoption missing ${field}`).toContain(field);
    }
  });

  it("no failure outcome is built without the verdict", () => {
    // Every CONSTRUCTION of a failed outcome must be the one that carries
    // parked/parkResult. Matched with a trailing comma so the type declaration
    // (`result: "failed";`) is not counted as a construction — an earlier form
    // of this counted both and reported two.
    const constructions = [...ADOPTION.matchAll(/result: "failed",/g)];
    expect(constructions.length).toBe(1);
    const declarations = [...ADOPTION.matchAll(/result: "failed";/g)];
    expect(declarations.length).toBe(1);
  });

  it("an unacknowledged park is never silently retried away", () => {
    // The two terminal database truths still outrank the failure story, and
    // they are checked BEFORE the verdict is reported.
    const fw = ADOPTION.slice(ADOPTION.indexOf("const failWith"));
    const leaseAt = fw.indexOf('parked === "lease_lost"');
    const activeAt = fw.indexOf('parked === "already_active"');
    const failedAt = fw.indexOf('result: "failed"');
    expect(leaseAt).toBeGreaterThan(-1);
    expect(activeAt).toBeGreaterThan(leaseAt);
    expect(failedAt).toBeGreaterThan(activeAt);
  });
});

describe("the failure contract matches the purchase path field-for-field", () => {
  it("adoption carries every verdict field provisionStudioSmsSender does", () => {
    // Three of adoption's four review findings were a branch the purchase path
    // already had. This asserts the SHAPES stay aligned, so the next divergence
    // fails here rather than waiting for a reviewer to notice.
    const purchase = read("lib/sms/provisioning.ts");
    for (const field of [
      "parked: boolean;",
      "parkResult: FailResult;",
      "identifiersRecorded: boolean;",
      "identifierResult: FinalizeResult | null;",
    ]) {
      expect(purchase, `purchase lost ${field}`).toContain(field);
      expect(ADOPTION_RAW, `adoption missing ${field}`).toContain(field);
    }
  });

  it("identifiersRecorded is derived from the WRITE's verdict, never asserted", () => {
    // True is claimed only on a database acknowledgement.
    expect(ADOPTION).toMatch(/detail\.identifierResult === "activated"/);
    expect(ADOPTION).not.toMatch(/identifiersRecorded: true\b/);
  });

  it("every finalize-then-fail path forwards its verdict", () => {
    // Each finalize whose result is followed by a failure must pass it on.
    for (const forwarded of [
      "identifierResult: parked }",
      "identifierResult: parkedIdentifiers,",
      "identifierResult: finalized }",
    ]) {
      expect(ADOPTION, `unforwarded verdict: ${forwarded}`).toContain(forwarded);
    }
  });
});

describe("census failures keep their provider classification", () => {
  it("the page walk returns transport errors and classifies non-200 via httpError", () => {
    expect(TWILIO_ADAPTER).toMatch(/if \(!page\.ok\) return page;/);
    expect(TWILIO_ADAPTER).toMatch(/if \(page\.status !== 200\) return httpError\(page\.status\);/);
  });

  it("the membership probe does the same, and 404 keeps its documented meaning", () => {
    expect(TWILIO_ADAPTER).toMatch(/if \(!probe\.ok\) return probe;/);
    expect(TWILIO_ADAPTER).toMatch(/probe\.status !== 404/);
    expect(TWILIO_ADAPTER).toMatch(/return httpError\(probe\.status\);/);
  });

  it("no HTTP failure is laundered into an unavailable census", () => {
    // The reasons that remain are all genuine 200-but-incomplete cases.
    const start = TWILIO_ADAPTER.indexOf("async lookupOwnedNumber(");
    const body = TWILIO_ADAPTER.slice(start, TWILIO_ADAPTER.indexOf("\n  async ", start + 10));
    for (const gone of ["service_page_unreadable", "membership_probe_failed", "membership_probe_unexpected"]) {
      expect(body, `${gone} still launders an HTTP failure`).not.toContain(gone);
    }
    for (const kept of ["service_page_limit", "service_page_unparseable", "service_pagination_unreadable"]) {
      expect(body, `lost genuine census gap ${kept}`).toContain(kept);
    }
  });
});
