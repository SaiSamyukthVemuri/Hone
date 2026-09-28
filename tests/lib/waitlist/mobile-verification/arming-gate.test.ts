import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
