import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FailClosedMobileVerificationProvider,
  FakeMobileVerificationProvider,
  TwilioVerifyProvider,
  fakeMobileVerificationProvider,
  liveMobileVerificationArmed,
  resolveMobileVerificationProvider,
} from "@/lib/waitlist/mobile-verification";

// ===========================================================================
// THE ARMING GATE — FOUR VARIABLES, ALL OF THEM REQUIRED
// ===========================================================================
//
// WHY THIS IS THE MOST IMPORTANT FILE IN B2b-2. The real adapter now exists, so
// the difference between an unarmed deployment and an armed one is the difference
// between "proves nothing" and "sends a text to a real handset and can promote a
// standing". That difference is four environment variables, and three of them are
// ALREADY SET wherever Hone sends SMS.
//
// So the flag is the only thing standing between merging this code and arming it
// in production, and this file exists to make its removal loud. Each case below
// is a state a real deployment can be in, including the three half-configured ones
// that a credentials-keyed gate would have armed by accident.

const KEYS = [
  "HONE_MOBILE_VERIFICATION_LIVE",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_VERIFY_SERVICE_SID",
] as const;

const SAVED: Record<string, string | undefined> = {};

function set(env: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

const FULLY_ARMED = {
  HONE_MOBILE_VERIFICATION_LIVE: "true",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_VERIFY_SERVICE_SID: "VAtest",
} as const;

beforeEach(() => {
  for (const k of KEYS) SAVED[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("liveMobileVerificationArmed", () => {
  it("is true only with all four", () => {
    set(FULLY_ARMED);
    expect(liveMobileVerificationArmed()).toBe(true);
  });

  it("CREDENTIALS ALONE DO NOT ARM IT", () => {
    // The whole reason the flag exists. TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN
    // are already present in every deployment that sends SMS, so a gate keyed on
    // credentials would have armed live verification the moment B2b-2 merged.
    set({
      TWILIO_ACCOUNT_SID: "ACtest",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_VERIFY_SERVICE_SID: "VAtest",
    });
    expect(liveMobileVerificationArmed()).toBe(false);
  });

  for (const missing of [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_VERIFY_SERVICE_SID",
  ] as const) {
    it(`is false when ${missing} is missing, even with the flag on`, () => {
      const env: Record<string, string> = { ...FULLY_ARMED };
      delete env[missing];
      set(env);
      expect(liveMobileVerificationArmed()).toBe(false);
    });
  }

  it("requires the EXACT string 'true', not a truthy-looking one", () => {
    // A deployment that means to arm this must say so unambiguously. "1" and
    // "yes" are how a flag gets set by someone who is guessing.
    for (const value of ["1", "yes", "on", "TRUE", "True", " true", "true "]) {
      set({ ...FULLY_ARMED, HONE_MOBILE_VERIFICATION_LIVE: value });
      expect(liveMobileVerificationArmed(), `"${value}" must not arm`).toBe(false);
    }
  });

  it("an empty string arms nothing", () => {
    for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID"] as const) {
      set({ ...FULLY_ARMED, [k]: "" });
      expect(liveMobileVerificationArmed(), `empty ${k} must not arm`).toBe(false);
    }
  });
});

describe("resolveMobileVerificationProvider", () => {
  it("resolves to the REAL adapter only when armed", () => {
    set(FULLY_ARMED);
    expect(resolveMobileVerificationProvider()).toBeInstanceOf(TwilioVerifyProvider);
  });

  it("resolves FAIL-CLOSED with nothing configured", () => {
    set({});
    expect(resolveMobileVerificationProvider()).toBeInstanceOf(
      FailClosedMobileVerificationProvider,
    );
  });

  it("resolves FAIL-CLOSED in every half-configured state", () => {
    const states: Record<string, string>[] = [
      { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_VERIFY_SERVICE_SID: "VAtest" },
      { HONE_MOBILE_VERIFICATION_LIVE: "true" },
      { HONE_MOBILE_VERIFICATION_LIVE: "true", TWILIO_VERIFY_SERVICE_SID: "VAtest" },
      { HONE_MOBILE_VERIFICATION_LIVE: "true", TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok" },
    ];
    for (const state of states) {
      set(state);
      expect(
        resolveMobileVerificationProvider(),
        `armed for ${JSON.stringify(state)}`,
      ).toBeInstanceOf(FailClosedMobileVerificationProvider);
    }
  });

  it("NEVER resolves to the fake, in any state", () => {
    // B2b-1's first revision returned the fake here and it was a verification
    // bypass: the fake approves a fixed exported code. The fake is reachable only
    // through its own named accessor.
    for (const state of [{}, FULLY_ARMED as Record<string, string>, { HONE_MOBILE_VERIFICATION_LIVE: "true" }]) {
      set(state);
      expect(resolveMobileVerificationProvider()).not.toBeInstanceOf(
        FakeMobileVerificationProvider,
      );
    }
    expect(fakeMobileVerificationProvider()).toBeInstanceOf(FakeMobileVerificationProvider);
  });

  it("re-reads the environment on every call, so disarming takes effect at once", () => {
    // Rollback is "unset the flag". If the resolver cached an armed provider, the
    // rollback would need a redeploy, and the runbook would be wrong.
    set(FULLY_ARMED);
    expect(resolveMobileVerificationProvider()).toBeInstanceOf(TwilioVerifyProvider);
    delete process.env.HONE_MOBILE_VERIFICATION_LIVE;
    expect(resolveMobileVerificationProvider()).toBeInstanceOf(
      FailClosedMobileVerificationProvider,
    );
  });

  it("the UNARMED provider proves nothing, end to end", async () => {
    set({});
    const p = resolveMobileVerificationProvider();
    expect(await p.start({ e164: "+15555550123" })).toBe("unavailable");
    expect(await p.check({ e164: "+15555550123" }, "000000")).toBe("unavailable");
  });
});

describe("THE ADAPTER ENFORCES THE FLAG ITSELF (P1 at b6cecbb0)", () => {
  // The resolver's gate was the ONLY enforcement point, and the same revision
  // exported the adapter class. Both of these were live-send bypasses and both are
  // reproduced here rather than described: they failed before the fix and pass now.
  //
  // WHY IT MATTERED IN PRODUCTION SPECIFICALLY: the three Twilio credentials are
  // already present in every deployment that sends SMS, so the flag is the only
  // input an operator has to add. Anything that reaches the adapter without
  // consulting the flag is therefore live in production the day it merges.

  function watchFetch(): string[] {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string | URL) => {
        calls.push(String(u));
        return { status: 201, json: async () => ({ status: "pending" }) } as unknown as Response;
      }),
    );
    return calls;
  }

  it("a DIRECTLY CONSTRUCTED adapter sends nothing while the flag is unset", async () => {
    set({
      TWILIO_ACCOUNT_SID: "ACx",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_VERIFY_SERVICE_SID: "VAx",
    });
    const calls = watchFetch();
    const provider = new TwilioVerifyProvider();
    expect(await provider.start({ e164: "+15555550123" })).toBe("unavailable");
    expect(await provider.check({ e164: "+15555550123" }, "123456")).toBe("unavailable");
    vi.unstubAllGlobals();
    expect(calls, "an unarmed adapter reached the network").toEqual([]);
  });

  it("an instance HELD ACROSS A DISARM goes inert at once, not at the next deploy", async () => {
    // This is what makes the activation checklist's rollback step true. If a held
    // provider kept working, "unset the flag" would need a redeploy to take effect
    // and the runbook would be wrong at the moment it was most needed.
    set(FULLY_ARMED);
    const held = resolveMobileVerificationProvider();
    expect(held).toBeInstanceOf(TwilioVerifyProvider);
    delete process.env.HONE_MOBILE_VERIFICATION_LIVE;
    const calls = watchFetch();
    expect(await held.start({ e164: "+15555550123" })).toBe("unavailable");
    vi.unstubAllGlobals();
    expect(calls, "a held provider ignored the rollback").toEqual([]);
  });

  it("the resolver and the adapter read ONE predicate, so they cannot disagree", async () => {
    // Each of the four inputs, removed one at a time: the resolver must refuse to
    // hand out the adapter AND the adapter must refuse to act.
    for (const missing of [
      "HONE_MOBILE_VERIFICATION_LIVE",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_VERIFY_SERVICE_SID",
    ] as const) {
      const env: Record<string, string> = { ...FULLY_ARMED };
      delete env[missing];
      set(env);
      expect(resolveMobileVerificationProvider(), `resolver armed without ${missing}`).toBeInstanceOf(
        FailClosedMobileVerificationProvider,
      );
      const calls = watchFetch();
      expect(
        await new TwilioVerifyProvider().start({ e164: "+15555550123" }),
        `adapter acted without ${missing}`,
      ).toBe("unavailable");
      vi.unstubAllGlobals();
      expect(calls, `adapter called out without ${missing}`).toEqual([]);
    }
  });
});
