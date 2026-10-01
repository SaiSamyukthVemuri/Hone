import "server-only";
import { canonicalClaimPhoneNumber } from "./claim-phone-number";
import { fenceProviderMutations } from "./provider/fenced";
import { safeResourceId } from "./provider/association";
import { asMessagingServiceSid } from "./provider/types";
import type {
  MessagingServiceConfig,
  NumberAssociation,
  SmsProvisioningProvider,
} from "./provider/types";
import type {
  AttemptErrorCode,
  ClaimResult,
  FailResult,
  OwnerAuthority,
  OwnerAuthorityReader,
  ProvisioningStore,
  SenderBindingReader,
} from "./provisioning";

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
// that refusal. Keeping it separate is the whole safety property.
//
// WHAT IT MAY CHANGE, EXHAUSTIVELY: the inbound webhook and the status callback
// on the ONE Messaging Service the operator named, and only the limbs that
// actually differ. It never purchases, releases, creates a service, attaches or
// detaches a number, sends a message, or activates a sender.
//
// ---------------------------------------------------------------------------
// TWO MODES, AND THE LINE BETWEEN THEM IS THE CLAIM.
//
// INSPECT IS A READ. It enforces authority, reads provider truth, and creates
// NOTHING: no attempt row, no claim, no lease. An earlier version of this file
// took a provisioning claim in both modes, which meant merely LOOKING at
// provider truth minted five minutes of durable ownership, blocked the very
// mutation the operator was about to perform, and left stale attempt state
// behind if they simply closed the page. Looking must not have consequences.
//
// CONFIGURE IS A MUTATION. It takes the claim, and then RE-DERIVES EVERYTHING
// from post-claim truth — ownership, association, current configuration — so
// the minimal write is computed from what is true now, under the lease, and
// never from whatever an inspection saw earlier.
//
// The two therefore share no snapshot, and their results share no type. An
// inspect result carries no claim key, no lease and no sender id, so it CANNOT
// be handed to the mutation path as authority: that is a compile-time fact
// rather than a rule someone has to remember.
// ---------------------------------------------------------------------------

/**
 * THE READ-ONLY PROVIDER CAPABILITY, and it is a TYPE rather than a rule.
 *
 * Inspect delegates its provider work to `proveOwnershipAndAssociation`. A
 * source guard that slices the lexical body of `inspectOnly` cannot see inside
 * that helper, so the helper could later gain a `configureInboundWebhook` call
 * and every assertion would stay green -- and the whole-module guard cannot
 * catch it either, because configure legitimately uses those same two methods.
 *
 * So the guarantee stops being textual. The helper accepts ONLY these two
 * reads. Adding a mutating call inside it does not fail a regex; it fails
 * `tsc`, because the method is not on the type. Configure passes its full
 * fenced provider in, which is structurally compatible, so the mutation path
 * loses nothing.
 */
export type InspectionReads = Pick<
  SmsProvisioningProvider,
  "lookupOwnedNumber" | "readMessagingServiceConfig"
>;

/** The only two limbs this capability is permitted to change. */
export type ConfigurationLimb = "inbound_webhook" | "status_callback";

/**
 * Refusals unique to this capability. None is recoverable by retrying with the
 * same inputs; each names a fact the operator must fix or re-check first.
 */
export type ConfigureRefusal =
  | "invalid_input"
  | "invalid_service_identifier"
  | "authority_unavailable"
  | "number_not_owned_by_account"
  | "number_not_in_named_service"
  | "number_in_other_service"
  | "number_association_ambiguous"
  | "number_association_unavailable"
  | "provider_number_mismatch"
  | "sender_already_active"
  | "resource_bound_to_other_studio"
  | "reservation_conflict"
  | "binding_unavailable"
  | "resource_changed_before_write"
  | "post_write_verification_failed";

type Discovered = {
  association: NumberAssociation["kind"];
  safeServiceIds: string[];
};

type RefusalReason = AttemptErrorCode | ConfigureRefusal | ClaimResult | OwnerAuthority;

/**
 * What an INSPECTION may return. Advisory, current-state only.
 *
 * Deliberately carries no sender id, claim key or lease: there is nothing here
 * that a later mutation could treat as permission or as proven truth.
 */
