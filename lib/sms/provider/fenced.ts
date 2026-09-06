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
// the whole provider port. Every externally-mutating method proves the
// generation immediately before it; every read-only method passes straight
// through. The orchestration receives a provider that CANNOT perform an
// unfenced effect, so there is no call site left at which to forget.
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
 * Provider methods that change something OUTSIDE Hone -- money, a rented
 * resource, provider configuration, or a message to a real handset. Each is
 * fenced.
 */
export const MUTATING_PROVIDER_EFFECTS = [
  "purchaseNumber",
  "createMessagingService",
  "attachNumberToService",
  "configureInboundWebhook",
  "configureStatusCallback",
  "sendProvisioningTest",
] as const;

/**
 * Provider methods that only READ. They reserve nothing and spend nothing, so
 * a displaced worker running one costs nothing and is not fenced.
 *
 * A stale worker must still never REPORT one of these answers as the outcome
 * -- an availability check that resumed after a takeover would otherwise tell
 * the owner "that number is gone" while the current generation is busy
 * provisioning it successfully. That is the orchestration's job, not this
 * file's: it inspects every authoritative write's result and lets the
 * database's `lease_lost` outrank whatever this worker was about to say.
 */
export const READ_ONLY_PROVIDER_CALLS = [
  "searchAvailableNumbers",
  "isNumberAvailable",
  "lookupResourcesByClaim",
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

    // --- read-only: no fence, nothing to protect --------------------------
    searchAvailableNumbers: (input) => provider.searchAvailableNumbers(input),
    isNumberAvailable: (input) => provider.isNumberAvailable(input),
    lookupResourcesByClaim: (claimKey) => provider.lookupResourcesByClaim(claimKey),

    // --- mutating: fenced, every one --------------------------------------
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
