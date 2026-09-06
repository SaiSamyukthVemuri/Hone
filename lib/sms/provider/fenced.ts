import "server-only";
import { providerError, type SmsProvisioningProvider } from "./types";

// FENCE BY CONSTRUCTION (COMMS-01B).
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT ANOTHER `await stillOurs()`.
//
// Three consecutive reviews found the same defect wearing three faces:
//
//   1. the purchase was fenced; the ADOPTED path (a worker that stalled AFTER
//      buying) was not, so it could still create a second messaging service;
//   2. provider mutations were fenced; the finalize-error WRITE was not;
//   3. a write's `lease_lost` answer was discarded and a stale provider error
//      reported over it.
//
// Each was fixed where it was found. That is the mistake. The defect is not
// three oversights, it is one missing abstraction: fencing was a RULE THE
// CALLER HAD TO REMEMBER, applied by hand at each await, and a rule you have
// to remember is a rule that is eventually forgotten -- especially at a call
// site added months later by someone who never read this comment.
//
// So the fence stops being a rule and becomes a TYPE. This wrapper implements
// the whole provider port. EVERY operation a provisioning attempt performs --
// billable effect and claim-scoped read alike -- proves the generation
// immediately before it. Only the pre-claim browse passes through, because no
// generation exists yet to check. The orchestration receives a provider that
// CANNOT perform an unfenced operation, so there is no call site left at which
// to forget.
//
// THE COMPILE-TIME PART, WHICH IS THE POINT: this is an explicit object
// implementing `SmsProvisioningProvider`, not a Proxy and not a spread. Adding
// a method to the port breaks this file until the method is classified as
// mutating or read-only. A new billable effect therefore cannot reach
// production unfenced -- it cannot reach `tsc`.
//
// WHAT THIS STILL DOES NOT DO, stated plainly: a takeover landing between the
// fence check and the provider call still races. Twilio's purchase API accepts
// no idempotency key to bind the effect to, so the window cannot be closed
// here, only narrowed to the width of one await. The claim-key FriendlyName is
// what makes the residue discoverable afterwards.

/**
 * Effects that change something OUTSIDE Hone -- money, a rented resource,
 * provider configuration, or a message to a real handset. Fenced.
 */
export const BILLABLE_OR_MUTATING_EFFECTS = [
  "purchaseNumber",
  "createMessagingService",
  "attachNumberToService",
  "configureInboundWebhook",
  "configureStatusCallback",
  "sendProvisioningTest",
] as const;

/**
 * Reads performed UNDER A CLAIM. Also fenced -- and the reasoning is worth
 * stating, because "it's only a GET" is exactly the argument that would leave
 * them out.
 *
 * A displaced worker running these spends nothing. What it must not do is ACT
 * on them, and every action it could take is one await away. Fencing the read
 * makes the worker stop at the earliest possible point rather than carrying a
 * stale answer forward toward a decision, and it removes the judgement call
 * ("is this one safe to leave open?") that produced three defects already.
 *
 * It also closes a real reporting hazard: an availability check that resumed
 * after a takeover would otherwise hand back "that number is gone" for a
 * number the CURRENT generation is provisioning successfully.
 */
export const CLAIM_SCOPED_READS = [
  "isNumberAvailable",
  "lookupResourcesByClaim",
  // WILLOW ADOPTION. A read, so it spends nothing -- but fenced for the same
  // reason as the other two: a displaced worker must not carry "the account
  // owns this number and it is in the right service" forward toward a finalize
  // that belongs to a newer generation.
  "lookupOwnedNumber",
] as const;

/**
 * Reads that happen BEFORE any claim exists -- an owner browsing candidate
 * numbers. There is no generation to check, so there is nothing to fence.
 * This is the only unfenced member of the port, and it is unreachable from a
 * provisioning attempt.
 */
export const PRE_CLAIM_READS = ["searchAvailableNumbers"] as const;

/** Everything a provisioning attempt may do. All of it fenced. */
export const FENCED_PROVIDER_OPERATIONS = [
  ...BILLABLE_OR_MUTATING_EFFECTS,
  ...CLAIM_SCOPED_READS,
] as const;

/** Proves the caller still holds the lease it started with. */
export type LeaseFence = () => Promise<boolean>;

/**
 * Wrap a provider so no externally-mutating effect can run without the fence.
 *
 * The returned object is a full `SmsProvisioningProvider`, so it drops into
 * the orchestration unchanged -- and the orchestration keeps no ability to
 * reach the unfenced one.
 */
export function fenceProviderMutations(
  provider: SmsProvisioningProvider,
  fence: LeaseFence,
): SmsProvisioningProvider {
  /**
   * Check the fence, then act. FAIL CLOSED: only an explicit `true` proceeds,
   * so an unreachable database means "do not spend", never "carry on".
   */
  async function guarded<T>(
    effect: () => Promise<T>,
  ): Promise<T | ReturnType<typeof providerError>> {
    if (!(await fence())) return providerError("lease_lost", false);
    return effect();
  }

  return {
    name: provider.name,

    // --- pre-claim browse: no generation exists, nothing to fence ---------
    searchAvailableNumbers: (input) => provider.searchAvailableNumbers(input),

    // --- claim-scoped reads: fenced, so a displaced worker stops early -----
    isNumberAvailable: (input) => guarded(() => provider.isNumberAvailable(input)),
    lookupResourcesByClaim: (claimKey) =>
      guarded(() => provider.lookupResourcesByClaim(claimKey)),
    lookupOwnedNumber: (input) => guarded(() => provider.lookupOwnedNumber(input)),

    // --- billable / mutating: fenced, every one ---------------------------
    purchaseNumber: (input) => guarded(() => provider.purchaseNumber(input)),
    createMessagingService: (input) =>
      guarded(() => provider.createMessagingService(input)),
    attachNumberToService: (input) =>
      guarded(() => provider.attachNumberToService(input)),
    configureInboundWebhook: (input) =>
      guarded(() => provider.configureInboundWebhook(input)),
    configureStatusCallback: (input) =>
      guarded(() => provider.configureStatusCallback(input)),
    sendProvisioningTest: (input) =>
      guarded(() => provider.sendProvisioningTest(input)),
  };
}