export type InspectOutcome =
  | {
      ok: true;
      result: "inspected";
      /** True when the provider already matches Hone. */
      matches: boolean;
      /** Limbs that differ RIGHT NOW. Advisory — configure recomputes this. */
      mismatched: ConfigurationLimb[];
      providerWrites: 0;
      claimsTaken: 0;
    }
  | {
      ok: false;
      result: "refused";
      reason: RefusalReason;
      retryable: boolean;
      discovered?: Discovered;
      providerWrites: 0;
      claimsTaken: 0;
    };

export type ConfigureOutcome =
  | InspectOutcome
  | {
      ok: true;
      /** Provider already matches Hone. ZERO writes were performed. */
      result: "already_configured";
      senderId: string;
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
      reason: RefusalReason;
      retryable: boolean;
      discovered?: Discovered;
      /** Which limbs still did not match, when verification is what failed. */
      mismatched?: ConfigurationLimb[];
      providerWrites: number;
      /**
       * WHETHER THE ATTEMPT ACTUALLY MOVED TO `error`.
       *
       * Absent before a claim exists -- there is no attempt to park. Present on
       * every post-claim refusal, because REPORTING `retryable` WITHOUT IT IS
       * TRUE AND STILL MISLEADING: the provider problem may well be retryable
       * while the row is still `provisioning` behind a live lease, so the
       * operator's immediate retry is turned away as `in_progress`. Both facts
       * have to travel together, exactly as provisionStudioSmsSender and
       * adoptExistingStudioSmsSender already do.
       */
      parked?: boolean;
      /** The parking write's own verdict, never discarded. */
      parkResult?: FailResult;
    };

export type ConfigureInput = {
  store: ProvisioningStore;
  /**
   * Read-only authority. A separate, narrower port than the store on purpose:
   * the inspect path must be unable to claim, finalize or fail, and giving it
   * only this handle is what makes that structural rather than disciplined.
   */
  authority: OwnerAuthorityReader;
  /**
   * Read-only tenancy authority for the provider resources. Separate from the
   * store so the inspect path cannot claim, finalize or fail.
   */
  bindings: SenderBindingReader;
  /** UNFENCED. The configure path fences it; inspect has no lease to fence to. */
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
   * THE EXECUTION GATE, and deliberately not a boolean with a default.
   * "inspect" is the only mode reachable by accident.
   */
  mode: "inspect" | "configure";
};

const CONFIGURE_REFUSALS: ReadonlySet<string> = new Set<ConfigureRefusal>([
  "invalid_input",
  "invalid_service_identifier",
  "authority_unavailable",
  "number_not_owned_by_account",
  "number_not_in_named_service",
  "number_in_other_service",
  "number_association_ambiguous",
  "number_association_unavailable",
  "provider_number_mismatch",
  "sender_already_active",
  "resource_bound_to_other_studio",
  "reservation_conflict",
  "binding_unavailable",
  "resource_changed_before_write",
  "post_write_verification_failed",
]);

function isConfigureRefusal(v: string): v is ConfigureRefusal {
  return CONFIGURE_REFUSALS.has(v);
}

/** Which required limbs the observed configuration does not satisfy. */
function diffConfiguration(
  config: MessagingServiceConfig,
  requiredInbound: string,
  requiredStatus: string,
): ConfigurationLimb[] {
  const mismatched: ConfigurationLimb[] = [];
  if (config.inboundRequestUrl !== requiredInbound) mismatched.push("inbound_webhook");
  if (config.statusCallbackUrl !== requiredStatus) mismatched.push("status_callback");
  return mismatched;
}

/**
 * Prove the account owns the number AND that it sits in the exact named
 * service. Shared by both modes so they cannot drift apart on what "proven"
 * means — but each mode calls it against its own provider handle and at its own
 * point in time. Nothing is cached between them.
 */
type Proof =
  | { ok: true; phoneNumberSid: string }
  | { ok: false; reason: ConfigureRefusal | AttemptErrorCode; retryable: boolean; discovered?: Discovered };

/**
 * Prove the provider resources are not already another studio's.
 *
 * ONE TWILIO ACCOUNT SERVES EVERY STUDIO, so "the account owns this number and
 * it is in this service" is a statement about the ACCOUNT, not about the
 * tenant. Without this, an owner of a studio with no sender could name another
 * studio's live number and service, claim under their own studio, and rewrite
 * someone else's webhooks. The uniqueness indexes never fire, because this path
 * records no provider identifiers.
 *
 * FAILS CLOSED ON `unavailable`. Not knowing whether a resource belongs to
 * another tenant is precisely the case where proceeding is the cross-tenant
 * write.
 */
