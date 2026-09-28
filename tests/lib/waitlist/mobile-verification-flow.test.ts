import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runCheckMobileVerification,
  runStartMobileVerification,
  type ResolvedVerificationContext,
  type VerificationContextResolver,
} from "@/lib/waitlist/mobile-verification-flow";
import {
  FakeMobileVerificationProvider,
  FAKE_VERIFICATION_CODE,
} from "@/lib/waitlist/mobile-verification";

// ===========================================================================
// THE AUTHORIZED FLOW — AND THE MEMBERSHIP-ORACLE PROPERTY
// ===========================================================================
//
// The state machine's own ordering is proved by
// tests/lib/waitlist/mobile-verification-server.test.ts. What is proved HERE is
// what the flow adds: that an authorization is required, that a refusal tells an
// anonymous caller nothing about whether the number is on a waitlist, and that no
// phone number can enter from the request side at any layer.
//
// THE RPC IS STUBBED, so no production command is invoked and no row is written.
// The provider is the process-wide fake, injected explicitly — never resolved.

const rpc: { calls: { fn: string; args: Record<string, unknown> }[]; reply: string } = {
  calls: [],
  reply: "verified",
};

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.calls.push({ fn, args });
      return { data: rpc.reply, error: null };
    },
  }),
}));

// THE TWO GATES ARE MOCKED SO EXHAUSTION IS REACHABLE. Upstash is unconfigured in
// tests, so the real limiters are disabled and answer `allowed` — which is the
// documented fail-open contract, and which is precisely why the previous version of
// this file could not test the exhausted state at all. That gap is how the
// capability-validity leak survived: the equality tests proved indistinguishability
// in the un-exhausted state, and only in that state.
//
// `gates.denyIp` / `gates.denyEntry` drive stage 1 and stage 2. `gates.ipCalls` and
// `gates.entryCalls` record the arguments, because WHAT a gate is keyed on is as
// much the property as whether it fires.
const gates: {
  denyIp: boolean;
  denyEntry: boolean;
  ipCalls: { operation: string; args: Record<string, unknown> }[];
  entryCalls: { operation: string; args: Record<string, unknown> }[];
} = { denyIp: false, denyEntry: false, ipCalls: [], entryCalls: [] };

vi.mock("@/lib/rate-limit/public", () => ({
  limitMobileVerificationIp: async (
    operation: string,
    args: Record<string, unknown>,
  ) => {
    gates.ipCalls.push({ operation, args });
    return gates.denyIp ? { allowed: false, retryAfterSeconds: 42 } : { allowed: true };
  },
  limitMobileVerificationEntry: async (
    operation: string,
    args: Record<string, unknown>,
  ) => {
    gates.entryCalls.push({ operation, args });
    return gates.denyEntry ? { allowed: false, retryAfterSeconds: 42 } : { allowed: true };
  },
}));

const fake = new FakeMobileVerificationProvider();

const STORED = "+15555550123";
const CONTEXT: ResolvedVerificationContext = {
  entryId: "11111111-1111-4111-8111-111111111111",
  studioId: "22222222-2222-4222-8222-222222222222",
  storedPhone: STORED,
};

const resolves: VerificationContextResolver = async () => CONTEXT;
const resolvesNothing: VerificationContextResolver = async () => null;

// THE CLAIMED STUDIO IS DELIBERATELY NOT THE RESOLVED ONE.
//
// `authorization.studioId` is caller-supplied and untrusted; `context.studioId` is
// what the resolver derived. Making them EQUAL in this fixture is how a mutation
// walked straight through the per-entry assertion: swapping `context.studioId` for
// `authorization.studioId` produced the same value and the test stayed green. A
// fixture that cannot tell two sources apart cannot prove which one is used.
const CLAIMED_STUDIO_ID = "33333333-3333-4333-8333-333333333333";
const AUTH = { capability: "a".repeat(64), studioId: CLAIMED_STUDIO_ID };
const H = new Headers();

