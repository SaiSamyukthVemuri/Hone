import "server-only";
import { canonicalClaimPhoneNumber } from "./claim-phone-number";
import { fenceProviderMutations } from "./provider/fenced";
import { safeResourceId } from "./provider/association";
import { asMessagingServiceSid } from "./provider/types";
import type { NumberAssociation, SmsProvisioningProvider } from "./provider/types";
import type { AttemptErrorCode, ClaimResult, ProvisioningStore } from "./provisioning";

// COMMS — CONFIGURE AN EXISTING STUDIO-OWNED SENDER.
//
// WHY THIS IS A SEPARATE CAPABILITY FROM ADOPTION, AND MUST STAY ONE.
//
// `adoptExistingStudioSmsSender` ends at `provider_configuration_required` on
// purpose. An existing studio-owned Messaging Service is not a freshly
// purchased Hone-owned one: it may already serve something today, and pointing
// its webhooks at Hone could silently break that. Adoption therefore INSPECTS
// and REFUSES, and the refusal is the honest end of a read-only path.
//
// This module is the other half: the deliberate human decision that resolves
// that refusal. Keeping it separate is the whole safety property. If adoption
// could repair its own refusal, the operator would never see the decision, and
// "adopt this number" would quietly rewrite a service Hone does not own.
//
// WHAT IT MAY CHANGE, EXHAUSTIVELY: the inbound webhook and the status callback
// on the ONE Messaging Service the operator named, and only the limbs that
// actually differ. It does not purchase, release, create a service, attach or
// detach a number, send a message, or activate a sender. Activation still
// belongs to adoption, which re-proves everything from scratch afterwards.
//
// PROVE, THEN ACT — the order is the design, exactly as in adoption. Ownership
// and association are established BEFORE any write, re-established immediately
// before the write, and the result is verified by RE-READING the provider
// rather than by trusting the write's own acknowledgement.

/** The only two limbs this capability is permitted to change. */
export type ConfigurationLimb = "inbound_webhook" | "status_callback";

/**
 * Refusals unique to configuration. None is recoverable by retrying with the
 * same inputs; each names a fact about the provider the operator must fix or
 * re-check first.
 */
export type ConfigureRefusal =
  | "invalid_input"
  | "invalid_service_identifier"
  | "number_not_owned_by_account"
  | "number_not_in_named_service"
  | "number_in_other_service"
  | "number_association_ambiguous"
  | "number_association_unavailable"
  | "provider_number_mismatch"
  | "sender_already_active"
  | "resource_changed_before_write"
  | "post_write_verification_failed";

type Discovered = {
  association: NumberAssociation["kind"];
  safeServiceIds: string[];
};

export type ConfigureOutcome =
  | {
      ok: true;
      /** Provider already matches Hone. ZERO writes were performed. */
      result: "already_configured";
      senderId: string;
      providerWrites: 0;
    }
  | {
      ok: true;
      /**
       * INSPECTION ONLY. What would change, and nothing changed. This is what
       * an operator sees before deciding, and it performs zero writes.
       */
      result: "configuration_required";
      senderId: string;
      mismatched: ConfigurationLimb[];
      providerWrites: 0;
    }
  | {
      ok: true;
      /** The named limbs were written AND re-read as correct. Not activated. */
      result: "configured";
      senderId: string;
      changed: ConfigurationLimb[];
      providerWrites: number;
    }
  | {
      ok: false;
      /** A live attempt owns this studio. No provider effect was performed. */
      result: "in_progress";
      senderId: string | null;
    }
  | { ok: false; result: "lease_lost"; senderId: string }
  | {
      ok: false;
      result: "refused" | "failed";
      /**
       * Includes the CLAIM's own refusals verbatim. An authority refusal is the
       * database's word, and flattening it into a generic code would lose the
       * one distinction an operator needs: "you may not do this here" is not
       * the same as "the provider said no".
       */
      reason: AttemptErrorCode | ConfigureRefusal | ClaimResult;
      retryable: boolean;
      discovered?: Discovered;
      /** Which limbs still did not match, when verification is what failed. */
      mismatched?: ConfigurationLimb[];
      providerWrites: number;
    };

