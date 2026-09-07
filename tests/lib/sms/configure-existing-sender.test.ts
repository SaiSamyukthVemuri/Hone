import { beforeEach, describe, expect, it } from "vitest";
import { configureExistingStudioSmsSender } from "@/lib/sms/configure-existing-sender";
import {
  FakeSmsProvisioningProvider,
  type FakeProviderScript,
} from "@/lib/sms/provider/fake-provider";
import {
  InMemoryProvisioningStore,
  type Membership,
} from "./helpers/in-memory-provisioning-store";

// CONFIGURE AN EXISTING STUDIO-OWNED SENDER.
//
// The property under test is NARROWNESS. Adoption ends at
// `provider_configuration_required` because rewriting a service Hone does not
// own is a decision, not a repair. This capability makes that decision
// executable — and the entire safety case is that it can do almost nothing.
//
// The most valuable assertions here are NEGATIVE and they are asserted in every
// single test: no purchase, no service creation, no attach, no test send, no
// finalize. Everything else could be right and any one of those could still be
// wrong, and each would be either irreversible, billable, or a live SMS.
//
// The second most valuable is the WRITE COUNT. "Only the limbs that differ" is
// not a comment, it is a number, and it is checked on every path.

const STUDIO_A = "studio-a";
const OWNER_A = "user-owner-a";
const STAFF_A = "user-staff-a";

const WILLOW_NUMBER = "+14165550100";
const WILLOW_PN_SID = "PN" + "a".repeat(32);
const WILLOW_MG_SID = "MG" + "b".repeat(32);
const OTHER_MG_SID = "MG" + "c".repeat(32);

const INBOUND = "https://hone.care/api/twilio/inbound-sms";
const STATUS = "https://hone.care/api/twilio/message-status";
const STALE_INBOUND = "https://example.invalid/legacy-inbound";
const STALE_STATUS = "https://example.invalid/legacy-status";

const MEMBERS: Membership[] = [
  { userId: OWNER_A, studioId: STUDIO_A, role: "owner" },
  { userId: STAFF_A, studioId: STUDIO_A, role: "practitioner" },
];

let provider: FakeSmsProvisioningProvider;
let store: InMemoryProvisioningStore;

/** Owned, in the expected service, with whatever configuration is scripted. */
function owned(inboundUrl: string | null, statusUrl: string | null): FakeProviderScript {
  return {
    preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
    accountServices: [
      { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl, statusUrl },
    ],
  };
}

function configure(
  over: Partial<Parameters<typeof configureExistingStudioSmsSender>[0]> = {},
) {
  return configureExistingStudioSmsSender({
    store,
    authority: store,
    bindings: store,
    provider,
    studioId: STUDIO_A,
    actorUserId: OWNER_A,
    country: "CA",
    phoneNumber: WILLOW_NUMBER,
    messagingServiceSid: WILLOW_MG_SID,
    requiredInboundWebhookUrl: INBOUND,
    requiredStatusCallbackUrl: STATUS,
    mode: "configure",
    ...over,
  });
}

/**
 * THE STANDING NEGATIVE. Every effect this capability is forbidden to perform,
 * asserted after every single case regardless of what it was testing.
 */
function expectNoForbiddenEffects() {
  expect(provider.calls.purchase, "purchased a number").toBe(0);
  expect(provider.calls.createService, "created a messaging service").toBe(0);
  expect(provider.calls.attach, "attached/detached a number").toBe(0);
  expect(provider.calls.testSend, "sent a provisioning SMS").toBe(0);
  expect(provider.calls.search, "searched purchasable numbers").toBe(0);
  expect(provider.calls.availability, "checked purchasable availability").toBe(0);
  expect(store.finalizeCalls, "finalized / activated a sender").toBe(0);
}

/** Total provider CONFIGURATION writes actually issued. */
function writes() {
  return provider.calls.inboundWebhook + provider.calls.statusCallback;
}

beforeEach(() => {
  store = new InMemoryProvisioningStore(MEMBERS);
  provider = new FakeSmsProvisioningProvider();
});