async function proveResourceTenancy(
  bindings: SenderBindingReader,
  studioId: string,
  phoneNumberSid: string,
  messagingServiceSid: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: ConfigureRefusal; retryable: boolean; discovered?: Discovered }
> {
  const seen = await bindings.readProviderResourceBindings({
    phoneNumberSid,
    messagingServiceSid,
  });

  for (const [label, binding] of [
    ["phone_number", seen.phoneNumberSid],
    ["messaging_service", seen.messagingServiceSid],
  ] as const) {
    if (binding.kind === "unavailable") {
      return {
        ok: false,
        reason: "binding_unavailable",
        // Retryable: the authority may answer later. Never a write meanwhile.
        retryable: true,
        discovered: { association: "unavailable", safeServiceIds: [label] },
      };
    }
    // EITHER resource being someone else's is disqualifying on its own. A valid
    // -looking service does not license writing to another studio's number, and
    // a valid-looking number does not license writing to another studio's
    // service.
    if (binding.kind === "bound" && binding.studioId !== studioId) {
      return {
        ok: false,
        reason: "resource_bound_to_other_studio",
        retryable: false,
        discovered: { association: "in_other_service", safeServiceIds: [label] },
      };
    }
  }
  return { ok: true };
}

async function proveOwnershipAndAssociation(
  provider: InspectionReads,
  phoneNumber: string,
  targetService: string,
): Promise<Proof> {
  const owned = await provider.lookupOwnedNumber({
    phoneNumber,
    expectedMessagingServiceSid: targetService,
  });
  if (!owned.ok) {
    return { ok: false, reason: owned.code, retryable: owned.retryable };
  }

  const facts = owned.facts;
  if (!facts.phoneNumberSid || !facts.phoneNumber) {
    return {
      ok: false,
      reason: "number_not_owned_by_account",
      retryable: false,
      discovered: { association: facts.association.kind, safeServiceIds: [] },
    };
  }

  // The provider must be talking about the SAME number we were asked about.
  if (canonicalClaimPhoneNumber(facts.phoneNumber) !== phoneNumber) {
    return { ok: false, reason: "provider_number_mismatch", retryable: false };
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
        reason: "number_not_in_named_service",
        retryable: false,
        discovered: { association: association.kind, safeServiceIds: [] },
      };
    case "in_other_service":
      return {
        ok: false,
        reason: "number_in_other_service",
        retryable: false,
        discovered: {
          association: association.kind,
          safeServiceIds: [safeResourceId(association.messagingServiceSid)],
        },
      };
    case "ambiguous":
      // Two holders is contradictory, not a preference to resolve. Choosing the
      // expected one would act precisely when the provider is telling us it
      // does not know where the number is.
      return {
        ok: false,
        reason: "number_association_ambiguous",
        retryable: false,
        discovered: {
          association: association.kind,
          safeServiceIds: association.messagingServiceSids.map(safeResourceId),
        },
      };
    case "unavailable":
      // An incomplete census is not absence. Retryable, and never an action.
      return {
        ok: false,
        reason: "number_association_unavailable",
        retryable: true,
        discovered: { association: association.kind, safeServiceIds: [] },
      };
  }
}

/**
 * Resolve `provider_configuration_required` for an already-owned sender.
 *
 * Returns without activating anything. Adoption remains the only path to
 * `active`, and it re-proves ownership, association, configuration and a real
 * provider test from scratch.
 */
/**
 * The fail-closed answer for a mode this capability does not implement.
 *
 * Deliberately the INSPECT-shaped refusal rather than a new vocabulary: it is
 * the only refusal that carries `claimsTaken: 0`, which is precisely the fact a
 * caller needs about an unrecognised mode -- nothing was claimed, nothing was
 * leased, nothing was written.
 */
function unknownMode(): InspectOutcome {
  return {
    ok: false,
    result: "refused",
    reason: "invalid_input",
    retryable: false,
    providerWrites: 0,
    claimsTaken: 0,
  };
}