beforeEach(() => {
  rpc.calls = [];
  rpc.reply = "verified";
  fake.reset();
  gates.denyIp = false;
  gates.denyEntry = false;
  gates.ipCalls = [];
  gates.entryCalls = [];
});

describe("an authorization is required, and nothing else identifies the entry", () => {
  it("start refuses when the authorization resolves to nothing", async () => {
    const out = await runStartMobileVerification(AUTH, resolvesNothing, H, fake);
    expect(out.ok).toBe(false);
  });

  it("check refuses when the authorization resolves to nothing, and asks no provider", async () => {
    const spy = vi.spyOn(fake, "check");
    const out = await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolvesNothing, H, fake);
    expect(out.ok).toBe(false);
    expect(spy, "an unauthorized check must not reach the provider").not.toHaveBeenCalled();
    expect(rpc.calls, "and must not reach the promotion command").toEqual([]);
    spy.mockRestore();
  });

  it("THE FLOW ACCEPTS NO PHONE NUMBER, at any layer", () => {
    // Asserted structurally, because this is the property that stops the surface
    // being a membership oracle and a signature is the only place it can be lost.
    // A caller supplies a capability, a studio id and a code. Never a destination.
    const start = runStartMobileVerification.length;
    const check = runCheckMobileVerification.length;
    expect(start).toBe(4); // authorization, resolver, headers, provider
    expect(check).toBe(5); // authorization, code, resolver, headers, provider
    const src = String(runStartMobileVerification) + String(runCheckMobileVerification);
    expect(src).not.toMatch(/e164/);
    expect(src).not.toMatch(/\bphone\b(?!\s*:)/);
  });
});