describe("configure existing sender — idempotency", () => {
  it("1. already correct -> ALREADY_CONFIGURED with ZERO writes", async () => {
    provider.script = owned(INBOUND, STATUS);

    const out = await configure();

    expect(out).toMatchObject({ ok: true, result: "already_configured", providerWrites: 0 });
    expect(writes()).toBe(0);
    expectNoForbiddenEffects();
  });

  it("11. retrying after a successful correction performs ZERO further writes", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const first = await configure();
    expect(first).toMatchObject({ ok: true, result: "configured", providerWrites: 2 });
    const afterFirst = writes();
    expect(afterFirst).toBe(2);

    // The operator presses it again later, once the lease has lapsed. The
    // provider is already correct, so the second run must be a pure read.
    store.now += 10 * 60_000;
    const second = await configure();

    expect(second).toMatchObject({ ok: true, result: "already_configured", providerWrites: 0 });
    expect(writes(), "a retry wrote again").toBe(afterFirst);
    expectNoForbiddenEffects();
  });

  it("inspection reports the mismatch and writes NOTHING", async () => {
    provider.script = owned(STALE_INBOUND, STATUS);

    const out = await configure({ mode: "inspect" });

    expect(out).toMatchObject({
      ok: true,
      result: "inspected",
      matches: false,
      mismatched: ["inbound_webhook"],
      providerWrites: 0,
    });
    expect(writes()).toBe(0);
    expectNoForbiddenEffects();
  });
});

// ---------------------------------------------------------------------------
// OWNER DECISION P2-1 — inspect is a READ, and the claim is the line.
//
// Looking at provider truth must not mint durable provisioning ownership, take
// a lease, or block the mutation the operator is about to perform. An earlier
// version claimed in both modes, so merely opening the page created five
// minutes of state and answered the follow-up configure with `claim_held`.
// ---------------------------------------------------------------------------
describe("inspect creates no durable provisioning state", () => {
  it("1. inspect takes ZERO claims", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const out = await configure({ mode: "inspect" });

    expect(out).toMatchObject({ ok: true, result: "inspected", claimsTaken: 0 });
    expect(store.claimCalls, "inspect acquired a provisioning claim").toBe(0);
    // Authority was still enforced — it was READ, not taken.
    expect(store.authorityCalls).toBe(1);
  });

  it("2. inspect performs ZERO provider writes", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    await configure({ mode: "inspect" });

    expect(writes()).toBe(0);
    expectNoForbiddenEffects();
  });

  it("3. repeated inspection leaves ZERO durable state behind", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    await configure({ mode: "inspect" });
    await configure({ mode: "inspect" });
    await configure({ mode: "inspect" });

    expect(store.claimCalls).toBe(0);
    expect(store.rows, "an inspection created an attempt row").toEqual([]);
    expect(store.fenceCalls, "an inspection touched a lease").toEqual([]);
    expect(writes()).toBe(0);
  });

  it("4. an unauthorized inspection is refused, and reads no provider truth", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const out = await configure({ mode: "inspect", actorUserId: STAFF_A });

    expect(out).toMatchObject({ ok: false, result: "refused", reason: "not_owner" });
    expect(provider.calls.ownedLookup, "read the provider before proving authority").toBe(0);
    expect(store.claimCalls).toBe(0);
  });

  it("an UNREADABLE authority table fails closed — never 'not owner'", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);
    store.authorityUnavailable = true;

    const out = await configure({ mode: "inspect" });

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "authority_unavailable",
      retryable: true,
    });
    expect(provider.calls.ownedLookup).toBe(0);
    expect(store.claimCalls).toBe(0);
  });

  it("inspect fails closed on an ambiguous association, taking no claim", async () => {
    provider.script = {
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: STALE_INBOUND, statusUrl: null },
        { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: null, statusUrl: null },
      ],
    };

    const out = await configure({ mode: "inspect" });

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_association_ambiguous",
    });
    expect(store.claimCalls).toBe(0);
    expect(writes()).toBe(0);
  });

  it("inspect fails closed on an unavailable census, taking no claim", async () => {
    // A page that returns 200 with a body we cannot read: the census has a GAP,
    // and an incomplete census is not absence.
    provider.script = { ...owned(STALE_INBOUND, STALE_STATUS), unparseableServicePage: 1 };

    const out = await configure({ mode: "inspect" });

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_association_unavailable",
      retryable: true,
    });
    expect(store.claimCalls).toBe(0);
    expect(writes()).toBe(0);
  });

  it("inspect fails closed when the census call itself FAILS, taking no claim", async () => {
    // Distinct from the gap above: the request did not succeed at all. #676
    // keeps the provider's own classification rather than flattening it into a
    // census verdict, and either way inspect must refuse and claim nothing.
    provider.script = { ...owned(STALE_INBOUND, STALE_STATUS), failServicePage: 1 };

    const out = await configure({ mode: "inspect" });

    expect(out).toMatchObject({ ok: false, result: "refused", retryable: true });
    if (!out.ok && out.result === "refused") {
      expect(out.reason).toBe("provider_unavailable");
    }
    expect(store.claimCalls).toBe(0);
    expect(writes()).toBe(0);
  });
});

