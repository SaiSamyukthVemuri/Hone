import "server-only";

// WAIT B2b — WHAT "ARMED" MEANS, DEFINED ONCE.
//
// WHY THIS FILE EXISTS, AND IT IS NOT TIDINESS. B2b-2's first revision defined the
// arming predicate in ./index.ts and had the adapter check only the three Twilio
// credentials. Those two things were described in that adapter's own comment as
// "the second of the two independent checks", and that was FALSE: they checked
// DIFFERENT things. The flag had exactly one enforcement point, in the resolver.
//
// THAT WAS A LIVE-SEND BYPASS, and a reachable one, because the same revision also
// exported the adapter class:
//
//   * `new TwilioVerifyProvider().start(...)` sent a REAL SMS with the flag unset,
//     in any deployment that already sends SMS -- which is every production
//     deployment, since TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are already there.
//   * a provider obtained from the resolver BEFORE the flag was unset kept working
//     afterwards, so the documented rollback ("unset the flag") did not disarm a
//     held instance. The rollback step in the activation checklist was wrong.
//
// Both were reproduced as failing tests before this file existed.
//
// SO THERE IS ONE DEFINITION AND TWO ENFORCEMENT POINTS. The resolver refuses to
// hand out a live adapter, AND the adapter refuses to act. Two places that can
// fail independently, both reading the same predicate, is what the adapter's
// comment claimed and did not have. A circular import is what kept it from being
// this way -- index.ts imports the adapter -- so the predicate moved here, below
// both of them.

const REAL_PROVIDER_FLAG = "HONE_MOBILE_VERIFICATION_LIVE";
const VERIFY_SERVICE_SID = "TWILIO_VERIFY_SERVICE_SID";

/**
 * True only when the deployment has explicitly armed live verification AND every
 * piece of configuration the real adapter needs is present.
 *
 * ALL FOUR ARE REQUIRED, and the flag is not redundant with the credentials: the
 * credentials are ALREADY PRESENT wherever Hone sends SMS, so a predicate keyed on
 * them would arm live verification the moment this code merged. The flag is the
 * only input an operator has to add deliberately, which is the whole reason it
 * exists separately.
 *
 * READ PER CALL, never cached. "Unset the flag" is the documented rollback, and a
 * cached answer would make that rollback need a redeploy.
 */
export function liveMobileVerificationArmed(): boolean {
  return (
    process.env[REAL_PROVIDER_FLAG] === "true" &&
    Boolean(process.env.TWILIO_ACCOUNT_SID) &&
    Boolean(process.env.TWILIO_AUTH_TOKEN) &&
    Boolean(process.env[VERIFY_SERVICE_SID])
  );
}