describe("the happy path still runs through the state machine", () => {
  it("start reaches the provider with the ROW's destination", async () => {
    const spy = vi.spyOn(fake, "start");
    const out = await runStartMobileVerification(AUTH, resolves, H, fake);
    expect(out).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith({ e164: STORED });
    spy.mockRestore();
  });

  it("an approved check promotes, and passes the phone AS STORED", async () => {
    await runStartMobileVerification(AUTH, resolves, H, fake);
    const out = await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolves, H, fake);
    expect(out).toEqual({ ok: true });
    expect(rpc.calls).toEqual([
      {
        fn: "mark_waitlist_mobile_verified",
        args: { p_entry_id: CONTEXT.entryId, p_expected_phone: STORED },
      },
    ]);
  });

  it("a WRONG code refuses and writes nothing", async () => {
    await runStartMobileVerification(AUTH, resolves, H, fake);
    const out = await runCheckMobileVerification(AUTH, "999999", resolves, H, fake);
    expect(out).toEqual({ ok: false, code: "not_proved" });
    expect(rpc.calls).toEqual([]);
  });

  it("a check BEFORE a start refuses and writes nothing", async () => {
    const out = await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolves, H, fake);
    expect(out.ok).toBe(false);
    expect(rpc.calls).toEqual([]);
  });

  it("an entry with no stored mobile refuses before any provider call", async () => {
    const spy = vi.spyOn(fake, "start");
    const out = await runStartMobileVerification(
      AUTH,
      async () => ({ ...CONTEXT, storedPhone: null }),
      H,
      fake,
    );
    expect(out).toEqual({ ok: false, code: "no_destination" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("MEMBERSHIP-ORACLE RESISTANCE", () => {
  it("every refusal is one of the four coarse codes, and none names a cause", async () => {
    const outcomes = [
      await runStartMobileVerification(AUTH, resolvesNothing, H, fake),
      await runStartMobileVerification(AUTH, async () => ({ ...CONTEXT, storedPhone: null }), H, fake),
      await runCheckMobileVerification(AUTH, "999999", resolves, H, fake),
      await runCheckMobileVerification(AUTH, "", resolves, H, fake),
    ];
    const allowed = new Set(["no_destination", "not_proved", "rate_limited", "unavailable"]);
    for (const o of outcomes) {
      expect(o.ok).toBe(false);
      if (!o.ok) expect(allowed.has(o.code), `leaked code ${o.code}`).toBe(true);
    }
  });

  it("a refusal never carries the capability, the code or the number", async () => {
    const out = JSON.stringify([
      await runStartMobileVerification(AUTH, resolvesNothing, H, fake),
      await runCheckMobileVerification(AUTH, "999999", resolves, H, fake),
    ]);
    expect(out).not.toContain(AUTH.capability);
    expect(out).not.toContain(STORED);
    expect(out).not.toContain("999999");
    expect(out).not.toContain(CONTEXT.entryId);
  });

  // ===========================================================================
  // EXACT VALUE EQUALITY, NOT SHAPE EQUALITY
  // ===========================================================================
  //
  // THE PREVIOUS VERSION OF THESE TWO TESTS COMPARED `Object.keys` AND WAS WORSE
  // THAN NO TEST. Both outcomes are `{ok, code}`, so the keys always matched while
  // `code` differed — unauthorized returned `unavailable`, a provider refusal
  // returned `not_proved`. A caller switches on `code`, which the assertion never
  // looked at. So it named the membership-oracle property, proved only that both
  // objects had a `code` field, and supplied false assurance about the one property
  // this module exists to have. P2 at ef5a9278.
  //
  // The refusal for an unresolved context is now `not_proved` (owner decision,
  // 2026-09-28), which is what makes exact equality achievable rather than just
  // asserted.

  it("START: unauthorized is VALUE-IDENTICAL to a provider refusal", async () => {
    const unauthorized = await runStartMobileVerification(AUTH, resolvesNothing, H, fake);
    fake.scriptStart("refused");
    const refused = await runStartMobileVerification(AUTH, resolves, H, fake);
    fake.reset();

    // The whole object, deep-equal. Not the keys, not `.ok`, not a subset.
    expect(unauthorized).toEqual(refused);
    expect(unauthorized).toEqual({ ok: false, code: "not_proved" });
    // And spelled out, because this is the assertion that failed before: the
    // caller-visible discriminant must be the same string.
    expect((unauthorized as { code: string }).code).toBe((refused as { code: string }).code);
  });

  it("CHECK: unauthorized is VALUE-IDENTICAL to a rejected code", async () => {
    const unauthorized = await runCheckMobileVerification(
      AUTH,
      FAKE_VERIFICATION_CODE,
      resolvesNothing,
      H,
      fake,
    );
    await runStartMobileVerification(AUTH, resolves, H, fake);
    const rejected = await runCheckMobileVerification(AUTH, "999999", resolves, H, fake);

    expect(unauthorized).toEqual(rejected);
    expect(unauthorized).toEqual({ ok: false, code: "not_proved" });
    expect((unauthorized as { code: string }).code).toBe((rejected as { code: string }).code);
  });

  it("NEGATIVE CONTROL: the equality is not vacuous — other refusals still differ", async () => {
    // If every refusal collapsed to one value the two assertions above would pass
    // for the wrong reason. The vocabulary must still be able to say other things.
    const noDestination = await runStartMobileVerification(
      AUTH,
      async () => ({ ...CONTEXT, storedPhone: null }),
      H,
      fake,
    );
    fake.scriptStart("unavailable");
    const outage = await runStartMobileVerification(AUTH, resolves, H, fake);
    fake.reset();
    expect(noDestination).toEqual({ ok: false, code: "no_destination" });
    expect(outage).toEqual({ ok: false, code: "unavailable" });
    expect(noDestination).not.toEqual(outage);
  });
});

describe("AN UNAUTHORIZED FLOW TOUCHES NOTHING", () => {
  // Three properties, both operations, asserted together rather than inferred from
  // the refusal value. A caller whose authorization proves nothing must not be able
  // to spend a provider call, reach the promotion command, or read back anything it
  // did not already hold.

  it("never calls the provider, on either operation", async () => {
    const start = vi.spyOn(fake, "start");
    const check = vi.spyOn(fake, "check");
    await runStartMobileVerification(AUTH, resolvesNothing, H, fake);
    await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolvesNothing, H, fake);
    expect(start, "an unauthorized start reached the provider").not.toHaveBeenCalled();
    expect(check, "an unauthorized check reached the provider").not.toHaveBeenCalled();
    start.mockRestore();
    check.mockRestore();
  });

  it("never calls mark_waitlist_mobile_verified", async () => {
    // The promotion command's ordering contract is application-level -- 0203's own
    // column comment says so -- so this is the layer that has to hold it.
    await runStartMobileVerification(AUTH, resolvesNothing, H, fake);
    await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolvesNothing, H, fake);
    expect(rpc.calls, "an unauthorized flow reached the promotion command").toEqual([]);
  });

  it("never exposes the capability, the phone, the entry id or the code", async () => {
    // Serialised whole, so a field added to FlowOutcome later cannot smuggle one of
    // these out without failing here.
    const secrets = {
      capability: AUTH.capability,
      phone: STORED,
      entryId: CONTEXT.entryId,
      studioId: CONTEXT.studioId,
      code: "424242",
    };
    const outcomes = JSON.stringify([
      await runStartMobileVerification(AUTH, resolvesNothing, H, fake),
      await runCheckMobileVerification(AUTH, secrets.code, resolvesNothing, H, fake),
    ]);
    for (const [name, value] of Object.entries(secrets)) {
      expect(outcomes, `an unauthorized refusal carried the ${name}`).not.toContain(value);
    }
    // Anti-vacuity: the serialisation is not empty, so the absences mean something.
    expect(outcomes).toContain("not_proved");
  });

  it("an unauthorized attempt is indistinguishable from an authorized refusal in TIMING of side effects", async () => {
    // Not a wall-clock claim -- that is not testable here and would be flaky. The
    // property is that neither path leaves a trace the other does not: no provider
    // call, no RPC, on both sides of the comparison.
    const spy = vi.spyOn(fake, "check");
    await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolvesNothing, H, fake);
    const unauthorizedRpc = [...rpc.calls];
    const unauthorizedProviderCalls = spy.mock.calls.length;
    rpc.calls = [];
    spy.mockClear();

    // The authorized-but-rejected path DOES call the provider -- that is the one
    // asymmetry, and it is invisible to the caller because both return the same
    // value. What must match is the absence of a WRITE.
    await runStartMobileVerification(AUTH, resolves, H, fake);
    await runCheckMobileVerification(AUTH, "999999", resolves, H, fake);
    expect(rpc.calls, "a rejected check wrote something").toEqual([]);
    expect(unauthorizedRpc).toEqual([]);
    expect(unauthorizedProviderCalls).toBe(0);
    spy.mockRestore();
  });
});

describe("the D1 seam", () => {
  it("there is NO default resolver: a caller must name its authorization", () => {
    // Phase 1 ships no concrete resolver, because which capability resolves a
    // verification context is an owner decision. The seam being a REQUIRED
    // argument is what stops a surface reaching this flow without one.
    const start = String(runStartMobileVerification);
    expect(start).not.toMatch(/resolve\s*=/);
    expect(start).not.toMatch(/resolve\s*\?\?/);
  });

  it("a resolver that DECLINES yields not_proved, on both operations", async () => {
    // OWNER DECISION, 2026-09-28. A resolver that runs and returns null has decided
    // this authorization proves nothing — a statement about the authorization, not
    // about the deployment. `not_proved` is the coarsest existing refusal and names
    // no step, so it cannot report WHICH check failed.
    //
    // It was `unavailable` for two revisions, on the reasoning that Phase 1 has no
    // resolver so the context is "not configured". True of the tree, irrelevant to
    // the caller, and it leaked authorization validity — see the value-equality
    // tests above.
    const out = await runStartMobileVerification(AUTH, resolvesNothing, H, fake);
    expect(out).toEqual({ ok: false, code: "not_proved" });
    const checked = await runCheckMobileVerification(AUTH, "123456", resolvesNothing, H, fake);
    expect(checked).toEqual({ ok: false, code: "not_proved" });
  });
});

// ===========================================================================
// TWO-STAGE LIMITING — THE PRE-AUTH IP GATE
// ===========================================================================
//
// The previous order was authorize-then-limit, and once an IP bucket was exhausted
// it leaked capability validity: an INVALID capability returned before the limiter
// ran (`not_proved`) while a VALID one reached the limiter and returned
// `rate_limited`. A caller could exhaust their own bucket on purpose and read
// validity off the difference. P2 at 234d1a49.

describe("STAGE 1: an exhausted IP is indistinguishable, valid capability or not", () => {
  it("exhausted IP + INVALID capability -> rate_limited", async () => {
    gates.denyIp = true;
    expect(await runStartMobileVerification(AUTH, resolvesNothing, H, fake)).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(await runCheckMobileVerification(AUTH, "123456", resolvesNothing, H, fake)).toEqual({
      ok: false,
      code: "rate_limited",
    });
  });

  it("exhausted IP + VALID capability -> IDENTICAL rate_limited", async () => {
    gates.denyIp = true;
    const invalidStart = await runStartMobileVerification(AUTH, resolvesNothing, H, fake);
    const validStart = await runStartMobileVerification(AUTH, resolves, H, fake);
    const invalidCheck = await runCheckMobileVerification(AUTH, "1", resolvesNothing, H, fake);
    const validCheck = await runCheckMobileVerification(AUTH, "1", resolves, H, fake);

    // Deep equality, not shape: the caller-visible discriminant must be the same.
    expect(validStart).toEqual(invalidStart);
    expect(validCheck).toEqual(invalidCheck);
    expect(validStart).toEqual({ ok: false, code: "rate_limited" });
  });

  it("a stage-1 denial does NOT call the resolver", async () => {
    gates.denyIp = true;
    let resolverCalls = 0;
    const counting: VerificationContextResolver = async () => {
      resolverCalls += 1;
      return CONTEXT;
    };
    await runStartMobileVerification(AUTH, counting, H, fake);
    await runCheckMobileVerification(AUTH, "123456", counting, H, fake);
    expect(resolverCalls, "the resolver ran behind an exhausted IP gate").toBe(0);
  });

  it("a stage-1 denial does NOT call the provider", async () => {
    gates.denyIp = true;
    const start = vi.spyOn(fake, "start");
    const check = vi.spyOn(fake, "check");
    await runStartMobileVerification(AUTH, resolves, H, fake);
    await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolves, H, fake);
    expect(start).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    start.mockRestore();
    check.mockRestore();
  });

  it("a stage-1 denial does NOT call the promotion RPC", async () => {
    gates.denyIp = true;
    await runStartMobileVerification(AUTH, resolves, H, fake);
    await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolves, H, fake);
    expect(rpc.calls).toEqual([]);
  });

  it("a stage-1 denial spends no entry budget", async () => {
    // Stage 2 must not be reached at all, or an attacker could burn one person's
    // budget from an already-exhausted IP.
    gates.denyIp = true;
    await runStartMobileVerification(AUTH, resolves, H, fake);
    expect(gates.entryCalls).toEqual([]);
  });
});