describe("configure never trusts an inspection", () => {
  it("5. the claim and its fence precede the FIRST provider write", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const out = await configure();

    expect(out).toMatchObject({ ok: true, result: "configured" });
    expect(store.claimCalls, "wrote without claiming").toBe(1);
    // The fence was consulted before every provider call, writes included.
    expect(store.fenceCalls.length).toBeGreaterThanOrEqual(writes());
    expect(store.fenceCalls.every((f) => f.granted)).toBe(true);
  });

  it("6. configure re-derives everything itself — an inspection is not reused", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    await configure({ mode: "inspect" });
    const readsAfterInspect = provider.calls.ownedLookup;
    const configReadsAfterInspect = provider.calls.serviceConfigRead;

    await configure();

    // Configure performed its OWN ownership and configuration reads rather
    // than carrying the inspection's answers forward.
    expect(provider.calls.ownedLookup).toBeGreaterThan(readsAfterInspect);
    expect(provider.calls.serviceConfigRead).toBeGreaterThan(configReadsAfterInspect);
  });

  it("7. an association that MOVES after inspection is caught by configure", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const seen = await configure({ mode: "inspect" });
    expect(seen).toMatchObject({ ok: true, result: "inspected", matches: false });

    // Between looking and acting, the number is moved to another service.
    provider.script = {
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [], inboundUrl: STALE_INBOUND, statusUrl: STALE_STATUS },
        { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: null, statusUrl: null },
      ],
    };

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_in_other_service",
      providerWrites: 0,
    });
    expect(writes(), "wrote on the strength of a stale inspection").toBe(0);
    expectNoForbiddenEffects();
  });

  it("8. configuration that CHANGES after inspection is recomputed, not replayed", async () => {
    // Inspection sees BOTH limbs wrong.
    provider.script = owned(STALE_INBOUND, STALE_STATUS);
    const seen = await configure({ mode: "inspect" });
    expect(seen).toMatchObject({ mismatched: ["inbound_webhook", "status_callback"] });

    // Someone fixes the inbound limb in the console before configure runs.
    provider.script = owned(INBOUND, STALE_STATUS);

    const out = await configure();

    // The minimal mutation is recomputed from fresh truth: ONE write, not two.
    expect(out).toMatchObject({
      ok: true,
      result: "configured",
      changed: ["status_callback"],
      providerWrites: 1,
    });
    expect(provider.calls.inboundWebhook, "replayed a stale mismatch").toBe(0);
    expect(provider.calls.statusCallback).toBe(1);
  });

  it("9. a lost/stale claim performs ZERO provider writes", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);
    store.denyRenew = true;

    const out = await configure();

    expect(out).toMatchObject({ ok: false, result: "lease_lost" });
    expect(writes(), "a displaced worker wrote").toBe(0);
    expectNoForbiddenEffects();
  });
});

describe("configure existing sender — exactly the limbs that differ", () => {
  it("2. inbound-only mismatch -> exactly ONE write, the inbound one", async () => {
    provider.script = owned(STALE_INBOUND, STATUS);

    const out = await configure();

    expect(out).toMatchObject({
      ok: true,
      result: "configured",
      changed: ["inbound_webhook"],
      providerWrites: 1,
    });
    expect(provider.calls.inboundWebhook).toBe(1);
    expect(provider.calls.statusCallback, "rewrote a limb that already matched").toBe(0);
    expectNoForbiddenEffects();
  });

  it("3. callback-only mismatch -> exactly ONE write, the callback one", async () => {
    provider.script = owned(INBOUND, STALE_STATUS);

    const out = await configure();

    expect(out).toMatchObject({
      ok: true,
      result: "configured",
      changed: ["status_callback"],
      providerWrites: 1,
    });
    expect(provider.calls.statusCallback).toBe(1);
    expect(provider.calls.inboundWebhook, "rewrote a limb that already matched").toBe(0);
    expectNoForbiddenEffects();
  });

  it("4. both mismatch -> exactly TWO writes, one per limb", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const out = await configure();

    expect(out).toMatchObject({
      ok: true,
      result: "configured",
      changed: ["inbound_webhook", "status_callback"],
      providerWrites: 2,
    });
    expect(provider.calls.inboundWebhook).toBe(1);
    expect(provider.calls.statusCallback).toBe(1);
    expectNoForbiddenEffects();
  });

  it("10. a successful correction is VERIFIED against the provider, not assumed", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const out = await configure();
    expect(out).toMatchObject({ ok: true, result: "configured" });

    // The authority is the provider, read back.
    const after = await provider.readMessagingServiceConfig({
      messagingServiceSid: WILLOW_MG_SID,
    });
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.config.inboundRequestUrl).toBe(INBOUND);
      expect(after.config.statusCallbackUrl).toBe(STATUS);
    }
    expectNoForbiddenEffects();
  });
});