export type ConfigureInput = {
  store: ProvisioningStore;
  /** UNFENCED. Fencing is applied here, by construction, and cannot be skipped. */
  provider: SmsProvisioningProvider;
  studioId: string;
  actorUserId: string;
  country: string;
  /** The number the studio ALREADY owns. Never substituted, never searched for. */
  phoneNumber: string;
  /** The service the studio ALREADY has. Never created, never attached to. */
  messagingServiceSid: string;
  requiredInboundWebhookUrl: string;
  requiredStatusCallbackUrl: string;
  /**
   * THE EXECUTION GATE, and it is deliberately not a boolean flag with a
   * default. "inspect" is the only mode reachable by accident; performing a
   * provider write requires the caller to have named it.
   */
  mode: "inspect" | "configure";
};

const CONFIGURE_REFUSALS: ReadonlySet<string> = new Set<ConfigureRefusal>([
  "invalid_input",
  "invalid_service_identifier",
  "number_not_owned_by_account",
  "number_not_in_named_service",
  "number_in_other_service",
  "number_association_ambiguous",
  "number_association_unavailable",
  "provider_number_mismatch",
  "sender_already_active",
  "resource_changed_before_write",
  "post_write_verification_failed",
]);

function isConfigureRefusal(v: string): v is ConfigureRefusal {
  return CONFIGURE_REFUSALS.has(v);
}

/**
 * Resolve `provider_configuration_required` for an already-owned sender.
 *
 * Returns without activating anything. Adoption remains the only path to
 * `active`, and it re-proves ownership, association, configuration and a real
 * provider test from scratch.
 */