describe("UNDER BUDGET the refusals stay collapsed", () => {
  it("invalid capability -> not_proved; valid provider refusal -> the same", async () => {
    const unauthorized = await runStartMobileVerification(AUTH, resolvesNothing, H, fake);
    fake.scriptStart("refused");
    const refused = await runStartMobileVerification(AUTH, resolves, H, fake);
    fake.reset();
    expect(unauthorized).toEqual(refused);
    expect(unauthorized).toEqual({ ok: false, code: "not_proved" });
  });

  it("a resolved context still receives per-entry limiting, and it can deny", async () => {
    gates.denyEntry = true;
    expect(await runStartMobileVerification(AUTH, resolves, H, fake)).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(gates.entryCalls).toHaveLength(1);
    expect(gates.entryCalls[0].operation).toBe("start");
    expect(gates.entryCalls[0].args).toEqual({
      studioId: CONTEXT.studioId,
      entryId: CONTEXT.entryId,
    });
    // And explicitly NOT the studio the caller claimed. This is the assertion the
    // old fixture could not make, because the two ids were the same string.
    expect(
      gates.entryCalls[0].args.studioId,
      "the entry gate was keyed on the caller-supplied studio",
    ).not.toBe(CLAIMED_STUDIO_ID);
  });

  it("CHECK's entry gate is keyed on the RESOLVED studio too", async () => {
    // The start-path assertion above did not cover this one, and a mutation proved
    // it: swapping `context.studioId` for `authorization.studioId` in the CHECK path
    // alone stayed green. Both paths need the assertion, not just the first one
    // anybody happened to write.
    gates.denyEntry = true;
    expect(
      await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolves, H, fake),
    ).toEqual({ ok: false, code: "rate_limited" });
    expect(gates.entryCalls).toHaveLength(1);
    expect(gates.entryCalls[0].operation).toBe("check");
    expect(gates.entryCalls[0].args).toEqual({
      studioId: CONTEXT.studioId,
      entryId: CONTEXT.entryId,
    });
    expect(
      gates.entryCalls[0].args.studioId,
      "the check entry gate was keyed on the caller-supplied studio",
    ).not.toBe(CLAIMED_STUDIO_ID);
  });

  it("one request spends each budget ONCE", async () => {
    await runStartMobileVerification(AUTH, resolves, H, fake);
    expect(gates.ipCalls, "the IP budget was charged more than once").toHaveLength(1);
    expect(gates.entryCalls, "the entry budget was charged more than once").toHaveLength(1);
  });
});