describe("configure existing sender — refuses before writing", () => {
  it("5. the number is in ANOTHER service -> ZERO writes", async () => {
    provider.script = {
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [], inboundUrl: STALE_INBOUND, statusUrl: STALE_STATUS },
        { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: null, statusUrl: null },
      ],
    };

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_in_other_service",
      providerWrites: 0,
    });
    expect(writes()).toBe(0);
    expectNoForbiddenEffects();
  });

  it("the number is in NO service -> ZERO writes (attaching is not ours to do)", async () => {
    provider.script = {
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [], inboundUrl: STALE_INBOUND, statusUrl: STALE_STATUS },
      ],
    };

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_not_in_named_service",
      providerWrites: 0,
    });
    expect(writes()).toBe(0);
    expectNoForbiddenEffects();
  });

  it("an AMBIGUOUS association -> ZERO writes, and never a guess", async () => {
    provider.script = {
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: STALE_INBOUND, statusUrl: null },
        { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: null, statusUrl: null },
      ],
    };

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_association_ambiguous",
      providerWrites: 0,
    });
    expect(writes()).toBe(0);
    expectNoForbiddenEffects();
  });

  it("6. an UNAVAILABLE census -> ZERO writes, and it is retryable", async () => {
    provider.script = {
      ...owned(STALE_INBOUND, STALE_STATUS),
      unparseableServicePage: 1,
    };

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_association_unavailable",
      retryable: true,
      providerWrites: 0,
    });
    expect(writes(), "wrote against an incomplete census").toBe(0);
    expectNoForbiddenEffects();
  });

  it("6b. a census call that FAILS outright -> ZERO writes, retryable", async () => {
    provider.script = { ...owned(STALE_INBOUND, STALE_STATUS), failServicePage: 1 };

    const out = await configure();

    expect(out).toMatchObject({ ok: false, result: "refused", retryable: true, providerWrites: 0 });
    expect(writes(), "wrote without a completed census").toBe(0);
    expectNoForbiddenEffects();
  });

  it("7. a MALFORMED provider resource in the census -> ZERO writes", async () => {
    provider.script = {
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: "not-a-messaging-service-sid", numbers: [WILLOW_NUMBER] },
        { sid: WILLOW_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: STALE_INBOUND, statusUrl: null },
      ],
    };

    const out = await configure();

    expect(out).toMatchObject({ ok: false, result: "refused", providerWrites: 0 });
    if (!out.ok && out.result === "refused") {
      expect(out.reason).toBe("number_association_unavailable");
    }
    expect(writes()).toBe(0);
    expectNoForbiddenEffects();
  });

  it("a MALFORMED target service identifier -> refused before the claim, ZERO writes", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const out = await configure({ messagingServiceSid: "MG-nope" });

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "invalid_service_identifier",
      providerWrites: 0,
    });
    expect(writes()).toBe(0);
    // Refused so early that no attempt was even claimed.
    expect(store.claimCalls).toBe(0);
    expectNoForbiddenEffects();
  });

  it("a number the ACCOUNT DOES NOT OWN -> ZERO writes", async () => {
    provider.script = {
      preOwnedNumbers: {},
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [], inboundUrl: STALE_INBOUND, statusUrl: null },
      ],
    };

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_not_owned_by_account",
      providerWrites: 0,
    });
    expect(writes()).toBe(0);
    expectNoForbiddenEffects();
  });
});

