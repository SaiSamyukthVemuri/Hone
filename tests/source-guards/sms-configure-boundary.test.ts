import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BILLABLE_OR_MUTATING_EFFECTS } from "@/lib/sms/provider/fenced";

// CONFIGURE AN EXISTING SENDER — the boundary guard.
//
// The behavioural suite proves the fake was never asked to purchase, create,
// attach, send or finalize. This proves the SOURCE cannot ask, which is the
// stronger and cheaper statement: a future edit that widens this capability
// fails here rather than on a live account, on someone's invoice, or in a
// client's message thread.
//
// The companion guard `sms-adoption-boundary` forbids adoption from performing
// the two configuration writes. This one is its mirror: configuration may
// perform ONLY those two, and nothing else. Between them, neither module can
// drift into being the other.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments explain the rules; they must never satisfy them. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const CONFIGURE = codeOnly(read("lib/sms/configure-existing-sender.ts"));

describe("configuration may change ONLY the two webhook limbs", () => {
  /**
   * Derived from the fence's own list rather than retyped, so a new
   * externally-mutating effect added to the port is forbidden here the moment
   * it exists — not whenever someone remembers to update this array.
   */
  const ALLOWED = new Set(["configureInboundWebhook", "configureStatusCallback"]);
  const FORBIDDEN = BILLABLE_OR_MUTATING_EFFECTS.filter((e) => !ALLOWED.has(e));

  for (const effect of FORBIDDEN) {
    it(`never calls ${effect}`, () => {
      expect(CONFIGURE, `configuration references ${effect}`).not.toContain(effect);
    });
  }

  it("the forbidden list actually covers the dangerous effects", () => {
    // Anti-vacuity: if ALLOWED ever swallowed the whole port, every test above
    // would pass while guaranteeing nothing.
    expect(FORBIDDEN).toContain("purchaseNumber");
    expect(FORBIDDEN).toContain("createMessagingService");
    expect(FORBIDDEN).toContain("attachNumberToService");
    expect(FORBIDDEN).toContain("sendProvisioningTest");
  });
});

describe("configuration never activates a sender", () => {
  it("does not call finalize — activation belongs to adoption alone", () => {
    expect(CONFIGURE, "configuration reached finalize").not.toContain(".finalize(");
  });

  it("never asks for testOk, the flag that turns a row active", () => {
    expect(CONFIGURE).not.toContain("testOk");
  });
});

describe("configuration proves before it writes", () => {
  it("reads the service configuration before any write", () => {
    const firstRead = CONFIGURE.indexOf("readMessagingServiceConfig");
    const firstWrite = CONFIGURE.indexOf("configureInboundWebhook");
    expect(firstRead).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(-1);
    expect(firstRead, "wrote before reading the current configuration").toBeLessThan(firstWrite);
  });

  it("proves ownership and association before any write", () => {
    const firstProve = CONFIGURE.indexOf("lookupOwnedNumber");
    const firstWrite = CONFIGURE.indexOf("configureInboundWebhook");
    expect(firstProve).toBeGreaterThan(-1);
    expect(firstProve, "wrote before proving the number is ours").toBeLessThan(firstWrite);
  });

  it("re-reads the provider AFTER writing, rather than trusting the ack", () => {
    const lastWrite = CONFIGURE.lastIndexOf("configureStatusCallback");
    const lastRead = CONFIGURE.lastIndexOf("readMessagingServiceConfig");
    expect(lastRead, "no verification read follows the writes").toBeGreaterThan(lastWrite);
  });

  it("fences every provider call by construction", () => {
    expect(CONFIGURE).toContain("fenceProviderMutations");
    // The unfenced provider must never be reachable from the write path.
    expect(CONFIGURE).not.toContain("input.provider.configure");
  });
});

describe("configuration derives authority from the database", () => {
  it("claims, so membership and owner role are re-derived server-side", () => {
    expect(CONFIGURE).toContain("store.claim");
  });

  it("never accepts a caller-supplied role", () => {
    expect(CONFIGURE).not.toContain("isOwner");
    expect(CONFIGURE).not.toContain("role:");
  });
});
