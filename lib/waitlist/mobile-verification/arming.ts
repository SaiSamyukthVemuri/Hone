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
 * READ PER CALL, NEVER CACHED — AND WHAT THAT DOES AND DOES NOT BUY IS WORTH
 * BEING EXACT ABOUT, BECAUSE AN EARLIER REVISION OF THIS COMMENT GOT IT BACKWARDS.
 *
 * IT DOES buy: no module-level or instance-level state to get stale, so within a
 * running deployment the resolver and the adapter always agree, and an adapter
 * instance held across a change in `process.env` goes inert on its next call
 * rather than at some later lifecycle event. That is what makes the two
 * enforcement points genuinely independent, and it is the fix for the first P1.
 *
 * IT DOES NOT buy a hot rollback, and the earlier comment claimed it did. Hone is
 * hosted on Vercel (README.md), and unsetting a hosted environment variable does
 * NOT mutate `process.env` in the deployment already serving traffic. So a
 * deployment that was armed keeps reading `"true"` until it is REDEPLOYED. Reading
 * per call cannot change that: there is nothing new to read.
 *
 * THE HOUSE MODEL FOR AN ENV-BACKED KILL SWITCH IS "UNSET PLUS REDEPLOY", and this
 * repository already wrote it down for live payments: `docs/13_BACKLOG_AND_-
 * DECISIONS.md` gives the STRIPE_ALLOW_LIVE_MODE rollback as "unset … + redeploy".
 * This gate is the same shape and takes the same rollback. The activation
 * checklist says so, and says to VERIFY the running deployment afterwards rather
 * than assume the unset took effect.
 *
 * A HOT KILL SWITCH WOULD NEED RUNTIME-MUTABLE STATE — Edge Config, a row, a
 * cache key — and choosing one is a real decision, not a detail: it adds a
 * dependency in the path of every verification, and it has to fail CLOSED when
 * that store is unreachable, which is the opposite of how this codebase's rate
 * limiter treats its store. That is owner decision D7 and it is deliberately not
 * taken here.
 */
export function liveMobileVerificationArmed(): boolean {
  return (
    process.env[REAL_PROVIDER_FLAG] === "true" &&
    Boolean(process.env.TWILIO_ACCOUNT_SID) &&
    Boolean(process.env.TWILIO_AUTH_TOKEN) &&
    Boolean(process.env[VERIFY_SERVICE_SID])
  );
}