describe("configure existing sender — authority is the database's, never the caller's", () => {
  it("a non-owner member is refused, and performs ZERO provider effect", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const out = await configure({ actorUserId: STAFF_A });

    expect(out).toMatchObject({ ok: false, result: "refused", reason: "not_owner" });
    expect(writes()).toBe(0);
    expect(provider.calls.ownedLookup, "read the provider before proving authority").toBe(0);
    expectNoForbiddenEffects();
  });

  it("an ALREADY ACTIVE sender is refused — its webhooks are live traffic", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);
    store.forceActive(STUDIO_A, WILLOW_NUMBER);

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "sender_already_active",
      providerWrites: 0,
    });
    expect(writes()).toBe(0);
    expectNoForbiddenEffects();
  });
});

describe("configure existing sender — fails closed", () => {
  it("8. a provider WRITE FAILURE fails closed and is reported as a failure", async () => {
    provider.script = { ...owned(STALE_INBOUND, STALE_STATUS), webhookFails: "provider_timeout" };

    const out = await configure();

    expect(out.ok, "reported success after a failed write").toBe(false);
    if (!out.ok && (out.result === "refused" || out.result === "failed")) {
      expect(out.reason).toBe("provider_timeout");
      // The attempted write is COUNTED even though it failed: a timeout may
      // still have landed, and reporting zero would be a lie to the operator.
      expect(out.providerWrites).toBe(1);
    }
    expect(provider.calls.statusCallback, "kept writing after a failure").toBe(0);
    expectNoForbiddenEffects();
  });

  it("9. a write the provider ACKNOWLEDGES but does not apply fails closed", async () => {
    // The 2xx lie. This is the case that makes post-write verification
    // load-bearing rather than decorative.
    provider.script = {
      ...owned(STALE_INBOUND, STALE_STATUS),
      configureSilentlyDrops: true,
    };

    const out = await configure();

    expect(out.ok, "trusted the acknowledgement instead of re-reading").toBe(false);
    if (!out.ok && (out.result === "refused" || out.result === "failed")) {
      expect(out.reason).toBe("post_write_verification_failed");
      expect("mismatched" in out ? out.mismatched : undefined).toEqual([
        "inbound_webhook",
        "status_callback",
      ]);
    }
    expectNoForbiddenEffects();
  });

  it("an unreadable configuration read fails closed WITHOUT writing", async () => {
    provider.script = {
      ...owned(STALE_INBOUND, STALE_STATUS),
      serviceConfigFails: "provider_unavailable",
    };

    const out = await configure();

    expect(out.ok).toBe(false);
    expect(writes(), "wrote without knowing the current configuration").toBe(0);
    expectNoForbiddenEffects();
  });

  it("a lost lease stops the attempt and never writes", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);
    store.denyRenew = true;

    const out = await configure();

    expect(out).toMatchObject({ ok: false, result: "lease_lost" });
    expect(writes(), "a displaced worker wrote").toBe(0);
    expectNoForbiddenEffects();
  });
});

describe("configure existing sender — 12. the forbidden effects, stated once more", () => {
  it("no purchase, create, attach, send or finalize on ANY path", async () => {
    const scripts: FakeProviderScript[] = [
      owned(INBOUND, STATUS),
      owned(STALE_INBOUND, STALE_STATUS),
      owned(INBOUND, STALE_STATUS),
      { preOwnedNumbers: {}, accountServices: [] },
      { ...owned(STALE_INBOUND, null), unparseableServicePage: 1 },
      { ...owned(STALE_INBOUND, null), failServicePage: 1 },
      { ...owned(STALE_INBOUND, null), configureSilentlyDrops: true },
    ];

    for (const script of scripts) {
      store = new InMemoryProvisioningStore(MEMBERS);
      provider = new FakeSmsProvisioningProvider();
      provider.script = script;
      await configure();
      expectNoForbiddenEffects();
    }
  });
});

