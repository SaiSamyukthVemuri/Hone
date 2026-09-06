import "server-only";
import { fenceProviderMutations } from "./provider/fenced";
import type { SmsProvisioningProvider } from "./provider/types";
import { safeResourceId } from "./provider/association";
import type { NumberAssociation } from "./provider/types";
import type { AttemptErrorCode, ProvisioningStore } from "./provisioning";

// ===========================================================================
// WILLOW ADOPTION — establish the 0191 lifecycle over an ALREADY-OWNED sender
// ===========================================================================
//
// WHY THIS IS NOT A FLAG ON THE PURCHASE PATH
// ---------------------------------------------------------------------------
// Willow already owns a Twilio number and a Messaging Service. Provisioning it
// through `provisionStudioSmsSender` would search availability for a number the
// account already holds (it is not available — Willow owns it), and then buy a
// second one. "Adopt" is a genuinely different provider operation, so it is a
// separate orchestration that CONVERGES with purchase only after ownership and
// association have been PROVEN.
//
// ADOPT IS NOT "PRETEND PURCHASE SUCCEEDED". Nothing here fabricates a SID, and
// nothing here writes `active`. The identifiers come from the provider's own
// answer about resources it already holds, and activation still runs through
// 0191's `finalize` with a REAL provider-test result.
//
// WHAT IT REUSES UNCHANGED, and this is most of it:
//   claim()        — same durable claim, same write-once number binding,
//                    same owner re-derivation, same lease generation
//   renewLease()   — same fence, via fenceProviderMutations
//   finalize()     — same identifier write, same readiness rule
//   fail()         — same parking, same error vocabulary
// No migration. No new command. No schema change. 0191's finalize takes
// identifiers and a test result; it has never cared where they came from.
//
// WHAT IT REFUSES TO DO
//   - purchase anything (purchaseNumber is never called; the guard proves it)
//   - create a Messaging Service
//   - attach or move the number between services
//   - configure anything before ownership is proven
//   - write ACTIVE without a genuine provider test
//   - fall back to the deployment-global sender
//
// THE MOVE HAZARD, AND WHY MEMBERSHIP IS THREE-STATE. Twilio lets a number
// belong to exactly one Messaging Service, so "attach" is really "move". If the
// operator names service X and the number is quietly in service Y, attaching
// would silently take it out of Y — breaking whatever Y served. So adoption
// REQUIRES the number to be a member of the named service ALREADY, and treats
// an unreadable membership answer as a refusal, never as "not a member".
// Attaching is left to a deliberate human act outside Hone.

export type AdoptionOutcome =
  | { ok: true; result: "adopted"; senderId: string; phoneNumber: string }
  | { ok: true; result: "already_active"; senderId: string }
  | { ok: false; result: "refused"; reason: string }
  | { ok: false; result: "in_progress"; senderId: string | null }
  | { ok: false; result: "lease_lost"; senderId: string | null }
  | {
      ok: false;
      result: "failed";
      reason: AttemptErrorCode | AdoptionRefusal;
      retryable: boolean;
      /**
       * What the census actually found, when the refusal is about WHERE the
       * number lives. Redacted to a recognisable-but-unusable form: an operator
       * can match it in the Twilio console, an ordinary log line cannot leak a
       * working identifier.
       */
      discovered?: { association: NumberAssociation["kind"]; safeServiceIds: string[] };
      /** Which required configuration did not match. Never the URLs themselves. */
      configurationMismatch?: Array<"inbound_webhook" | "status_callback">;
    };

/** Refusals unique to adoption. None of them is recoverable by retrying. */
export type AdoptionRefusal =
  | "number_not_owned_by_account"
  | "number_not_in_named_service"
  | "number_in_other_service"
  | "number_association_ambiguous"
  | "number_association_unavailable"
  | "provider_configuration_required"
  | "provider_number_mismatch";

