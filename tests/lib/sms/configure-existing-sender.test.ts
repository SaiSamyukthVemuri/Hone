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
