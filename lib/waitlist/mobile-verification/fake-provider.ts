import type {
  MobileVerificationProvider,
  VerificationCheckOutcome,
  VerificationDestination,
  VerificationStartOutcome,
} from "./types";

// The in-process fake possession-proof provider.
//
// IT IS NOT THE DEFAULT, AND THAT IS THE SAFETY PROPERTY. An earlier revision
// said the opposite in both words and code: this fake was what
// `resolveMobileVerificationProvider` returned, which made `approved` reachable
// for a fixed exported code in an unconfigured production deployment. Being the
// default was never the safety property; it was the defect.
//
// IT IS REACHED BY EXPLICIT INJECTION ONLY — passed as the second argument to
// `startMobileVerification` / `checkMobileVerification` by tests that mean to use
// it. The default is `FailClosedMobileVerificationProvider`.
//
// WHAT IS STILL TRUE is that no credential may arm a real send: nothing in a
// preview build, a CI job or a local run should contact a provider because a
// credential happened to be present — see ./index.ts for why credentials alone
// must not arm the real adapter.
//
// IT PROVES NOTHING ABOUT A REAL PHONE, and says so loudly: the accepted code is
// fixed and known, so a test that "verifies" here has exercised Hone's state
// machine and not a carrier. No test in this lane makes a real provider call.

/** The only code the fake accepts. Never a plausible real code. */
export const FAKE_VERIFICATION_CODE = "000000";

export class FakeMobileVerificationProvider implements MobileVerificationProvider {
  /** Destinations with a live challenge, so `check` before `start` is rejected. */
  private readonly started = new Set<string>();

  /** Scripted outcomes, so a test can exercise refusal and outage paths. */
  private nextStart: VerificationStartOutcome | null = null;
  private nextCheck: VerificationCheckOutcome | null = null;

  scriptStart(outcome: VerificationStartOutcome): void {
    this.nextStart = outcome;
  }

  scriptCheck(outcome: VerificationCheckOutcome): void {
    this.nextCheck = outcome;
  }

  reset(): void {
    this.started.clear();
    this.nextStart = null;
    this.nextCheck = null;
  }

  async start(destination: VerificationDestination): Promise<VerificationStartOutcome> {
    if (this.nextStart) {
      const scripted = this.nextStart;
      this.nextStart = null;
      if (scripted === "started") this.started.add(destination.e164);
      return scripted;
    }
    this.started.add(destination.e164);
    return "started";
  }

  async check(
    destination: VerificationDestination,
    code: string,
  ): Promise<VerificationCheckOutcome> {
    if (this.nextCheck) {
      const scripted = this.nextCheck;
      this.nextCheck = null;
      return scripted;
    }
    // A CHALLENGE MUST EXIST. Approving a code for a destination nobody
    // challenged would let the fake mint proof out of nothing, which is exactly
    // the shape of bug the real boundary exists to prevent.
    if (!this.started.has(destination.e164)) return "rejected";
    return code === FAKE_VERIFICATION_CODE ? "approved" : "rejected";
  }
}
