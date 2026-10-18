import "server-only";
import { FakeSmsProvisioningProvider } from "./fake-provider";
import { twilioProvisioningProvider } from "./twilio-provider";
import type { SmsProvisioningProvider } from "./types";

// Provider selection (COMMS-01B).
//
// FAKE IS THE DEFAULT AND THE REAL ADAPTER IS OPT-IN, not the other way round.
// The failure mode being designed against is a deployment, a preview build, a
// CI job or a local test run quietly renting phone numbers because an
// environment variable happened to be present. TWILIO_ACCOUNT_SID and
// TWILIO_AUTH_TOKEN are ALREADY set wherever Hone sends SMS today, so keying
// the real adapter off credentials alone would arm it in production the moment
// this merges.
//
// The real adapter therefore requires its OWN explicit flag, whose only
// purpose is to say "provisioning may spend money here". Until COMMS-01B is
// separately authorized for a controlled provider exercise, nothing sets it.
//
// Note what this does NOT gate: sending. lib/sms/twilio.ts is untouched and
// keeps using the deployment-global sender exactly as before.

const REAL_PROVIDER_FLAG = "HONE_SMS_PROVISIONING_LIVE";

/** Shared fake instance for the running process. */
const fake = new FakeSmsProvisioningProvider();

/** The process-wide fake, for tests and for inspection. */
export function fakeSmsProvisioningProvider(): FakeSmsProvisioningProvider {
  return fake;
}

/**
 * True only when the deployment has explicitly armed live provisioning AND the
 * account credentials are present. Both are required: the flag alone cannot
 * spend money, and credentials alone must not.
 */
export function liveProvisioningArmed(): boolean {
  return (
    process.env[REAL_PROVIDER_FLAG] === "true" &&
    Boolean(process.env.TWILIO_ACCOUNT_SID) &&
    Boolean(process.env.TWILIO_AUTH_TOKEN)
  );
}

export function resolveProvisioningProvider(): SmsProvisioningProvider {
  return liveProvisioningArmed() ? twilioProvisioningProvider : fake;
}

export { FakeSmsProvisioningProvider } from "./fake-provider";
export { twilioProvisioningProvider } from "./twilio-provider";
export * from "./types";