export async function configureExistingStudioSmsSender(
  input: ConfigureInput,
): Promise<ConfigureOutcome> {
  // --- 0. Canonicalise ONCE, at the boundary -------------------------------
  const phoneNumber = canonicalClaimPhoneNumber(input.phoneNumber);
  if (!phoneNumber) {
    return input.mode !== "configure"
      ? {
          ok: false,
          result: "refused",
          reason: "invalid_input",
          retryable: false,
          providerWrites: 0,
          claimsTaken: 0,
        }
      : {
          ok: false,
          result: "refused",
          reason: "invalid_input",
          retryable: false,
          providerWrites: 0,
        };
  }

  // A malformed target is refused BEFORE anything else, because a request
  // addressed to an unparseable SID is the one mistake with no safe failure
  // mode: we cannot know afterwards what, if anything, it touched.
  const targetService = asMessagingServiceSid(input.messagingServiceSid);
  if (!targetService) {
    return input.mode !== "configure"
      ? {
          ok: false,
          result: "refused",
          reason: "invalid_service_identifier",
          retryable: false,
          providerWrites: 0,
          claimsTaken: 0,
        }
      : {
          ok: false,
          result: "refused",
          reason: "invalid_service_identifier",
          retryable: false,
          providerWrites: 0,
        };
  }

  // THE MODE BOUNDARY IS EXPLICIT IN BOTH DIRECTIONS, and that is the point.
  //
  // `mode` is a typed union, but a union is a COMPILE-TIME statement and this
  // function is reachable from unvalidated request bodies and version-skewed
  // callers. An `if inspect ... else configure` shape makes the MUTATION the
  // default: `undefined`, `null`, `"configre"`, or any value a newer caller
  // invents all fall through and write to a live Messaging Service. The safe
  // default for a capability that changes provider configuration is to do
  // nothing, so the mutating path is entered only on an exact match and
  // everything else is refused before a claim exists.
  if (input.mode === "inspect") {
    return inspectOnly(input, phoneNumber, targetService);
  }
  if (input.mode === "configure") {
    return configureUnderClaim(input, phoneNumber, targetService);
  }
  return unknownMode();
}

// ---------------------------------------------------------------------------
// INSPECT — authority, reads, and nothing else
// ---------------------------------------------------------------------------

async function inspectOnly(
  input: ConfigureInput,
  phoneNumber: string,
  targetService: string,
): Promise<InspectOutcome> {
  const refuse = (
    reason: RefusalReason,
    retryable: boolean,
    discovered?: Discovered,
  ): InspectOutcome => ({
    ok: false,
    result: "refused",
    reason,
    retryable,
    discovered,
    providerWrites: 0,
    claimsTaken: 0,
  });

  // --- 1. AUTHORITY, still the database's, but READ rather than taken ------
  // Mirrors exactly what the claim derives internally. What it does NOT do is
  // create an attempt, so an operator who merely looks leaves no trace and
  // blocks nothing.
  const authority = await input.authority.readOwnerAuthority({
    studioId: input.studioId,
    actorUserId: input.actorUserId,
  });
  if (authority === "unavailable") {
    // FAIL CLOSED. "We could not check" is not "you may look".
    return refuse("authority_unavailable", true);
  }
  if (authority !== "owner") return refuse(authority, false);

  // --- 2. Provider reads ---------------------------------------------------
  // Unfenced, and that is correct rather than an omission: no claim exists, so
  // there is no generation to prove. This is the same reasoning that leaves the
  // pre-claim browse unfenced in `fenced.ts`. Nothing here can act on what it
  // reads — the only caller of the write path is the configure branch, which
  // takes its own claim and re-derives everything.
  // NARROWED AT THE BOUNDARY. Everything below reaches the provider through
  // `reads`, which structurally cannot mutate. `input.provider` is not used
  // again in this function.
  const reads: InspectionReads = input.provider;

  const proof = await proveOwnershipAndAssociation(reads, phoneNumber, targetService);
  if (!proof.ok) return refuse(proof.reason, proof.retryable, proof.discovered);

  // TENANCY BEFORE DISCLOSURE. Inspection returns which limbs of a service are
  // misconfigured; for a service belonging to another studio that is a readout
  // of someone else's provider state, so the same refusal applies to looking as
  // to writing.
  const tenancy = await proveResourceTenancy(
    input.bindings,
    input.studioId,
    proof.phoneNumberSid,
    targetService,
  );
  if (!tenancy.ok) return refuse(tenancy.reason, tenancy.retryable, tenancy.discovered);

  const current = await reads.readMessagingServiceConfig({
    messagingServiceSid: targetService,
  });
  if (!current.ok) return refuse(current.code, current.retryable);

  const mismatched = diffConfiguration(
    current.config,
    input.requiredInboundWebhookUrl,
    input.requiredStatusCallbackUrl,
  );

  // Advisory only. Deliberately NOT a promise about what configure will do:
  // configure recomputes this from post-claim truth and may see something else.
  return {
    ok: true,
    result: "inspected",
    matches: mismatched.length === 0,
    mismatched,
    providerWrites: 0,
    claimsTaken: 0,
  };
}

