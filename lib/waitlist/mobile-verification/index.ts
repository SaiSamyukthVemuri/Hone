import "server-only";
import { FakeMobileVerificationProvider } from "./fake-provider";
import type { MobileVerificationProvider } from "./types";

// Provider selection for possession proof (WAIT B2b).
//
// THE FAKE IS THE DEFAULT AND THE REAL ADAPTER IS OPT-IN. This mirrors
// lib/sms/provider/index.ts deliberately, for the same reason it was written
// there: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are ALREADY present wherever
// Hone sends SMS, so keying the real adapter off credentials would arm it in
// production the moment this merges — and arming it means sending real
// verification messages to real phone numbers.
//
// The real adapter therefore needs its OWN flag AND its own Verify Service SID.
// Nothing sets either today: no Twilio Verify Service exists, and creating one
// is a provider action this slice is not authorized to take.
//
// WHAT AN UNCONFIGURED DEPLOYMENT DOES: returns `unavailable` from both
// operations. Not `refused` — that would tell a caller their code was wrong when
// it was never checked — and certainly not `approved`. `unavailable` is the one
// outcome that means "ask again later" and writes nothing.

const REAL_PROVIDER_FLAG = "HONE_MOBILE_VERIFICATION_LIVE";
const VERIFY_SERVICE_SID = "TWILIO_VERIFY_SERVICE_SID";

const fake = new FakeMobileVerificationProvider();

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
 * The provider this deployment should use.
 *
 * B2b-1 SHIPS NO REAL ADAPTER. Until B2b-2 adds one, an armed deployment has
 * nothing to resolve to — so this returns the fake and `liveMobileVerificationArmed`
 * exists to make the armed/unarmed distinction testable and reviewable before
 * the adapter lands. The state machine above is written against the interface,
 * so installing the real adapter changes one line here and nothing else.
 */
export function resolveMobileVerificationProvider(): MobileVerificationProvider {
  return fake;
}

export { FakeMobileVerificationProvider, FAKE_VERIFICATION_CODE } from "./fake-provider";
export type {
  MobileVerificationProvider,
  VerificationCheckOutcome,
  VerificationDestination,
  VerificationStartOutcome,
} from "./types";
