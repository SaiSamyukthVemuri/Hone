import "server-only";
import { FakeMobileVerificationProvider } from "./fake-provider";
import { FailClosedMobileVerificationProvider } from "./fail-closed-provider";
import { TwilioVerifyProvider } from "./twilio-verify-provider";
import type { MobileVerificationProvider } from "./types";

// Provider selection for possession proof (WAIT B2b).
//
// THREE SEPARATE STATEMENTS, AND NO TWO OF THEM COLLAPSE INTO ONE:
//   - the DEFAULT is fail-closed;
//   - the REAL ADAPTER is opt-in;
//   - the FAKE is reached by explicit injection only.
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
// THE REAL ADAPTER IS NOW HERE (B2b-2), AND THE UNARMED BRANCH IS UNCHANGED: it
// is still `failClosed`, and it is still not the process-wide test double. An
// unarmed deployment proves nothing rather than proving something inert.
//
// The real adapter needs its OWN flag AND its own Verify Service SID. NOTHING
// SETS EITHER TODAY: no Twilio Verify Service exists, and creating one is a
// provider action B2b-2 is not authorized to take. So this module ships arming-
// capable and unarmed, which is exactly what keeping the flag separate from the
// credentials is for.
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
// STATELESS, AND CONSTRUCTING IT ARMS NOTHING. It reads its configuration per
// call rather than at construction, so one instance stays correct across an env
// change and a process that is never armed never holds a usable client.
const twilioVerify = new TwilioVerifyProvider();

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
 * The provider this deployment should use. **FAIL-CLOSED UNLESS ARMED.**
 *
 * An unarmed or half-configured deployment resolves to a provider that proves
 * nothing: `unavailable` from both operations, writing nothing and claiming
 * nothing. Only all four pieces of configuration reach the real adapter.
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
 * AN EARLY RETURN, NOT THE TERNARY THIS COMMENT USED TO PRESCRIBE. The previous
 * revision said this "becomes `liveMobileVerificationArmed() ? real :
 * failClosed`". That expression is behaviourally right and it FAILS THE SOURCE
 * GUARD: tests/source-guards/mobile-verification-provider-guards.test.ts requires
 * this body to match /return\s+failClosed\b/, and in a ternary `failClosed` is
 * not adjacent to `return`. A regex cannot tell a correct ternary from
 * `armed ? real : fake`, so it demands the one shape it can verify. The guard is
 * right to be strict and the prescribing comment was the thing that needed
 * fixing.
 *
 * The unarmed branch is FIRST and unconditional, so a reader meets the
 * fail-closed path before any provider is named.
 */
export function resolveMobileVerificationProvider(): MobileVerificationProvider {
  if (!liveMobileVerificationArmed()) return failClosed;
  return twilioVerify;
}

export { FakeMobileVerificationProvider, FAKE_VERIFICATION_CODE } from "./fake-provider";
export { FailClosedMobileVerificationProvider } from "./fail-closed-provider";
export { TwilioVerifyProvider } from "./twilio-verify-provider";
export type {
  MobileVerificationProvider,
  VerificationCheckOutcome,
  VerificationDestination,
  VerificationStartOutcome,
} from "./types";