export async function configureExistingStudioSmsSender(
  input: ConfigureInput,
): Promise<ConfigureOutcome> {
  // --- 0. Canonicalise ONCE, at the boundary -------------------------------
  // Everything below uses `phoneNumber`. The claim stores the canonical form
  // and the lease fence compares against exactly that, so carrying the raw
  // caller string past this line would make the fence compare the wrong value.
  const phoneNumber = canonicalClaimPhoneNumber(input.phoneNumber);
  if (!phoneNumber) {
    return {
      ok: false,
      result: "refused",
      reason: "invalid_input",
      retryable: false,
      providerWrites: 0,
    };
  }

  // A malformed target is refused BEFORE the claim, because a write addressed
  // to an unparseable SID is the one mistake with no safe failure mode: we
  // cannot know afterwards what, if anything, it touched.
  const targetService = asMessagingServiceSid(input.messagingServiceSid);
  if (!targetService) {
    return {
      ok: false,
      result: "refused",
      reason: "invalid_service_identifier",
      retryable: false,
      providerWrites: 0,
    };
  }

  // --- 1. AUTHORITY, derived by the database and never by the caller -------
  // The claim re-derives studio membership AND owner role from (studio_id,
  // authenticated user id). A studio id arriving from a browser proves nothing
  // on its own, so this is the only thing that authorises the write below.
  // It also SERIALISES: two operators pressing configure at once cannot both
  // hold the attempt, so they cannot interleave partial limb writes.
  const claim = await input.store.claim({
    studioId: input.studioId,
    actorUserId: input.actorUserId,
    country: input.country.trim().toUpperCase(),
    areaCode: null,
    phoneNumber,
  });

  if (claim.result === "already_active") {
    // An active sender is not this capability's business. Rewriting the
    // webhooks of a service that is currently delivering client messages is
    // exactly the silent breakage this whole path exists to avoid.
    return {
      ok: false,
      result: "refused",
      reason: "sender_already_active",
      retryable: false,
      providerWrites: 0,
    };
  }
  if (claim.result === "claim_held") {
    return { ok: false, result: "in_progress", senderId: claim.senderId };
  }
  if (claim.result !== "claimed") {
    return {
      ok: false,
      result: "refused",
      reason: claim.result,
      retryable: false,
      providerWrites: 0,
    };
  }

  const claimKey = claim.claimKey;
  const leaseGeneration = claim.leaseGeneration;
  const senderId = claim.senderId;
  if (!claimKey || leaseGeneration === null || !senderId) {
    return {
      ok: false,
      result: "refused",
      reason: "not_claimable",
      retryable: false,
      providerWrites: 0,
    };
  }

  // Every provider call below is fenced by construction: a displaced worker
  // stops at its earliest await rather than carrying stale evidence toward a
  // write that belongs to a newer generation.
  const provider = fenceProviderMutations(input.provider, () =>
    input.store.renewLease({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      phoneNumber,
    }),
  );

  let providerWrites = 0;

  /** Park the attempt, and let a refused write outrank our own story. */
  const failWith = async (
    reason: AttemptErrorCode | ConfigureRefusal,
    retryable: boolean,
    detail: { discovered?: Discovered; mismatched?: ConfigurationLimb[] } = {},
  ): Promise<ConfigureOutcome> => {
    const parked = await input.store.fail({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      // 0191's vocabulary has no configuration-specific code; a refusal about
      // the provider's resources is recorded under the closest one it accepts.
      errorCode: isConfigureRefusal(reason) ? "provider_resource_mismatch" : reason,
    });
    if (parked === "lease_lost") {
      // The database says a newer worker owns this row. That answer outranks
      // ours: reporting our reason would overwrite a newer truth with a stale
      // one, which is the defect fenced reads exist to prevent.
      return { ok: false, result: "lease_lost", senderId };
    }
    return {
      ok: false,
      result: "refused",
      reason,
      retryable,
      providerWrites,
      ...detail,
    };
  };

  /**
   * Prove the number is owned by this account AND sits in the exact named
   * service. Returns the phone number SID on success.
   *
   * Run TWICE: once to decide, and again immediately before the write. The
   * second run is not redundant — it is what makes "the expected resource
   * changed between verification and mutation" a refusal rather than a
   * silently misdirected write.
   */
  const proveAssociation = async (): Promise<
    { ok: true; phoneNumberSid: string } | { ok: false; outcome: ConfigureOutcome }
  > => {
    const owned = await provider.lookupOwnedNumber({
      phoneNumber,
      expectedMessagingServiceSid: targetService,
    });
    if (!owned.ok) {
      if (owned.code === "lease_lost") {
        return { ok: false, outcome: { ok: false, result: "lease_lost", senderId } };
      }
      return { ok: false, outcome: await failWith(owned.code, owned.retryable) };
    }

    const facts = owned.facts;
    if (!facts.phoneNumberSid || !facts.phoneNumber) {
      return {
        ok: false,
        outcome: await failWith("number_not_owned_by_account", false, {
          discovered: { association: facts.association.kind, safeServiceIds: [] },
        }),
      };
    }

    // The provider must be talking about the SAME number we claimed. Anything
    // else means our canonical form and the account's disagree, and a write
    // aimed at a service holding a different number is not the write asked for.
    if (canonicalClaimPhoneNumber(facts.phoneNumber) !== phoneNumber) {
      return { ok: false, outcome: await failWith("provider_number_mismatch", false) };
    }

    const association = facts.association;
    switch (association.kind) {
      case "in_expected_service":
        return { ok: true, phoneNumberSid: facts.phoneNumberSid };
      case "not_associated":
        // This capability configures a service the number ALREADY belongs to.
        // Attaching it is a different, unauthorised effect.
        return {
          ok: false,
          outcome: await failWith("number_not_in_named_service", false, {
            discovered: { association: association.kind, safeServiceIds: [] },
          }),
        };
      case "in_other_service":
        return {
          ok: false,
          outcome: await failWith("number_in_other_service", false, {
            discovered: {
              association: association.kind,
              safeServiceIds: [safeResourceId(association.messagingServiceSid)],
            },
          }),
        };
      case "ambiguous":
        // Two holders is contradictory, not a preference to resolve. Choosing
        // the expected one would write precisely when the provider is saying
        // it does not know where the number is.
        return {
          ok: false,
          outcome: await failWith("number_association_ambiguous", false, {
            discovered: {
              association: association.kind,
              safeServiceIds: association.messagingServiceSids.map(safeResourceId),
            },
          }),
        };
      case "unavailable":
        // An incomplete census is not absence. Retryable, and never a write.
        return {
          ok: false,
          outcome: await failWith("number_association_unavailable", true, {
            discovered: { association: association.kind, safeServiceIds: [] },
          }),
        };
    }
  };

  // --- 2. PROVE before deciding -------------------------------------------
  const proved = await proveAssociation();
  if (!proved.ok) return proved.outcome;
  const provenPhoneNumberSid = proved.phoneNumberSid;

  // --- 3. COMPARE — which limbs actually differ ----------------------------
  const before = await provider.readMessagingServiceConfig({
    messagingServiceSid: targetService,
  });
  if (!before.ok) {
    if (before.code === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith(before.code, before.retryable);
  }

  const mismatched: ConfigurationLimb[] = [];
  if (before.config.inboundRequestUrl !== input.requiredInboundWebhookUrl) {
    mismatched.push("inbound_webhook");
  }
  if (before.config.statusCallbackUrl !== input.requiredStatusCallbackUrl) {
    mismatched.push("status_callback");
  }

  // --- 4. IDEMPOTENCY, decided by reading and not by remembering -----------
  // Already correct means ZERO writes, in both modes. A retry after a
  // successful configuration lands here, which is what makes the operation
  // safe to press twice.
  if (mismatched.length === 0) {
    return { ok: true, result: "already_configured", senderId, providerWrites: 0 };
  }

  // --- 5. THE EXECUTION GATE ----------------------------------------------
  if (input.mode !== "configure") {
    return {
      ok: true,
      result: "configuration_required",
      senderId,
      mismatched,
      providerWrites: 0,
    };
  }

  // --- 6. RE-PROVE immediately before writing ------------------------------
  // Everything above was read under the fence, but the fence proves we still
  // hold the LEASE, not that the provider still looks the way it did. A number
  // moved out of the service between step 2 and here must not receive a write
  // aimed at where it used to be.
  const reproved = await proveAssociation();
  if (!reproved.ok) return reproved.outcome;
  if (reproved.phoneNumberSid !== provenPhoneNumberSid) {
    return failWith("resource_changed_before_write", false);
  }

  // --- 7. Write ONLY the limbs that differ ---------------------------------
  if (mismatched.includes("inbound_webhook")) {
    const ack = await provider.configureInboundWebhook({
      messagingServiceSid: targetService,
      inboundWebhookUrl: input.requiredInboundWebhookUrl,
    });
    // Counted whether or not it succeeded: a failed write may still have
    // landed, and an operator reading "0 writes" after a timeout would be
    // reading a lie.
    providerWrites += 1;
    if (!ack.ok) {
      if (ack.code === "lease_lost") return { ok: false, result: "lease_lost", senderId };
      return failWith(ack.code, ack.retryable);
    }
  }

  if (mismatched.includes("status_callback")) {
    const ack = await provider.configureStatusCallback({
      messagingServiceSid: targetService,
      statusCallbackUrl: input.requiredStatusCallbackUrl,
    });
    providerWrites += 1;
    if (!ack.ok) {
      if (ack.code === "lease_lost") return { ok: false, result: "lease_lost", senderId };
      return failWith(ack.code, ack.retryable);
    }
  }

  // --- 8. VERIFY BY RE-READING, never by trusting the acknowledgement ------
  // A 2xx says the request was accepted, not that the resource now holds the
  // value. The authority on provider state is the provider, read back.
  const after = await provider.readMessagingServiceConfig({
    messagingServiceSid: targetService,
  });
  if (!after.ok) {
    if (after.code === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    // We wrote and cannot confirm. That is a failure, not a success with a
    // caveat: the operator must re-run rather than proceed to adoption.
    return failWith(after.code, after.retryable);
  }

  const stillWrong: ConfigurationLimb[] = [];
  if (after.config.inboundRequestUrl !== input.requiredInboundWebhookUrl) {
    stillWrong.push("inbound_webhook");
  }
  if (after.config.statusCallbackUrl !== input.requiredStatusCallbackUrl) {
    stillWrong.push("status_callback");
  }
  if (stillWrong.length > 0) {
    return failWith("post_write_verification_failed", false, { mismatched: stillWrong });
  }

  // --- 9. Stop here. Configuration is not activation. ----------------------
  // The sender stays exactly as claimed; adoption is what proves a real send
  // and moves it to `active`, and it re-checks every one of these facts.
  return { ok: true, result: "configured", senderId, changed: mismatched, providerWrites };
}
