import type {
  MobileVerificationProvider,
  VerificationCheckOutcome,
  VerificationStartOutcome,
} from "./types";

// THE DEFAULT PROVIDER, AND IT PROVES NOTHING.
//
// This exists because the previous default was the FAKE, and that was a
// verification bypass waiting for its first caller: any server surface calling
// `startMobileVerification` or `checkMobileVerification` without injecting a
// provider would, in an unconfigured production deployment, have got a provider
// that reports `started` without sending anything and returns `approved` for the
// EXPORTED constant `FAKE_VERIFICATION_CODE`. The service-role command would
// then have marked a number verified with no possession proof behind it.
//
// It was latent rather than live -- nothing called those helpers yet -- and that
// is exactly the shape of defect worth removing before the caller exists, which
// is B2b-2's whole job.
//
// WHY `unavailable` AND NOT `refused`. `refused` means "that code was wrong",
// which would be a lie told to a person whose code was never checked by anybody.
// `unavailable` means "ask again later" and is the one outcome that writes
// nothing and claims nothing. The state machine maps it to a retryable outage.
//
// THE FAKE IS STILL AVAILABLE, BY EXPLICIT INJECTION ONLY. Tests pass it as the
// second argument. A provider that can approve a fixed code must never be
// something a deployment can arrive at by default.

export class FailClosedMobileVerificationProvider implements MobileVerificationProvider {
  async start(): Promise<VerificationStartOutcome> {
    return "unavailable";
  }

  async check(): Promise<VerificationCheckOutcome> {
    return "unavailable";
  }
}
