import "server-only";
import { fenceProviderMutations } from "./provider/fenced";
import { normalizePhoneForSms } from "./twilio";
import {
  SEARCH_LIMITS,
  type AvailableNumberCandidate,
  type ProviderErrorCode,
  type SmsProvisioningProvider,
} from "./provider/types";

// Per-studio SMS sender provisioning — the orchestration (COMMS-01B).
//
// This module owns the ORDER of a provisioning attempt and nothing else. It
// holds no credentials, makes no HTTP call of its own, and writes no SQL: the
// provider port does the former and the database commands do the latter. What
// lives here is the sequence, and the sequence is the safety property.
//
// ---------------------------------------------------------------------------
// THE INVARIANT
// ---------------------------------------------------------------------------
//
//     ONE OWNER ACTION => AT MOST ONE BILLABLE NUMBER.
//
// Not "usually one". At most one, across a double click, two browser tabs, a
// network retry, a serverless retry, a provider timeout, and the genuinely
// nasty case: the purchase SUCCEEDS and Hone's finalize write is LOST.
//
// Three mechanisms, in this order, and none of them is sufficient alone:
//
//   1. CLAIM BEFORE SPENDING. claim_studio_sms_provisioning commits a durable
//      claim before anything billable happens. Concurrent claimants serialize
//      on the studio row and the second receives the SAME key back, so two
//      requests reconcile against one attempt instead of running two.
//
//   2. THE KEY LIVES ON BOTH SIDES. That key is written INTO the provider
//      resource (Twilio FriendlyName) at creation. It therefore survives the
//      loss of Hone's own write, which is the failure a database alone cannot
//      protect against -- the lost write IS the database.
//
//   3. LOOK BEFORE BUYING, EVERY TIME. Step one of every attempt, first and
//      retry alike, is asking the provider what already exists under this key.
//      A purchase happens only when the answer is nothing. This is why a retry
//      after a lost finalize adopts the number rather than buying another.
//
// The database enforces the parts that must not depend on this file behaving:
// the claim key is write-once, `error` can never return to `off`, and `active`
// is unreachable without a completed, tested provisioning. See migration 0191.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------------
//
//   * It never substitutes a number. If the chosen one has gone, the attempt
//     ends with `number_no_longer_available` and the owner chooses again.
//   * It never accepts a provider identifier from its caller. Every SID is
//     produced by the provider inside this flow.
//   * It never reaches `active` on its own authority; it passes proof to the
//     database, which decides.
//   * It logs no provider payload, no full phone number, and no credential.

// ---------------------------------------------------------------------------
// The persistence port
// ---------------------------------------------------------------------------
//
// Narrow on purpose: exactly the three commands migration 0191 exposes. The
// production implementation calls them through service_role RPC; the tests
// drive an in-memory implementation of the same contract.

export type ClaimResult =
  | "claimed"
  | "claim_held"
  | "already_active"
  /** The claim is bound to a DIFFERENT number; this attempt is not that one. */
  | "number_mismatch"
  | "not_claimable"
  | "not_a_member"
  | "not_owner"
  | "studio_not_found"
  | "invalid_input";

export type ClaimRow = {
  result: ClaimResult;
  senderId: string | null;
  claimKey: string | null;
  senderStatus: string | null;
  /**
   * The fencing token. Advances on every stale-lease takeover, so a worker
   * that merely stalled past its lease can be told it no longer owns the
   * attempt BEFORE it spends money.
   */
  leaseGeneration: number | null;
};

export type FinalizeResult =
  | "activated"
  | "provisioned_untested"
  | "already_active"
  | "conflict"
  | "lease_lost"
  | "claim_not_found"
  | "not_provisioning"
  | "invalid_input";

/**
 * Everything that can end an attempt. The adapters only ever emit
 * ProviderErrorCode; these two are Hone-side and exist so a failed persistence
 * step is recorded with the same discipline as a failed provider call rather
 * than being flattened into "unspecified".
 */
export type AttemptErrorCode =
  | ProviderErrorCode
  | "finalize_failed"
  | "finalize_conflict"
  | "lease_lost";