// ---------------------------------------------------------------------------
// CODEX P2-1 — the parking verdict is preserved, never assumed.
//
// A refusal after a claim exists tries to park the attempt in `error`. If that
// parking write itself fails, the row may still be `provisioning` behind a live
// lease -- so an operator acting on a "retryable" provider error is turned away
// as `in_progress`. Reporting retryability without whether the row actually
// moved is true and still misleading, so both facts travel together, exactly as
// provisionStudioSmsSender and adoptExistingStudioSmsSender already do.
// ---------------------------------------------------------------------------
describe("the parking verdict travels with the refusal", () => {
  /** A refusal that happens AFTER the claim, so a park is genuinely attempted. */
  function postClaimRefusal(): FakeProviderScript {
    return {
      preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
      accountServices: [
        { sid: WILLOW_MG_SID, numbers: [], inboundUrl: STALE_INBOUND, statusUrl: STALE_STATUS },
      ],
    };
  }

  it("1. an acknowledged park reports parked=true", async () => {
    provider.script = postClaimRefusal();

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_not_in_named_service",
      parked: true,
      parkResult: "failed",
    });
    expect(writes()).toBe(0);
  });

  for (const verdict of ["invalid_input", "not_provisioning", "claim_not_found"] as const) {
    it(`fail => ${verdict} reports parked=false and retains the exact verdict`, async () => {
      provider.script = postClaimRefusal();
      store.failReturns = verdict;

      const out = await configure();

      expect(out.ok).toBe(false);
      if (!out.ok && out.result === "refused" && "parked" in out) {
        // The row did NOT move. Saying otherwise would promise a transition
        // that never happened.
        expect(out.parked, `${verdict} was reported as parked`).toBe(false);
        expect(out.parkResult).toBe(verdict);
        // And the original refusal survives -- the park's failure does not
        // overwrite why we refused.
        expect(out.reason).toBe("number_not_in_named_service");
      }
      expect(writes()).toBe(0);
    });
  }

  it("5. retryability of the PROVIDER problem is not confused with parked", async () => {
    // A retryable provider fault, and a parking write that did not land.
    provider.script = { ...owned(STALE_INBOUND, STALE_STATUS), serviceConfigFails: "provider_unavailable" };
    store.failReturns = "invalid_input";

    const out = await configure();

    expect(out.ok).toBe(false);
    // `parked` narrows this to the POST-CLAIM refusal. The inspect variant has
    // no such field, and the compiler refusing the wider access is itself the
    // guarantee that an inspection can never report a parking verdict.
    if (!out.ok && out.result === "refused" && "parked" in out) {
      expect(out.retryable, "the provider fault is retryable").toBe(true);
      expect(out.parked, "but nothing was parked").toBe(false);
      expect(out.parkResult).toBe("invalid_input");
    }
  });

  it("6. a terminal DATABASE truth outranks our provider story", async () => {
    provider.script = postClaimRefusal();
    store.failReturns = "already_active";

    const out = await configure();

    // The database says the sender reached `active` during the attempt. Its
    // webhooks are live traffic, which is exactly what this capability refuses
    // to touch, so that answer replaces ours.
    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "sender_already_active",
      parked: false,
      parkResult: "already_active",
    });
    expect(writes()).toBe(0);
  });

  it("7. INSPECT carries no parking fields — it creates no attempt to park", async () => {
    provider.script = postClaimRefusal();

    const out = await configure({ mode: "inspect" });

    expect(out.ok).toBe(false);
    expect("parked" in out, "inspect reported a parking verdict").toBe(false);
    expect("parkResult" in out).toBe(false);
    expect(store.claimCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CODEX P2-3 — the fake's configuration overlay is reset with everything else.
// ---------------------------------------------------------------------------
describe("the fake provider resets its applied configuration", () => {
  it("a reset fake does not answer already_configured from a PRIOR test", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);
    const first = await configure();
    expect(first).toMatchObject({ ok: true, result: "configured", providerWrites: 2 });

    // The overlay now holds Hone's URLs for this service SID.
    const applied = await provider.readMessagingServiceConfig({ messagingServiceSid: WILLOW_MG_SID });
    expect(applied.ok && applied.config.inboundRequestUrl).toBe(INBOUND);

    // A new scenario reuses the fake and scripts the SAME service as mismatched.
    provider.reset(owned(STALE_INBOUND, STALE_STATUS));
    store = new InMemoryProvisioningStore(MEMBERS);

    const after = await provider.readMessagingServiceConfig({ messagingServiceSid: WILLOW_MG_SID });
    expect(after.ok && after.config.inboundRequestUrl, "stale overlay survived reset").toBe(
      STALE_INBOUND,
    );

    // And the scenario actually exercises the mismatch it asked for, rather
    // than being answered already_configured by the previous test's writes.
    const out = await configure();
    expect(out).toMatchObject({
      ok: true,
      result: "configured",
      changed: ["inbound_webhook", "status_callback"],
      providerWrites: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// CODEX P2 — an unrecognised mode must never reach the mutation.
//
// `mode` is a typed union, but the union is a COMPILE-TIME statement and this
// function is reachable from unvalidated request bodies and version-skewed
// callers. The old `if inspect ... else configure` shape made MUTATION the
// default: an omitted, misspelled or newly-invented value wrote to a live
// Messaging Service. These cast deliberately, because the runtime is exactly
// what the type cannot speak for.
// ---------------------------------------------------------------------------
describe("an unknown mode is refused, never configured", () => {
  type AnyMode = Parameters<typeof configureExistingStudioSmsSender>[0]["mode"];
  const INVALID: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a misspelling", "configre"],
    ["an arbitrary string", "delete-everything"],
    ["empty string", ""],
    ["a number", 1],
    ["an object", { mode: "configure" }],
  ];

  it("1. \"inspect\" still inspects, read-only", async () => {
    provider.script = owned(STALE_INBOUND, STATUS);
    const out = await configure({ mode: "inspect" });
    expect(out).toMatchObject({ ok: true, result: "inspected", claimsTaken: 0 });
    expect(store.claimCalls).toBe(0);
    expect(writes()).toBe(0);
  });

  it("2. \"configure\" still takes the claimed, fenced mutation path", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);
    const out = await configure({ mode: "configure" });
    expect(out).toMatchObject({ ok: true, result: "configured", providerWrites: 2 });
    expect(store.claimCalls).toBe(1);
  });

  for (const [label, value] of INVALID) {
    it(`3-6. ${label} is refused with no claim and no write`, async () => {
      provider.script = owned(STALE_INBOUND, STALE_STATUS);

      const out = await configure({ mode: value as AnyMode });

      expect(out).toMatchObject({
        ok: false,
        result: "refused",
        reason: "invalid_input",
        providerWrites: 0,
        claimsTaken: 0,
      });

      // 7. Nothing was claimed, leased, parked, finalized or written.
      expect(store.claimCalls, `${label} reached the claim`).toBe(0);
      expect(store.fenceCalls, `${label} touched a lease`).toEqual([]);
      expect(store.finalizeCalls, `${label} reached finalize`).toBe(0);
      expect(store.rows, `${label} created durable attempt state`).toEqual([]);
      expect(writes(), `${label} reached a provider write`).toBe(0);
      // It must not even read the provider: an unknown mode is not a request
      // we understand well enough to act on at all.
      expect(provider.calls.ownedLookup, `${label} read the provider`).toBe(0);
      expectNoForbiddenEffects();
    });
  }
});

// ---------------------------------------------------------------------------
// CODEX P1 — one Twilio account serves every studio, so account ownership is
// not tenancy. Reproduced before the fix: Studio A named Studio B's live number
// and service, claimed under A, and rewrote B's webhooks -- `configured`, two
// writes. The uniqueness indexes never fire, because this path records no
// provider identifiers.
// ---------------------------------------------------------------------------
describe("provider resources bound to another studio are refused", () => {
  const STUDIO_B = "studio-b";
  const OWNER_B = "user-owner-b";
  const B_PN = "PN" + "d".repeat(32);
  const B_MG = "MG" + "d".repeat(32);
  const B_NUMBER = "+14165550199";

  const MEMBERS_AB: Membership[] = [
    ...MEMBERS,
    { userId: OWNER_B, studioId: STUDIO_B, role: "owner" },
  ];

  /** The account owns B's number and it sits in B's service -- both true. */
  function bResources(): FakeProviderScript {
    return {
      preOwnedNumbers: { [B_NUMBER]: B_PN },
      accountServices: [
        { sid: B_MG, numbers: [B_NUMBER], inboundUrl: "https://b.example/in", statusUrl: "https://b.example/st" },
      ],
    };
  }

  function asStudioA(over: Record<string, unknown> = {}) {
    return configure({
      studioId: STUDIO_A,
      actorUserId: OWNER_A,
      phoneNumber: B_NUMBER,
      messagingServiceSid: B_MG,
      ...over,
    });
  }

  beforeEach(() => {
    store = new InMemoryProvisioningStore(MEMBERS_AB);
    provider = new FakeSmsProvisioningProvider();
  });

  it("Studio A cannot CONFIGURE Studio B's bound resources", async () => {
    provider.script = bResources();
    store.bindResources(STUDIO_B, B_PN, B_MG);

    const out = await asStudioA();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "resource_bound_to_other_studio",
      providerWrites: 0,
    });
    expect(writes(), "rewrote another studio's webhooks").toBe(0);
    expect(store.finalizeCalls, "activated across a tenant boundary").toBe(0);
    expectNoForbiddenEffects();
  });

  it("Studio A cannot INSPECT Studio B's bound resources", async () => {
    provider.script = bResources();
    store.bindResources(STUDIO_B, B_PN, B_MG);

    const out = await asStudioA({ mode: "inspect" });

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "resource_bound_to_other_studio",
      providerWrites: 0,
      claimsTaken: 0,
    });
    expect(store.claimCalls).toBe(0);
    expect(writes()).toBe(0);
  });

  it("a PHONE SID bound elsewhere refuses even when the service looks fine", async () => {
    provider.script = bResources();
    store.resourceBindings.set(B_PN, STUDIO_B); // service left unbound

    const out = await asStudioA();

    expect(out).toMatchObject({ ok: false, reason: "resource_bound_to_other_studio", providerWrites: 0 });
    expect(writes()).toBe(0);
  });

  it("a SERVICE SID bound elsewhere refuses even when the number looks fine", async () => {
    provider.script = bResources();
    store.resourceBindings.set(B_MG, STUDIO_B); // phone left unbound

    const out = await asStudioA();

    expect(out).toMatchObject({ ok: false, reason: "resource_bound_to_other_studio", providerWrites: 0 });
    expect(writes()).toBe(0);
  });

  it("an UNREADABLE binding authority fails closed — never treated as unbound", async () => {
    provider.script = bResources();
    store.bindingUnavailable = "phone";

    const out = await asStudioA();

    expect(out).toMatchObject({
      ok: false,
      reason: "binding_unavailable",
      retryable: true,
      providerWrites: 0,
    });
    expect(writes(), "wrote without knowing the tenant").toBe(0);
  });

  it("resources bound to THIS studio proceed normally", async () => {
    provider.script = bResources();
    store.bindResources(STUDIO_A, B_PN, B_MG);

    const out = await asStudioA();

    expect(out).toMatchObject({ ok: true, result: "configured", providerWrites: 2 });
  });

  it("genuinely UNBOUND resources continue through the explicit path", async () => {
    provider.script = bResources();
    // Nothing bound anywhere: the ordinary adoption case.
    const out = await asStudioA();

    expect(out).toMatchObject({ ok: true, result: "configured", providerWrites: 2 });
  });
});