// ---------------------------------------------------------------------------
// CONFIGURE — claim, then derive everything fresh under the lease
// ---------------------------------------------------------------------------

async function configureUnderClaim(
  input: ConfigureInput,
  phoneNumber: string,
  targetService: string,
): Promise<ConfigureOutcome> {
  // --- 1. AUTHORITY AND EXCLUSIVITY, both from the claim -------------------
  // The claim re-derives studio membership AND owner role from (studio_id,
  // authenticated user id), and it SERIALISES: two operators pressing configure
  // at once cannot both hold the attempt, so they cannot interleave limb
  // writes. This is the only thing that authorises a write, and no inspection
  // can stand in for it.
  const claim = await input.store.claim({
    studioId: input.studioId,
    actorUserId: input.actorUserId,
    country: input.country.trim().toUpperCase(),
    areaCode: null,
    phoneNumber,
  });

  if (claim.result === "already_active") {
    // An active sender is not this capability's business. Rewriting the
    // webhooks of a service currently delivering client messages is exactly the
    // silent breakage this whole path exists to avoid.
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
    reason: RefusalReason,
    retryable: boolean,
    detail: { discovered?: Discovered; mismatched?: ConfigurationLimb[] } = {},
  ): Promise<ConfigureOutcome> => {
    const parked = await input.store.fail({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      errorCode: isConfigureRefusal(reason) ? "provider_resource_mismatch" : (reason as AttemptErrorCode),
    });
    if (parked === "lease_lost") {
      // The database says a newer worker owns this row. That answer outranks
      // ours: reporting our reason would overwrite a newer truth with a stale
      // one, which is the defect fenced reads exist to prevent.
      return { ok: false, result: "lease_lost", senderId };
    }
    // AND IT MAY HAVE TOLD US THE OPPOSITE: that this sender is already ACTIVE.
    // `fail_studio_sms_provisioning` answers `already_active` by reading the
    // row's status, so this is the DATABASE stating a terminal state -- not an
    // inference from anything we observed. A sender that went active during the
    // attempt is one whose webhooks are live traffic, which is precisely what
    // this capability refuses to touch; reporting our provider story over that
    // would tell the operator configuration failed while the database says the
    // sender is provisioned. The newer terminal truth wins, and it reuses the
    // refusal the claim path already returns for this state.
    if (parked === "already_active") {
      return {
        ok: false,
        result: "refused",
        reason: "sender_already_active",
        retryable: false,
        providerWrites,
        parked: false,
        parkResult: parked,
      };
    }
    return {
      ok: false,
      result: "refused",
      reason,
      retryable,
      providerWrites,
      // Only `failed` means the row moved. `invalid_input`, `not_provisioning`
      // and `claim_not_found` all mean the attempt was NOT parked -- the row may
      // still be `provisioning` behind its lease -- and the caller must be able
      // to see that rather than infer a transition that never happened.
      parked: parked === "failed",
      parkResult: parked,
      ...detail,
    };
  };

  // --- 2. RE-PROVE FROM POST-CLAIM TRUTH -----------------------------------
  // Nothing an inspection saw is trusted, or even reachable: this is a fresh
  // read, under the lease, of who owns the number and where it lives. If the
  // association moved since someone last looked, this is what catches it.
  const proof = await proveOwnershipAndAssociation(provider, phoneNumber, targetService);
  if (!proof.ok) {
    if (proof.reason === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith(proof.reason, proof.retryable, { discovered: proof.discovered });
  }

  // --- 3. RESERVE THE PROVIDER IDENTIFIERS, ATOMICALLY --------------------
  //
  // A READ cannot close this. The reviewed race: A reads the resources as
  // unbound, B's in-flight adoption finalizes and binds the same PN/MG a
  // moment later, and A -- still holding a perfectly valid lease for its OWN
  // studio -- rewrites B's newly-bound service. Re-reading only narrows the
  // window; the gap between the last read and the write cannot be read away.
  // Reproduced exactly that way before this call existed: `configured`, two
  // writes, against another studio's service.
  //
  // 0191 already owns the atomic primitive, so no new table and no new
  // migration. `finalize(..., p_test_ok => false)` records the identifiers
  // under the partial unique indexes on `phone_number_sid` and
  // `messaging_service_sid`, inside the same locked, lease-fenced transaction,
  // and returns `conflict` rather than overwriting another studio. It leaves
  // the row `provisioning`, sets no `last_test_ok_at`, and asserts no provider
  // test -- so this reserves without activating anything.
  //
  // It happens BEFORE the configuration read on purpose: once we hold provider
  // identifiers, we should not even look at that service's configuration until
  // we have atomically won the right to.
  const reservation = await input.store.finalize({
    studioId: input.studioId,
    claimKey,
    leaseGeneration,
    phoneNumber,
    phoneNumberSid: proof.phoneNumberSid,
    messagingServiceSid: targetService,
    // NEVER true here. Activation belongs to adoption, after a real send.
    testOk: false,
  });

  switch (reservation) {
    case "provisioned_untested":
      // Reserved, or replayed onto the identical reservation this studio
      // already held -- 0191 coalesces, so a retry binds nothing new.
      break;
    case "already_active":
      // The DATABASE says this sender is live. Terminal truth outranks ours,
      // and a live sender's webhooks are exactly what we refuse to touch.
      return {
        ok: false,
        result: "refused",
        reason: "sender_already_active",
        retryable: false,
        providerWrites: 0,
      };
    case "lease_lost":
      return { ok: false, result: "lease_lost", senderId };
    case "conflict":
      // 0191 CANNOT distinguish "another studio holds this resource" from
      // "these identifiers disagree with the ones already on my row", so this
      // does not claim which. Either way it is a refusal, and the database's
      // verdict is preserved rather than reinterpreted.
      return failWith("reservation_conflict", false);
    default:
      // claim_not_found, not_provisioning, invalid_input -- none of them is
      // permission to configure.
      return failWith("finalize_failed", false);
  }

  // --- 4. RE-READ THE CONFIGURATION, and diff from THAT --------------------
  // The minimal mutation is computed here and only here. A limb an inspection
  // reported as wrong may already be correct by now, in which case it is not
  // written.
  const before = await provider.readMessagingServiceConfig({
    messagingServiceSid: targetService,
  });
  if (!before.ok) {
    if (before.code === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith(before.code, before.retryable);
  }

  const mismatched = diffConfiguration(
    before.config,
    input.requiredInboundWebhookUrl,
    input.requiredStatusCallbackUrl,
  );

  // --- 5. IDEMPOTENCY, decided by reading and not by remembering -----------
  if (mismatched.length === 0) {
    return { ok: true, result: "already_configured", senderId, providerWrites: 0 };
  }

  // --- 6. FINAL REVALIDATION, and nothing between it and the write ---------
  //
  // The lease fence proves we still hold the CLAIM. It cannot prove anything
  // about Twilio. Between the proof above and here sits the configuration read,
  // and a number moved out of the named service during that await would leave
  // this rewiring a service that no longer carries the studio's number. So
  // ownership, association and tenancy are all re-established immediately
  // before the first mutation, and the identifiers must be the SAME ones.
  //
  // Nothing unrelated may be awaited after this point.
  const reproof = await proveOwnershipAndAssociation(provider, phoneNumber, targetService);
  if (!reproof.ok) {
    if (reproof.reason === "lease_lost") return { ok: false, result: "lease_lost", senderId };
    return failWith(reproof.reason, reproof.retryable, { discovered: reproof.discovered });
  }
  if (reproof.phoneNumberSid !== proof.phoneNumberSid) {
    // Same E.164, different provider resource. That is not the number we proved.
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

  const stillWrong = diffConfiguration(
    after.config,
    input.requiredInboundWebhookUrl,
    input.requiredStatusCallbackUrl,
  );
  if (stillWrong.length > 0) {
    return failWith("post_write_verification_failed", false, { mismatched: stillWrong });
  }

  // --- 9. Stop here. Configuration is not activation. ----------------------
  return { ok: true, result: "configured", senderId, changed: mismatched, providerWrites };
}
