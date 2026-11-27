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

// THE CONTRACT CHANGED, AND IT GOT STRONGER.
//
// "configuration never calls finalize" held until the reviewed race forced the
// reservation: closing it needs 0191's finalize as the ATOMIC binding
// primitive, because no number of reads can cover the gap between the last read
// and the write. So configuration may call finalize exactly ONCE, and only ever
// with testOk: false -- which records identifiers, leaves the row
// `provisioning`, and asserts no provider test. It may never activate.
describe("configuration reserves, and never activates", () => {
  it("calls finalize exactly once", () => {
    const calls = CONFIGURE.match(/store\.finalize\(/g) ?? [];
    expect(calls.length, "more than one finalize in the source").toBe(1);
  });

  it("passes testOk: false, and never true", () => {
    expect(CONFIGURE).toContain("testOk: false");
    expect(CONFIGURE, "an activation slipped in").not.toContain("testOk: true");
    // Anti-vacuity: a renamed or computed flag would evade the literal above.
    expect(CONFIGURE.match(/testOk:/g)?.length ?? 0).toBe(1);
  });

  it("the reservation precedes the configuration read and every write", () => {
    const reserve = CONFIGURE.indexOf("store.finalize(");
    const read = CONFIGURE.indexOf("readMessagingServiceConfig", reserve);
    const write = CONFIGURE.indexOf("configureInboundWebhook");
    expect(reserve).toBeGreaterThan(-1);
    expect(reserve, "read another studio's configuration before winning it").toBeLessThan(read);
    expect(reserve, "wrote before reserving").toBeLessThan(write);
  });

  it("no non-success finalizer verdict becomes permission to configure", () => {
    // Every branch of the adjudication must terminate rather than fall through.
    for (const verdict of ["already_active", "lease_lost", "conflict"]) {
      expect(CONFIGURE, `${verdict} is not adjudicated`).toContain(`case "${verdict}"`);
    }
    expect(CONFIGURE).toContain('case "provisioned_untested"');
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

// OWNER DECISION P2-1. The claim is the line between looking and acting, and
// this proves it in the SOURCE: the inspect function body must contain no
// claim, no lease renewal, and no park. A behavioural test can only show that
// today's inspect took no claim; this shows the code cannot.
describe("inspect is a read — the source cannot claim", () => {
  const inspectBody = (() => {
    const start = CONFIGURE.indexOf("async function inspectOnly");
    const end = CONFIGURE.indexOf("async function configureUnderClaim");
    expect(start, "inspectOnly not found").toBeGreaterThan(-1);
    expect(end, "configureUnderClaim not found").toBeGreaterThan(start);
    return CONFIGURE.slice(start, end);
  })();

  it("the slice is real, not an empty string that would pass vacuously", () => {
    expect(inspectBody.length).toBeGreaterThan(200);
    expect(inspectBody).toContain("readOwnerAuthority");
  });

  for (const forbidden of ["store.claim", "renewLease", "store.fail", "fenceProviderMutations"]) {
    it(`inspect never reaches ${forbidden}`, () => {
      expect(inspectBody, `inspect reached ${forbidden}`).not.toContain(forbidden);
    });
  }

  it("inspect performs no configuration write", () => {
    expect(inspectBody).not.toContain("configureInboundWebhook");
    expect(inspectBody).not.toContain("configureStatusCallback");
  });

  it("the configure path DOES claim — the line exists in both directions", () => {
    const configureBody = CONFIGURE.slice(CONFIGURE.indexOf("async function configureUnderClaim"));
    expect(configureBody).toContain("store.claim");
    expect(configureBody).toContain("fenceProviderMutations");
  });
});

// CODEX P2-2. The lexical inspect slice below is defence-in-depth for DIRECT
// calls. It cannot see inside `proveOwnershipAndAssociation`, which inspect
// delegates its provider work to -- and the whole-module guard cannot help,
// because configure legitimately uses the two configuration methods. So the
// real guarantee is a TYPE: the helper accepts only a narrowed read capability,
// and a mutating call inside it fails `tsc` rather than a regex.
describe("inspect's provider capability is narrowed by type, not by regex", () => {
  it("the read-only capability names ONLY the two approved reads", () => {
    const pick = CONFIGURE.slice(
      CONFIGURE.indexOf("export type InspectionReads"),
      CONFIGURE.indexOf(">;", CONFIGURE.indexOf("export type InspectionReads")) + 2,
    );
    expect(pick, "InspectionReads not found").toContain("Pick<");
    expect(pick).toContain("lookupOwnedNumber");
    expect(pick).toContain("readMessagingServiceConfig");
    // Anti-vacuity: the Pick must not have quietly widened to the whole port.
    for (const mutating of BILLABLE_OR_MUTATING_EFFECTS) {
      expect(pick, `InspectionReads exposes ${mutating}`).not.toContain(mutating);
    }
  });

  it("the shared helper accepts the narrowed capability, not the full provider", () => {
    const sig = CONFIGURE.slice(
      CONFIGURE.indexOf("async function proveOwnershipAndAssociation"),
      CONFIGURE.indexOf("): Promise<Proof>"),
    );
    expect(sig).toContain("provider: InspectionReads");
    expect(sig, "helper still takes the full provider").not.toContain(
      "provider: SmsProvisioningProvider",
    );
  });

  it("inspect reaches the provider ONLY through the narrowed handle", () => {
    const start = CONFIGURE.indexOf("async function inspectOnly");
    const end = CONFIGURE.indexOf("async function configureUnderClaim");
    const body = CONFIGURE.slice(start, end);
    expect(body).toContain("const reads: InspectionReads = input.provider;");
    // Exactly one mention: the narrowing itself. Any further `input.provider.`
    // would be an un-narrowed reach.
    expect(body.match(/input\.provider/g)?.length ?? 0).toBe(1);
  });
});

// CODEX P2. The mutating path must be reachable ONLY from an exact
// `mode === "configure"`. A guard on the dispatch shape, because the type
// system cannot speak for a runtime value arriving from an unvalidated caller.
describe("the mutating path is entered only on an exact mode match", () => {
  const dispatch = CONFIGURE.slice(
    CONFIGURE.indexOf('if (input.mode === "inspect")'),
    CONFIGURE.indexOf("async function inspectOnly"),
  );

  it("the dispatch slice is real, not empty", () => {
    expect(dispatch.length).toBeGreaterThan(80);
    expect(dispatch).toContain("configureUnderClaim");
  });

  it("configureUnderClaim is guarded by an explicit equality on \"configure\"", () => {
    expect(dispatch).toContain('if (input.mode === "configure")');
    const guard = dispatch.indexOf('if (input.mode === "configure")');
    const call = dispatch.indexOf("configureUnderClaim(");
    expect(guard, "the mutation is not behind an explicit configure check").toBeLessThan(call);
  });

  it("there is a fail-closed terminal branch, so no value falls through", () => {
    expect(dispatch).toContain("unknownMode()");
    // The mutation must NOT be the last unguarded statement any more.
    const lastCall = dispatch.lastIndexOf("configureUnderClaim(");
    const fallback = dispatch.lastIndexOf("unknownMode()");
    expect(fallback, "the fall-through still lands on the mutation").toBeGreaterThan(lastCall);
  });

  it("the fail-closed answer claims nothing", () => {
    const fn = CONFIGURE.slice(
      CONFIGURE.indexOf("function unknownMode()"),
      CONFIGURE.indexOf("export async function configureExistingStudioSmsSender"),
    );
    expect(fn).toContain("claimsTaken: 0");
    expect(fn).toContain("providerWrites: 0");
    expect(fn).not.toContain("store.claim");
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