export type FailResult =
  | "failed"
  | "lease_lost"
  | "already_active"
  | "not_provisioning"
  | "claim_not_found"
  | "invalid_input";

/**
 * The answer to "may this human act for this studio?", derived server-side.
 *
 * `unavailable` is its own answer and never collapses into a refusal: an
 * unreadable authority table means WE DO NOT KNOW, and a capability must fail
 * closed on that rather than reporting a confident "not owner".
 */
export type OwnerAuthority =
  | "owner"
  | "not_owner"
  | "not_a_member"
  | "studio_not_found"
  | "unavailable";

/**
 * READ-ONLY authority, mirroring exactly what claim_studio_sms_provisioning
 * derives internally: practitioners WHERE studio_id AND user_id AND active,
 * then the role.
 *
 * WHY IT IS ITS OWN PORT AND NOT A METHOD ON ProvisioningStore. An INSPECTION
 * must enforce authority without minting durable provisioning state -- using
 * the claim for that would mean merely LOOKING at provider truth creates
 * ownership, takes a five-minute lease, and blocks the real mutation that
 * follows. But a read-only inspection has no business holding a handle that
 * can claim, finalize or fail, and widening the store would have forced every
 * existing test double to grow a method it will never call.
 *
 * It confers NO mutation authority. `claim` remains the only thing that does,
 * and the configure path still takes it.
 */
export interface OwnerAuthorityReader {
  readOwnerAuthority(input: {
    studioId: string;
    actorUserId: string;
  }): Promise<OwnerAuthority>;
}

export interface ProvisioningStore {
  claim(input: {
    studioId: string;
    actorUserId: string;
    country: string;
    areaCode: string | null;
    /** Bound to the claim, write-once. A retry must carry the same one. */
    phoneNumber: string;
  }): Promise<ClaimRow>;

  finalize(input: {
    studioId: string;
    claimKey: string;
    leaseGeneration: number;
    phoneNumber: string;
    phoneNumberSid: string;
    messagingServiceSid: string;
    testOk: boolean;
  }): Promise<FinalizeResult>;

  fail(input: {
    studioId: string;
    claimKey: string;
    leaseGeneration: number;
    errorCode: AttemptErrorCode;
  }): Promise<FailResult>;

