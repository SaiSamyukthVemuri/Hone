import "server-only";
import { FakeMobileVerificationProvider } from "./fake-provider";
import { FailClosedMobileVerificationProvider } from "./fail-closed-provider";
import type { MobileVerificationProvider } from "./types";

// Provider selection for possession proof (WAIT B2b).
//
// THE DEFAULT IS FAIL-CLOSED. THE REAL ADAPTER IS OPT-IN. THE FAKE IS REACHED
// BY EXPLICIT INJECTION ONLY — three separate statements, and none of them
// collapses into "the fake is the default".
//
// THE REAL ADAPTER IS OPT-IN for the reason lib/sms/provider/index.ts gives:
// TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are ALREADY present wherever Hone
// sends SMS, so keying the adapter off credentials would arm it in production the
// moment this merges — and arming it means sending real verification messages to
// real phone numbers.
//
// THE DEFAULT IS NOT THE FAKE, AND HERE THIS MODULE DIVERGES FROM
// lib/sms/provider DELIBERATELY. A fake SEND is inert: it delivers nothing and
// claims nothing. A fake POSSESSION PROOF is not inert, because it returns
// `approved` for a fixed exported code, and an approval is the one input that
// promotes a standing. So the unarmed branch resolves to
// FailClosedMobileVerificationProvider, never to the fake.
//
// IF YOU ARE ADDING THE REAL ADAPTER: the unarmed branch stays `failClosed`. Do
// not write `armed ? real : fake`. That was this module's first revision and it
// was a verification bypass.
//
// The real adapter therefore needs its OWN flag AND its own Verify Service SID.
// Nothing sets either today: no Twilio Verify Service exists, and creating one
// is a provider action this slice is not authorized to take.
//
// WHAT AN UNCONFIGURED DEPLOYMENT DOES: returns `unavailable` from both
// operations. Not `refused` — that would tell a caller their code was wrong when
// it was never checked — and certainly not `approved`. `unavailable` is the one
// outcome that means "ask again later" and writes nothing.
//
// THAT SENTENCE WAS TRUE OF THE INTENT AND FALSE OF THE CODE for one revision:
// the default resolver below returned the FAKE, which approves a fixed exported
// code. The default is now `FailClosedMobileVerificationProvider`, so the
// paragraph above describes what actually happens.

const REAL_PROVIDER_FLAG = "HONE_MOBILE_VERIFICATION_LIVE";
const VERIFY_SERVICE_SID = "TWILIO_VERIFY_SERVICE_SID";

const fake = new FakeMobileVerificationProvider();
const failClosed = new FailClosedMobileVerificationProvider();

/** The process-wide fake, for tests and inspection. */
export function fakeMobileVerificationProvider(): FakeMobileVerificationProvider {
  return fake;
}

/**
 * True only when the deployment has explicitly armed live verification AND every
 * piece of configuration the real adapter needs is present.
 *
 * All four are required. The flag alone cannot send; credentials alone must not;
 * and a Verify Service SID is not optional because Twilio Verify has no usable
 * default service.
 */
export function liveMobileVerificationArmed(): boolean {
  return (
    process.env[REAL_PROVIDER_FLAG] === "true" &&
    Boolean(process.env.TWILIO_ACCOUNT_SID) &&
    Boolean(process.env.TWILIO_AUTH_TOKEN) &&
    Boolean(process.env[VERIFY_SERVICE_SID])
  );
}

/**
 * The provider this deployment should use. **FAIL-CLOSED BY DEFAULT.**
 *
 * B2b-1 SHIPS NO REAL ADAPTER, so there is nothing an armed deployment can
 * resolve to yet, and the honest answer is a provider that proves nothing:
 * `unavailable` from both operations, writing nothing and claiming nothing.
 *
 * THIS RETURNED THE FAKE IN AN EARLIER REVISION, WHICH WAS A VERIFICATION
 * BYPASS. Any surface calling the state machine without injecting a provider
 * would have received one that reports `started` without sending, and returns
 * `approved` for the exported constant `FAKE_VERIFICATION_CODE` — promoting a
 * number to verified with no possession proof behind it. Nothing called those
 * helpers yet, so it was latent; a trap with no victim is still a trap, and the
 * caller arrives in B2b-2.
 *
 * THE FAKE IS REACHED BY EXPLICIT INJECTION ONLY. Tests pass it as the second
 * argument to `startMobileVerification` / `checkMobileVerification`. That every
 * test already did so is precisely why the bad default went unexercised.
 *
 * WHEN B2b-2 LANDS the real adapter, this becomes
 * `liveMobileVerificationArmed() ? real : failClosed` — the unarmed branch stays
 * fail-closed, so an unconfigured or half-configured deployment still cannot
 * verify anybody.
 */
export function resolveMobileVerificationProvider(): MobileVerificationProvider {
  return failClosed;
}

export { FakeMobileVerificationProvider, FAKE_VERIFICATION_CODE } from "./fake-provider";
export { FailClosedMobileVerificationProvider } from "./fail-closed-provider";
export type {
  MobileVerificationProvider,
  VerificationCheckOutcome,
  VerificationDestination,
  VerificationStartOutcome,
} from "./types";
