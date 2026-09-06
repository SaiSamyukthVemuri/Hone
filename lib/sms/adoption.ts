import "server-only";
import { fenceProviderMutations } from "./provider/fenced";
import type { SmsProvisioningProvider } from "./provider/types";
import { canonicalClaimPhoneNumber } from "./claim-phone-number";
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
  | "provider_number_mismatch"
  | "provider_test_sender_mismatch";

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
  // --- 0. ONE canonical number, derived at the boundary --------------------
  // Everything below uses `phoneNumber`, never `input.phoneNumber`. The claim
  // stores the canonical form and the lease fence compares against exactly that,
  // so carrying the caller's raw string past this line reintroduces the defect.
  const phoneNumber = canonicalClaimPhoneNumber(input.phoneNumber);
  if (!phoneNumber) {
    // Refused, never repaired. A number that is not E.164 after trimming is not
    // a number this studio chose.
    return { ok: false, result: "refused", reason: "invalid_input" };
  }

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
    phoneNumber,
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
      phoneNumber,
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
      errorCode: storeCodeFor(reason),
    });
    if (parked === "lease_lost") {
      return { ok: false, result: "lease_lost", senderId };
    }
    // AND IT MAY HAVE TOLD US THE OPPOSITE: that this sender is already ACTIVE.
    //
    // `fail_studio_sms_provisioning` answers `already_active` by reading the
    // row's status, so this is the DATABASE stating the terminal state has been
    // reached -- not an inference from provider success, not from Hone holding a
    // SID, and emphatically not from finalize having returned `invalid_input`.
    // The store maps BOTH a transport error and an unrecognised payload to
    // `invalid_input`, and neither says anything about whether the transaction
    // committed; the realistic path here is a finalize that COMMITTED while its
    // response was lost, so we came to park and the park found the row live.
    //
    // Reporting a transport error over that would tell the operator adoption
    // failed while the database says the sender is provisioned. The newer
    // terminal truth wins, and it reuses the outcome the claim path already
    // returns for this exact state rather than inventing a new one. This is the
    // same branch provisionStudioSmsSender's failWith already carries; adoption
    // omitted it, which is the whole of the defect.
    if (parked === "already_active") {
      return { ok: true, result: "already_active", senderId };
    }
    return { ok: false, result: "failed", reason, retryable, ...detail };
  };

  // --- 2. PROVE OWNERSHIP AND ASSOCIATION, before touching anything --------
  const facts = await provider.lookupOwnedNumber({
    phoneNumber,
    expectedMessagingServiceSid: input.messagingServiceSid,
  });
  if (!facts.ok) {
    if (facts.code === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith(facts.code, facts.retryable);
  }

  const { phoneNumberSid, phoneNumber: reported, association } = facts.facts;

  if (!phoneNumberSid) {
    // The account does not own it. Adoption has nothing to adopt, and the one
    // thing it must never do here is fall through to buying it.
    return failWith("number_not_owned_by_account", false);
  }
  if (reported !== phoneNumber) {
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
      phoneNumber,
      phoneNumberSid,
      messagingServiceSid: input.messagingServiceSid,
      testOk: false,
    });
    if (parked === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith(test.code, test.retryable);
  }

  // --- 4b. THE TEST PROVED A SERVICE. DID IT PROVE THIS NUMBER? -----------
  // A Messaging Service is a POOL. On a sender Hone just purchased the pool
  // holds exactly one number, so "the service sent" and "this number sent" are
  // the same statement. On an ADOPTED service they are not: the studio's
  // existing service may hold several senders, the provider picks one, and a
  // successful send proves only that SOME sender worked. Activating the
  // selected number on that evidence would mark a number ACTIVE that nothing
  // ever tested.
  //
  // So the sender is OBSERVED, never assumed, and a missing observation is a
  // refusal rather than a benefit of the doubt. No second message is sent: the
  // provider reports the sender it used on the message it already created.
  if (test.sentFrom !== phoneNumber) {
    const parkedIdentifiers = await input.store.finalize({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      phoneNumber,
      phoneNumberSid,
      messagingServiceSid: input.messagingServiceSid,
      testOk: false,
    });
    if (parkedIdentifiers === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith("provider_test_sender_mismatch", false);
  }

  // --- 5. 0191's finalize, unchanged --------------------------------------
  const finalized = await input.store.finalize({
    studioId: input.studioId,
    claimKey,
    leaseGeneration,
    phoneNumber,
    phoneNumberSid,
    messagingServiceSid: input.messagingServiceSid,
    testOk: true,
  });

  if (finalized === "activated" || finalized === "already_active") {
    return { ok: true, result: "adopted", senderId, phoneNumber };
  }
  if (finalized === "lease_lost") {
    return { ok: false, result: "lease_lost", senderId };
  }
  return failWith(
    finalized === "conflict" ? "finalize_conflict" : "finalize_failed",
    finalized !== "conflict",
  );
}

/**
 * Every adoption-specific refusal, mapped deliberately into 0191's own
 * AttemptErrorCode vocabulary.
 *
 * WHY THIS IS A TOTAL RECORD AND NOT A PREDICATE. The previous form was a
 * hand-written `||` chain, and it drifted: it still named
 * `service_membership_unknown`, a member that had been renamed away, and it
 * covered four of seven. The four it missed passed straight through to
 * `store.fail({ errorCode })` and persisted as `last_error_code` — which 0191
 * does not reject, because its CHECK constrains only the SHAPE
 * (`^[a-z][a-z0-9_]{2,63}$`) and an adoption-only string satisfies that. So the
 * failure was silent: a code no other part of Hone understands, sitting in the
 * column every other reader treats as provider vocabulary.
 *
 * As a `Record<AdoptionRefusal, AttemptErrorCode>` a new refusal added without a
 * mapping is a COMPILE ERROR, which is the only version of this that stays true.
 *
 * The caller still receives the rich adoption reason; only what PERSISTS is
 * normalized.
 */
export const REFUSAL_TO_STORE_CODE: Record<AdoptionRefusal, AttemptErrorCode> = {
  // The account does not hold it, holds it somewhere else, holds it twice, or
  // answered about a different number: in every case a resource we asked about
  // does not match what we expected, which is exactly what this code means.
  number_not_owned_by_account: "provider_resource_mismatch",
  number_not_in_named_service: "provider_resource_mismatch",
  number_in_other_service: "provider_resource_mismatch",
  number_association_ambiguous: "provider_resource_mismatch",
  provider_number_mismatch: "provider_resource_mismatch",
  // The service exists and does not carry the configuration Hone requires.
  provider_configuration_required: "provider_resource_mismatch",
  // The census could not be COMPLETED — the provider could not be fully read.
  // Retryable in nature, and `provider_unavailable` is the honest code for it.
  number_association_unavailable: "provider_unavailable",
  // The pool sent from someone else, or reported no sender. The message went
  // out and the provider is healthy; what failed is the proof about THIS number.
  provider_test_sender_mismatch: "provider_resource_mismatch",
};

function storeCodeFor(reason: AttemptErrorCode | AdoptionRefusal): AttemptErrorCode {
  return reason in REFUSAL_TO_STORE_CODE
    ? REFUSAL_TO_STORE_CODE[reason as AdoptionRefusal]
    : (reason as AttemptErrorCode);
}