// ---------------------------------------------------------------------------
// CODEX P2 — the lease fence proves we hold the CLAIM, never anything about
// Twilio. The configuration read sits between the proof and the write, and a
// number moved during that await would leave this rewiring a service that no
// longer carries the studio's number.
// ---------------------------------------------------------------------------
describe("association is re-proved immediately before the first write", () => {
  it("a number MOVED between the proof and the write refuses, with zero writes", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    // The configuration read is the await during which the world may change.
    const realRead = provider.readMessagingServiceConfig.bind(provider);
    let moved = false;
    provider.readMessagingServiceConfig = async (input) => {
      const out = await realRead(input);
      if (!moved) {
        moved = true;
        provider.script = {
          preOwnedNumbers: { [WILLOW_NUMBER]: WILLOW_PN_SID },
          accountServices: [
            { sid: WILLOW_MG_SID, numbers: [], inboundUrl: STALE_INBOUND, statusUrl: STALE_STATUS },
            { sid: OTHER_MG_SID, numbers: [WILLOW_NUMBER], inboundUrl: null, statusUrl: null },
          ],
        };
      }
      return out;
    };

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "number_in_other_service",
      providerWrites: 0,
    });
    expect(writes(), "wrote to a service the number had left").toBe(0);
    expectNoForbiddenEffects();
  });

  it("a CHANGED phone-number SID refuses — same E.164, different resource", async () => {
    provider.script = owned(STALE_INBOUND, STALE_STATUS);

    const realRead = provider.readMessagingServiceConfig.bind(provider);
    let swapped = false;
    provider.readMessagingServiceConfig = async (input) => {
      const out = await realRead(input);
      if (!swapped) {
        swapped = true;
        provider.script = {
          ...owned(STALE_INBOUND, STALE_STATUS),
          preOwnedNumbers: { [WILLOW_NUMBER]: "PN" + "e".repeat(32) },
        };
      }
      return out;
    };

    const out = await configure();

    expect(out).toMatchObject({
      ok: false,
      result: "refused",
      reason: "resource_changed_before_write",
      providerWrites: 0,
    });
    expect(writes()).toBe(0);
  });

  it("a stable association still performs the minimal intended write", async () => {
    provider.script = owned(INBOUND, STALE_STATUS);

    const out = await configure();

    expect(out).toMatchObject({
      ok: true,
      result: "configured",
      changed: ["status_callback"],
      providerWrites: 1,
    });
  });
});