describe("STAGE 1 IS KEYED ON NOTHING THE CALLER CONTROLS", () => {
  it("the gate receives headers and nothing else", async () => {
    await runStartMobileVerification(AUTH, resolves, H, fake);
    expect(gates.ipCalls).toHaveLength(1);
    expect(Object.keys(gates.ipCalls[0].args)).toEqual(["headers"]);
    for (const forbidden of ["studioId", "entryId", "capability", "code", "phone"]) {
      expect(
        gates.ipCalls[0].args,
        `stage 1 received ${forbidden}, which a caller controls`,
      ).not.toHaveProperty(forbidden);
    }
  });

  it("a caller-varied studioId cannot produce a different stage-1 call", async () => {
    await runStartMobileVerification({ ...AUTH, studioId: "studio-a" }, resolves, H, fake);
    await runStartMobileVerification({ ...AUTH, studioId: "studio-b" }, resolves, H, fake);
    await runStartMobileVerification({ ...AUTH, capability: "b".repeat(64) }, resolves, H, fake);
    expect(gates.ipCalls).toHaveLength(3);
    const [a, b, c] = gates.ipCalls;
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("start and check spend SEPARATE budgets", async () => {
    await runStartMobileVerification(AUTH, resolves, H, fake);
    await runCheckMobileVerification(AUTH, FAKE_VERIFICATION_CODE, resolves, H, fake);
    expect(gates.ipCalls.map((c) => c.operation)).toEqual(["start", "check"]);
    expect(gates.entryCalls.map((c) => c.operation)).toEqual(["start", "check"]);
  });
});
