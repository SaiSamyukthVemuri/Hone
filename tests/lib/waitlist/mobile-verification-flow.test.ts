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

// Upstash is not configured in tests, so every limiter is disabled and returns
// allowed. That is the FAIL-OPEN contract of lib/rate-limit/public.ts, and it is
// why these tests do not pretend to prove the budgets: what they prove is that a
// refusal from the gate collapses to one generic value.
const fake = new FakeMobileVerificationProvider();

const STORED = "+15555550123";
const CONTEXT: ResolvedVerificationContext = {
  entryId: "11111111-1111-4111-8111-111111111111",
  studioId: "22222222-2222-4222-8222-222222222222",
  storedPhone: STORED,
};

const resolves: VerificationContextResolver = async () => CONTEXT;
const resolvesNothing: VerificationContextResolver = async () => null;

const AUTH = { capability: "a".repeat(64), studioId: CONTEXT.studioId };
const H = new Headers();

beforeEach(() => {
  rpc.calls = [];
  rpc.reply = "verified";
  fake.reset();
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

  it("a rejected provider outcome and an unauthorized one are BOTH just refusals", async () => {
    // The surface renders one message either way. What must not exist is a shape
    // difference a caller could switch on to learn that the capability was good —
    // which is the same as learning the number is on a waitlist.
    const unauthorized = await runStartMobileVerification(AUTH, resolvesNothing, H, fake);
    fake.scriptStart("refused");
    const refused = await runStartMobileVerification(AUTH, resolves, H, fake);
    expect(Object.keys(unauthorized).sort()).toEqual(Object.keys(refused).sort());
    expect(unauthorized.ok).toBe(false);
    expect(refused.ok).toBe(false);
    fake.reset();
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

  it("an unresolved context is reported as an outage, not as a bad code", async () => {
    // With no resolver in the tree, an unresolvable context is literally NOT
    // CONFIGURED, which is what `unavailable` means. Under D1 this mapping is
    // revisited: once a real resolver exists, null stops meaning "not configured".
    const out = await runStartMobileVerification(AUTH, resolvesNothing, H, fake);
    expect(out).toEqual({ ok: false, code: "unavailable" });
    const checked = await runCheckMobileVerification(AUTH, "123456", resolvesNothing, H, fake);
    expect(checked).toEqual({ ok: false, code: "unavailable" });
  });
});