  /**
   * ATOMIC check-and-renew, run immediately before every claim-scoped provider
   * operation. False means DO NOT SPEND -- displaced, expired, finished, or
   * bound to a different number; which one is not the caller's business.
   *
   * Renewing rather than merely checking is what keeps the takeover boundary
   * OUTSIDE the bounded provider call instead of somewhere inside it: a
   * check-only predicate passes for a worker whose lease expired minutes ago
   * but whom nobody has yet displaced.
   */
  renewLease(input: {
    studioId: string;
    claimKey: string;
    leaseGeneration: number;
    phoneNumber: string;
  }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Authorization refusals
// ---------------------------------------------------------------------------

/**
 * The claim results that mean "this human may not do this here". They are
 * returned by the DATABASE, which re-derives membership and owner role from
 * (studio_id, authenticated user id) -- the caller never supplies a role, and
 * a studio id in a request body proves nothing on its own.
 */
export const AUTHORIZATION_REFUSALS = [
  "not_a_member",
  "not_owner",
  "studio_not_found",
] as const;

export function isAuthorizationRefusal(result: ClaimResult): boolean {
  return (AUTHORIZATION_REFUSALS as readonly string[]).includes(result);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchOutcome =
  | { ok: true; candidates: AvailableNumberCandidate[] }
  | { ok: false; reason: ProviderErrorCode | "not_authorized" | "invalid_input" };

/**
 * Bounded, READ-ONLY candidate search.
 *
 * Writes nothing: no claim, no row, no status change, no messaging service,
 * and above all no purchase or reservation. An owner may browse as often as
 * they like and it costs nothing and commits to nothing. Authorization is
 * still required -- one studio's owner has no business enumerating on behalf
 * of another -- and is proved by the caller before this is reached.
 *
 * Only the safe candidate shape crosses back: number, display form, locality,
 * region, country and messaging capabilities. No SID exists yet, because
 * nothing has been bought.
 */
export async function searchAvailableSenderNumbers(input: {
  provider: SmsProvisioningProvider;
  country: string;
  areaCode?: string | null;
  limit?: number;
}): Promise<SearchOutcome> {
  const country = input.country?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(country)) {
    return { ok: false, reason: "invalid_input" };
  }
  const areaCode = input.areaCode?.trim() || null;
  if (areaCode !== null && !/^[0-9]{2,5}$/.test(areaCode)) {
    return { ok: false, reason: "invalid_input" };
  }

  const limit = Math.min(
    SEARCH_LIMITS.max,
    Math.max(SEARCH_LIMITS.min, input.limit ?? SEARCH_LIMITS.max),
  );

  const result = await input.provider.searchAvailableNumbers({
    country,
    areaCode,
    limit,
  });
  if (!result.ok) return { ok: false, reason: result.code };
  return { ok: true, candidates: result.candidates.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export type ProvisionOutcome =
  | {
      ok: true;
      result: "activated";
      senderId: string;
      phoneNumber: string;
      /** True when this attempt adopted resources a previous one had bought. */
      adopted: boolean;
    }
  | { ok: true; result: "already_active"; senderId: string }
  | {
      ok: false;
      result: "refused";
      reason: ClaimResult;
    }
  | {
      /**
       * Another attempt for this studio is live and holds the claim. This
       * request performed NO provider effect at all -- that is the point.
       */
      ok: false;
      result: "in_progress";
      senderId: string | null;
    }
  | {
      /**
       * This worker stalled past its lease and another took the attempt over.
       * It stopped BEFORE spending. Whatever it may already have bought stays
       * discoverable under the shared claim key, and the current holder adopts
       * it.
       */
      ok: false;
      result: "lease_lost";
      senderId: string | null;
    }
  | {
      ok: false;
      result: "failed";
      reason: AttemptErrorCode | FinalizeResult;
      /** True when a later retry can reconcile and continue. */
      retryable: boolean;
      /**
       * True when this attempt may have left a purchased resource behind. The
       * claim is intact, so a retry will find and adopt it.
       */
      mayOwnUnfinalizedResources: boolean;
      /**
       * Whether the attempt was actually PARKED in `error`.
       *
       * False means the failure write itself did not land -- the database was
       * unreachable, or the row had already moved. The row is then very likely
       * still `provisioning` behind a live lease, so an immediate retry is
       * EXCLUDED (`in_progress`) rather than resuming, until the lease expires.
       * Reporting "failed, retryable" without this would invite the owner to
       * try again into a door that is still shut.
       */
      parked: boolean;
      /** The failure write's own verdict, never discarded. */
      parkResult: FailResult;
      /**
       * Whether the DATABASE ACKNOWLEDGED persisting the current provider
       * identifiers. True is claimed only on that acknowledgement -- never
       * inferred from provider success, test success, or Hone merely holding
       * the SID in memory.
       *
       * False means the SIDs exist at the provider and Hone does not have them
       * written down -- which outranks "the provisioning test failed" as the
       * thing the operator needs to know. Reporting an ordinary parked test
       * failure here would describe a recoverable state that is not the one we
       * are in.
       */
      identifiersRecorded: boolean;
      /** The identifier write's own verdict when one was attempted. */
      identifierResult: FinalizeResult | null;
    };

export type ProvisionInput = {
  store: ProvisioningStore;
  provider: SmsProvisioningProvider;
  studioId: string;
  actorUserId: string;
  country: string;
  areaCode?: string | null;
  /** The exact number the owner chose. Never substituted. */
  phoneNumber: string;
  /** Absolute URL Twilio posts inbound messages to. */
  inboundWebhookUrl: string;
  /** Absolute URL Twilio posts delivery status to. */
  statusCallbackUrl: string;
  /** Where the provisioning test message goes. Operator destination, not a client. */
  testDestination: string;
  /** Label for the messaging service. Carries no client data. */
  serviceLabel: string;
  /** Body of the provisioning test message. */
  testBody: string;
};

/**
 * Execute one provisioning attempt.
 *
 * The steps, in the order section 7 of the COMMS-01B brief requires:
 *
 *   1-3. resolve the human, prove owner authorization, prove studio
 *        eligibility  -- all three inside claim(), re-derived by the database.
 *   4.   acquire the durable claim -- EXCLUSIVELY. A live attempt turns this
 *        request away before any provider effect.
 *   5.   RECONCILE, re-check availability, then REVALIDATE THE FENCE.
 *   6.   purchase exactly once (or adopt).
 *   7-8. create and attach the messaging service.
 *   9-10. configure inbound webhook and status callback.
 *   11.  persist provider identifiers.
 *   12.  run the provisioning test.
 *   13.  transition to ACTIVE only on proof.
 *
 * Steps 11 and 13 are one call: finalize() records the identifiers and decides
 * activation from the test result, so there is no window in which identifiers
 * are stored with an unproven `active`.
 */
export async function provisionStudioSmsSender(
  input: ProvisionInput,
): Promise<ProvisionOutcome> {
  // --- 1-4. Authorization and the durable claim -----------------------------
  // ONE CANONICAL NUMBER FOR THE WHOLE ATTEMPT, decided here and nowhere else.
  //
  // The database stores `btrim(p_phone_number)`, so a padded selection was
  // persisted trimmed while every later renewLease() still carried the raw
  // string. The fence compares `claimed_phone_number = p_phone_number`, so the
  // LEGITIMATE generation failed its own fence and every attempt died -- fail
  // closed, but comprehensively broken for any input with whitespace.
  //
  // The fix is not to trim in more places; it is to have ONE value. Everything
  // downstream -- claim, fence, availability, purchase, finalize, comparison --
  // uses `chosenNumber`, and the raw input is never read again.
  const chosenNumber = normalizePhoneForSms(input.phoneNumber);

  // Reject before the claim, so an unusable selection never opens an attempt
  // or reaches the provider.
  if (!chosenNumber) {
    return { ok: false, result: "refused", reason: "invalid_input" };
  }

  const claim = await input.store.claim({
    studioId: input.studioId,
    actorUserId: input.actorUserId,
    country: input.country.trim().toUpperCase(),
    areaCode: input.areaCode?.trim() || null,
    // Bound to the claim, write-once. Everything downstream -- including the
    // fence -- is scoped to THIS number.
    phoneNumber: chosenNumber,
  });

  if (claim.result === "already_active") {
    return { ok: true, result: "already_active", senderId: claim.senderId ?? "" };
  }

  // A HELD CLAIM STOPS THIS REQUEST DEAD, and that is the whole double-submit
  // defence. Continuing with a shared key would not be safe: a concurrent
  // attempt has not purchased yet, so this one's reconciliation lookup would
  // find nothing and it would buy a second number in parallel with the first.
  // Exclusion is what makes "one owner action, one number" hold; the key alone
  // only makes a SEQUENTIAL retry safe.
  if (claim.result === "claim_held") {
    return { ok: false, result: "in_progress", senderId: claim.senderId };
  }

  if (claim.result !== "claimed") {
    // Includes every authorization refusal. Nothing billable has happened and
    // nothing will.
    return { ok: false, result: "refused", reason: claim.result };
  }

  const claimKey = claim.claimKey;
  const senderId = claim.senderId;
  const leaseGeneration = claim.leaseGeneration;
  if (!claimKey || !senderId || leaseGeneration === null) {
    // A claim without its key cannot be reconciled later, so it must not be
    // spent against.
    return {
      ok: false,
      result: "failed",
      reason: "provider_error_unspecified",
      retryable: false,
      mayOwnUnfinalizedResources: false,
      // Nothing was attempted and nothing was parked: there is no usable claim
      // to park against, and no identifier write was made.
      parked: false,
      parkResult: "invalid_input",
      identifiersRecorded: false,
      identifierResult: null,
    };
  }

  const failWith = async (
    code: AttemptErrorCode,
    retryable: boolean,
    mayOwn: boolean,
  ): Promise<ProvisionOutcome> => {
    // The claim key is NOT surrendered here. That is the point: whatever this
    // attempt may already have bought stays discoverable under it.
    const parked = await input.store.fail({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      errorCode: code,
    });

    // THE DATABASE MAY HAVE JUST TOLD US WE ARE THE STALE WORKER, and that
    // answer outranks whatever provider error we arrived with. Reporting the
    // stale error instead would surface a lie to the owner: an availability
    // check that resumed after a takeover would say "that number is gone"
    // while the current generation is busy successfully provisioning it.
    if (wrote(parked)) return displaced();

    // AND IT MAY HAVE TOLD US THE OPPOSITE: that this sender is already ACTIVE.
    //
    // `fail_studio_sms_provisioning` answers `already_active` by reading the
    // row's status, so this is the database stating the terminal state has
    // been reached -- not an inference from provider success, from Hone
    // holding a SID, or from a stale worker's assumption. The realistic path
    // is a finalize that COMMITTED while its response was lost or malformed:
    // the store fails closed to `invalid_input`, we come here to park, and the
    // park discovers the row is live.
    //
    // Reporting a provider or transport error over that would tell the owner
    // provisioning failed when the database says it succeeded. The newer
    // terminal truth wins, and it reuses the outcome the claim path already
    // returns for this exact state rather than inventing a new one.
    if (parked === "already_active") {
      return { ok: true, result: "already_active", senderId };
    }

    // THE PARKING WRITE HAS ITS OWN VERDICT, and only `failed` means the row
    // actually moved to `error`. `invalid_input` (an unreachable database, or a
    // shape this store refuses to trust), `not_provisioning` and
    // `claim_not_found` all mean the attempt was NOT parked -- so the row is
    // probably still `provisioning` behind a live lease, and the retry this
    // outcome invites would be turned away as `in_progress`.
    //
    // Reporting the provider error alone would be true and still misleading.
    // Both facts travel together.
    return {
      ok: false,
      result: "failed",
      reason: code,
      retryable,
      mayOwnUnfinalizedResources: mayOwn,
      parked: parked === "failed",
      parkResult: parked,
      // failWith is reached from paths where no identifier write was
      // attempted at all, so there is no acknowledgement to report. FALSE with
      // a null verdict says exactly that; `true` would assert a persistence
      // nothing established. Callers pair this with
      // mayOwnUnfinalizedResources, which is what distinguishes "nothing was
      // bought" from "something was bought and is unrecorded".
      identifiersRecorded: false,
      identifierResult: null,
    };
  };

  const displaced = (): ProvisionOutcome => ({
    ok: false,
    result: "lease_lost",
    senderId,
  });

  // THE FENCE IS A TYPE FROM HERE ON, NOT A RULE TO REMEMBER.
  //
  // Every externally-mutating call on `provider` proves this generation
  // immediately before it. The unfenced provider is deliberately NOT used
  // again below: there is no call site left at which a future edit could
  // forget the check, because the object it would be calling cannot perform an
  // unfenced effect. See lib/sms/provider/fenced.ts for why this replaced six
  // hand-written checks.
  const provider = fenceProviderMutations(input.provider, () =>
    input.store.renewLease({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      phoneNumber: chosenNumber,
    }),
  );

  /**
   * Record an authoritative write's verdict, and let the DATABASE's answer
   * outrank this worker's.
   *
   * The second half of the same invariant: a displaced worker must not perform
   * an effect, AND must not narrate one. `finalize`/`fail` return `lease_lost`
   * when the generation has moved, and discarding that -- which three separate
   * call sites did -- reports a stale worker's story over a newer worker's
   * truth.
   */
  const wrote = (result: string): result is "lease_lost" => result === "lease_lost";

  // --- 5a. RECONCILE FIRST. Always, on every attempt. -----------------------
  // Before considering a purchase we ask the provider what already exists
  // under this claim. On a first attempt the answer is nothing; on a retry
  // after a lost finalize it is the number we already own -- and finding it
  // here is the entire reason a second one never gets bought.
  const existing = await provider.lookupResourcesByClaim(claimKey);
  if (!existing.ok) {
    if (existing.code === "lease_lost") return displaced();
    // We cannot prove we own nothing, so we must not buy. Refusing to spend
    // under uncertainty is the whole posture.
    return failWith(existing.code, existing.retryable, true);
  }

  let phoneNumberSid = existing.found.phoneNumberSid;
  let phoneNumber = existing.found.phoneNumber;
  let messagingServiceSid = existing.found.messagingServiceSid;
  const adopted = phoneNumberSid !== null;

  // --- 6. Purchase exactly once, or adopt what a prior attempt bought -------
  if (!phoneNumberSid) {
    // 5b. Exact availability re-check. Narrows the window before spending;
    // the purchase below remains the authority (see isNumberAvailable).
    const availability = await provider.isNumberAvailable({
      country: input.country.trim().toUpperCase(),
      phoneNumber: chosenNumber,
    });
    if (!availability.ok) {
      if (availability.code === "lease_lost") return displaced();
      return failWith(availability.code, availability.retryable, false);
    }
    if (!availability.available) {
      // The owner chose THAT number. We do not quietly hand them another one.
      return failWith("number_no_longer_available", false, false);
    }

    // THE FENCE, AND IT SITS AS CLOSE TO THE MONEY AS IT CAN.
    //
    // Reusing the claim key across a takeover makes a SEQUENTIAL retry safe.
    // It does not fence a CONCURRENT one: a worker that merely stalled past
    // its five-minute lease -- not crashed, just slow or wedged on a socket --
    // resumes believing it still owns this attempt. Both workers would then
    // hold the same key, both would reconcile while neither purchase is
    // visible, and both would buy.
    //
    // This is the last statement before the billable call, deliberately. It
    // does not close the window -- a takeover landing in the gap still races,
    // because Twilio's purchase API takes no idempotency key -- but it shrinks
    // it from the whole provisioning sequence to a few milliseconds, and the
    // claim-key FriendlyName keeps the residue discoverable rather than silent.
    const purchase = await provider.purchaseNumber({
      claimKey,
      phoneNumber: chosenNumber,
    });
    if (!purchase.ok) {
      if (purchase.code === "lease_lost") return displaced();
      // A timeout here is the ambiguous case: the number may exist. The claim
      // survives, so the retry's reconcile step finds it.
      const ambiguous =
        purchase.code === "provider_timeout" ||
        purchase.code === "provider_network";
      return failWith(purchase.code, purchase.retryable, ambiguous);
    }
    phoneNumberSid = purchase.phoneNumberSid;
    phoneNumber = purchase.phoneNumber;
  }

  if (!phoneNumber || !phoneNumberSid) {
    return failWith("provider_response_unparseable", false, true);
  }

  // --- 7. Messaging service (adopted if this claim already made one) --------
  if (!messagingServiceSid) {
    const service = await provider.createMessagingService({
      claimKey,
      serviceLabel: input.serviceLabel,
    });
    if (!service.ok) {
      if (service.code === "lease_lost") return displaced();
      return failWith(service.code, service.retryable, true);
    }
    messagingServiceSid = service.messagingServiceSid;
  }

  // --- 8. Associate the number with the service ----------------------------
  const attach = await provider.attachNumberToService({
    messagingServiceSid,
    phoneNumberSid,
  });
  if (!attach.ok) {
    if (attach.code === "lease_lost") return displaced();
    return failWith(attach.code, attach.retryable, true);
  }

  // --- 9. Inbound webhook: this is what makes To-number -> studio work ------
  const inbound = await provider.configureInboundWebhook({
    messagingServiceSid,
    inboundWebhookUrl: input.inboundWebhookUrl,
  });
  if (!inbound.ok) {
    if (inbound.code === "lease_lost") return displaced();
    return failWith(inbound.code, inbound.retryable, true);
  }

  // --- 10. Delivery status callback ----------------------------------------
  const status = await provider.configureStatusCallback({
    messagingServiceSid,
    statusCallbackUrl: input.statusCallbackUrl,
  });
  if (!status.ok) {
    if (status.code === "lease_lost") return displaced();
    return failWith(status.code, status.retryable, true);
  }

  // --- 12. Prove it can actually send --------------------------------------
  const test = await provider.sendProvisioningTest({
    messagingServiceSid,
    to: input.testDestination,
    body: input.testBody,
  });

  if (!test.ok) {
    if (test.code === "lease_lost") return displaced();
    // Record the identifiers WITHOUT activating. The resources are real and
    // must be remembered -- forgetting them is how Hone ends up paying for a
    // number it has no record of -- but an untested sender is not a sender.
    // The result is INSPECTED, never discarded. If the database says we were
    // displaced while the test ran, that answer outranks the test failure: the
    // worker that took over owns the row, and reporting `test_failed` here
    // would overwrite a newer worker's truth with a stale one.
    const parkedIdentifiers = await input.store.finalize({
      studioId: input.studioId,
      claimKey,
      leaseGeneration,
      phoneNumber,
      phoneNumberSid,
      messagingServiceSid,
      testOk: false,
    });
    if (wrote(parkedIdentifiers)) return displaced();

    // THE IDENTIFIER WRITE HAS ITS OWN VERDICT, and only these two mean the
    // SIDs were durably recorded. `conflict`, `invalid_input`,
    // `not_provisioning` and `claim_not_found` all mean Hone now owns provider
    // resources it has NOT written down -- which outranks "the test failed" as
    // the thing an operator needs to know, and which a subsequent successful
    // parking write would otherwise disguise as an ordinary, recoverable
    // parked test failure.
    const identifiersRecorded =
      parkedIdentifiers === "provisioned_untested" ||
      parkedIdentifiers === "already_active";

    const parked = await failWith(test.code, test.retryable, true);
    if (parked.result !== "failed") return parked;

    return {
      ...parked,
      identifiersRecorded,
      identifierResult: parkedIdentifiers,
    };
  }

  // --- 11 + 13. Persist identifiers and activate, together -----------------
  const finalized = await input.store.finalize({
    studioId: input.studioId,
    claimKey,
    leaseGeneration,
    phoneNumber,
    phoneNumberSid,
    messagingServiceSid,
    testOk: true,
  });

  if (finalized === "activated" || finalized === "already_active") {
    return {
      ok: true,
      result: "activated",
      senderId,
      phoneNumber,
      adopted,
    };
  }

  // The resources are real and the row does not know it. Park the attempt in
  // `error` so the studio is not held by a lease that nothing is working
  // behind -- a retry then reconciles under the same key and adopts them. If
  // this call fails too (the database is simply unreachable) the lease expires
  // on its own and a later attempt takes over, which is the slower path to the
  // same place.
  if (wrote(finalized)) {
    // Another worker owns this attempt now. Do NOT park the row in `error`:
    // that would stomp a live attempt. Its resources stay discoverable under
    // the shared claim key.
    return displaced();
  }

  // RETURN the parked outcome rather than discarding it. `failWith` already
  // converts a refused write into `lease_lost`; throwing that away and
  // reporting `finalize_failed` would tell the owner the stale worker's story
  // while a newer generation is provisioning successfully.
  const parked = await failWith(
    finalized === "conflict" ? "finalize_conflict" : "finalize_failed",
    finalized !== "conflict",
    true,
  );
  // Forward ANY non-failure outcome the parking write produced -- displacement
  // and already-active alike. Naming only `lease_lost` here is what let a
  // committed activation be reported as a failure.
  if (parked.result !== "failed") return parked;

  // Carry the parking write's own verdict here too. `failWith` already decided
  // whether the row actually moved to `error`; re-asserting "parked" from this
  // branch would be inventing a fact rather than reporting one.
  return {
    ok: false,
    result: "failed",
    reason: finalized,
    retryable: finalized !== "conflict",
    mayOwnUnfinalizedResources: true,
    parked: parked.result === "failed" ? parked.parked : false,
    parkResult: parked.result === "failed" ? parked.parkResult : "invalid_input",
    // REACHING HERE MEANS THE DATABASE REFUSED THE WRITE. `activated` and
    // `already_active` returned success far above and `lease_lost` returned
    // displacement, so `finalized` is necessarily conflict / not_provisioning /
    // claim_not_found / invalid_input -- every one of which means the current
    // provider identifiers were NOT durably stored, however well the provider
    // test went. Claiming otherwise here was the defect: a successful test and
    // a SID in hand are not persistence.
    identifiersRecorded: false,
    identifierResult: finalized,
  };
}