export type AdoptionInput = {
  store: ProvisioningStore;
  provider: SmsProvisioningProvider;
  studioId: string;
  actorUserId: string;
  country: string;
  /** The number the studio ALREADY owns. Never substituted, never searched for. */
  phoneNumber: string;
  /** The Messaging Service the studio ALREADY has. Never created, never changed. */
  messagingServiceSid: string;
  /** Hone's REQUIRED inbound URL. Compared against, never written. */
  requiredInboundWebhookUrl: string;
  /** Hone's REQUIRED status callback. Compared against, never written. */
  requiredStatusCallbackUrl: string;
  testDestination: string;
  testBody: string;
};

/**
 * Adopt an existing sender into 0191's lifecycle.
 *
 * The order is the whole design: PROVE, then act. Every provider call after the
 * claim runs through the fence wrapper, so a displaced worker stops at the
 * earliest await rather than carrying stale evidence toward a finalize.
 */
export async function adoptExistingStudioSmsSender(
  input: AdoptionInput,
): Promise<AdoptionOutcome> {
  // --- 1. The SAME claim the purchase path takes ---------------------------
  // Same command, same arguments, same authorization: the database re-derives
  // membership and owner role from (studio_id, actor_user_id). Adoption gets no
  // privileged entry — an operator running this for a studio is still subject to
  // the studio's own ownership rules.
  const claim = await input.store.claim({
    studioId: input.studioId,
    actorUserId: input.actorUserId,
    country: input.country.trim().toUpperCase(),
    areaCode: null,
    phoneNumber: input.phoneNumber,
  });

  if (claim.result === "already_active") {
    return { ok: true, result: "already_active", senderId: claim.senderId ?? "" };
  }
  if (claim.result === "claim_held") {
    // A live attempt owns this studio. Adoption performs NO provider effect.
    return { ok: false, result: "in_progress", senderId: claim.senderId };
  }
  if (claim.result !== "claimed") {
    return { ok: false, result: "refused", reason: claim.result };
  }

  const claimKey = claim.claimKey;
  const leaseGeneration = claim.leaseGeneration;
  const senderId = claim.senderId;
  // A `claimed` result carries all three. Proving it here rather than asserting
  // it keeps the adopted outcome's senderId honestly non-null.
  if (!claimKey || leaseGeneration === null || !senderId) {
    return { ok: false, result: "refused", reason: "not_claimable" };
  }

  // Every provider call below is fenced by construction.
  const provider = fenceProviderMutations(input.provider, () =>
    input.store.renewLease({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      phoneNumber: input.phoneNumber,
    }),
  );

  /** Park the attempt, and let a refused write outrank our own story. */
  const failWith = async (
    reason: AttemptErrorCode | AdoptionRefusal,
    retryable: boolean,
    detail: {
      discovered?: { association: NumberAssociation["kind"]; safeServiceIds: string[] };
      configurationMismatch?: Array<"inbound_webhook" | "status_callback">;
    } = {},
  ): Promise<AdoptionOutcome> => {
    const parked = await input.store.fail({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      // The store's vocabulary is 0191's; an adoption-specific refusal is
      // recorded under the closest provider code it already accepts.
      errorCode: isAdoptionRefusal(reason) ? "provider_resource_mismatch" : reason,
    });
    if (parked === "lease_lost") {
      return { ok: false, result: "lease_lost", senderId };
    }
    return { ok: false, result: "failed", reason, retryable, ...detail };
  };

  // --- 2. PROVE OWNERSHIP AND ASSOCIATION, before touching anything --------
  const facts = await provider.lookupOwnedNumber({
    phoneNumber: input.phoneNumber,
    expectedMessagingServiceSid: input.messagingServiceSid,
  });
  if (!facts.ok) {
    if (facts.code === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith(facts.code, facts.retryable);
  }

  const { phoneNumberSid, phoneNumber, association } = facts.facts;

  if (!phoneNumberSid) {
    // The account does not own it. Adoption has nothing to adopt, and the one
    // thing it must never do here is fall through to buying it.
    return failWith("number_not_owned_by_account", false);
  }
  if (phoneNumber !== input.phoneNumber) {
    return failWith("provider_number_mismatch", false);
  }

  // DECISION 2 — the refusal tells the operator WHERE the number actually is.
  // "Not in the service you named" is true but useless; an operator hearing it
  // will reasonably assume the number is free, and the next thing they do is
  // attach it out of a service that may be carrying live traffic.
  switch (association.kind) {
    case "in_expected_service":
      break;
    case "in_other_service":
      return failWith("number_in_other_service", false, {
        discovered: {
          association: "in_other_service",
          safeServiceIds: [safeResourceId(association.messagingServiceSid)],
        },
      });
    case "not_associated":
      return failWith("number_not_in_named_service", false, {
        discovered: { association: "not_associated", safeServiceIds: [] },
      });
    case "ambiguous":
      // Two services claiming one number is contradictory, not a preference to
      // resolve. Choosing the expected one would let adoption proceed exactly
      // when the provider is saying it does not know where the number is.
      return failWith("number_association_ambiguous", false, {
        discovered: {
          association: "ambiguous",
          safeServiceIds: association.messagingServiceSids.map(safeResourceId),
        },
      });
    case "unavailable":
      // An incomplete census is not absence. Retryable: a later attempt may read
      // the pages it could not.
      return failWith("number_association_unavailable", true, {
        discovered: { association: "unavailable", safeServiceIds: [] },
      });
  }

  // --- 3. DECISION 1 — COMPARE the configuration. Never write it. ----------
  // An existing studio-owned Messaging Service is not a freshly purchased
  // Hone-owned one. Pointing its webhooks at Hone could silently break whatever
  // it serves today, so adoption inspects and refuses; the mutation needs an
  // explicit human decision and is not part of this path.
  const current = await provider.readMessagingServiceConfig({
    messagingServiceSid: input.messagingServiceSid,
  });
  if (!current.ok) {
    if (current.code === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith(current.code, current.retryable);
  }

  const mismatched: Array<"inbound_webhook" | "status_callback"> = [];
  if (current.config.inboundRequestUrl !== input.requiredInboundWebhookUrl) {
    mismatched.push("inbound_webhook");
  }
  if (current.config.statusCallbackUrl !== input.requiredStatusCallbackUrl) {
    mismatched.push("status_callback");
  }
  if (mismatched.length > 0) {
    // NOT a provider-test failure and NOT an activation. A distinct, typed
    // result an operator can act on.
    return failWith("provider_configuration_required", false, {
      configurationMismatch: mismatched,
    });
  }

  // --- 4. A REAL provider test. There is no adoption shortcut. -------------
  const test = await provider.sendProvisioningTest({
    messagingServiceSid: input.messagingServiceSid,
    to: input.testDestination,
    body: input.testBody,
  });

  if (!test.ok) {
    if (test.code === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    // Record the identifiers WITHOUT activating: the resources are real and
    // must be remembered, but an untested sender is not a sender.
    const parked = await input.store.finalize({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      phoneNumber: input.phoneNumber,
      phoneNumberSid,
      messagingServiceSid: input.messagingServiceSid,
      testOk: false,
    });
    if (parked === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith(test.code, test.retryable);
  }

  // --- 5. 0191's finalize, unchanged --------------------------------------
  const finalized = await input.store.finalize({
    studioId: input.studioId,
    claimKey,
    leaseGeneration,
    phoneNumber: input.phoneNumber,
    phoneNumberSid,
    messagingServiceSid: input.messagingServiceSid,
    testOk: true,
  });

  if (finalized === "activated" || finalized === "already_active") {
    return { ok: true, result: "adopted", senderId, phoneNumber: input.phoneNumber };
  }
  if (finalized === "lease_lost") {
    return { ok: false, result: "lease_lost", senderId };
  }
  return failWith(
    finalized === "conflict" ? "finalize_conflict" : "finalize_failed",
    finalized !== "conflict",
  );
}

function isAdoptionRefusal(reason: string): reason is AdoptionRefusal {
  return (
    reason === "number_not_owned_by_account" ||
    reason === "number_not_in_named_service" ||
    reason === "service_membership_unknown" ||
    reason === "provider_number_mismatch"
  );
}
