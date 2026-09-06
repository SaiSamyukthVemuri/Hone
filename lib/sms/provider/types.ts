import "server-only";

// The SMS provisioning provider port (COMMS-01B).
//
// ONE boundary, server-only. Provisioning is billable and recurring, so the
// REST calls that spend money live here and nowhere else -- not in an action,
// not in a component, not inlined into a route. Everything above this file
// speaks in the vocabulary below and cannot express "call Twilio" any other
// way.
//
// This file defines no behaviour. It defines:
//   * the SAFE shapes that may cross back toward a browser,
//   * the error taxonomy the orchestration and the database share,
//   * the port that lib/sms/provisioning.ts drives.
//
// Two implementations satisfy it: twilio-provider.ts (real REST) and
// fake-provider.ts (deterministic, no network). Selection is in ./index.ts and
// defaults to the fake.

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Every provider failure collapses to one of these tags. They are the ONLY
 * provider-derived strings that may be persisted or logged.
 *
 * The shape is deliberate: lowercase snake_case, 3-64 chars, matching the
 * `studio_sms_senders.last_error_code` CHECK. A provider message, a phone
 * number or a token cannot satisfy it, so a careless caller cannot smuggle one
 * into the database or into a log line by widening this type.
 *
 * `retryable` is carried separately (see ProviderError) because it drives
 * whether the orchestration parks the attempt in `error` for later
 * reconciliation or gives up on this pass.
 */
export const PROVIDER_ERROR_CODES = [
  // Configuration: Hone is not wired to a provider at all.
  "provider_not_configured",
  // Transport.
  "provider_timeout",
  "provider_network",
  "provider_unavailable",
  "provider_rate_limited",
  // Authentication / authorization against the master account.
  "provider_unauthorized",
  // The specific number the owner chose is gone. NEVER substituted.
  "number_no_longer_available",
  // Search produced nothing for the requested country/area code.
  "no_numbers_available",
  // The provider answered, but not in a shape we are willing to trust.
  "provider_response_unparseable",
  // A resource we asked about exists but does not match what we expected.
  "provider_resource_mismatch",
  // Anything else the provider rejected non-retryably.
  "provider_rejected",
  // Reserved for a failure with no better classification.
  "provider_error_unspecified",
  // NOT a provider condition: emitted by the fencing wrapper when this worker
  // has been displaced by a lease takeover and therefore has no authority to
  // perform the effect it was about to perform. It lives in this union so the
  // fence can wrap ANY port method without a second result shape, and so the
  // orchestration handles it in one place rather than at every call site.
  "lease_lost",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type ProviderError = {
  ok: false;
  code: ProviderErrorCode;
  /**
   * True when a later attempt could plausibly succeed. A retryable failure
   * parks the attempt in `error` WITH its claim key intact so reconciliation
   * can adopt anything that was already purchased.
   */
  retryable: boolean;
};

export type ProviderResult<T> = ({ ok: true } & T) | ProviderError;

/**
 * A provider call that either worked or did not, carrying no payload.
 * `Record<never, never>` rather than `Record<string, never>`: the latter's
 * index signature collides with the `ok: true` the result type intersects in.
 */
export type ProviderAck = ProviderResult<Record<never, never>>;

export function providerError(
  code: ProviderErrorCode,
  retryable: boolean,
): ProviderError {
  return { ok: false, code, retryable };
}

// ---------------------------------------------------------------------------
// Safe, browser-facing shapes
// ---------------------------------------------------------------------------

/**
 * A candidate number as the owner may see it. This is the ONLY provider-shaped
 * value in this file that is allowed to reach a browser.
 *
 * Note what is absent: no SID, no account identifier, no price, no raw
 * provider fields. A candidate is not yet a resource Hone owns, so it has no
 * SID to leak -- and the confirm step re-resolves the chosen number against
 * the provider anyway, so nothing the browser returns is trusted as authority.
 */
export type AvailableNumberCandidate = {
  /** E.164, e.g. "+14165550123". The only identity the confirm step accepts. */
  phoneNumber: string;
  /** Display form as the provider gave it, e.g. "(416) 555-0123". */
  formatted: string;
  /** Locality, e.g. "Toronto". Null when the provider does not supply one. */
  locality: string | null;
  /** Region / province / state code, e.g. "ON". Null when unknown. */
  region: string | null;
  /** ISO-3166 alpha-2. */
  country: string;
  /** Messaging capabilities only; voice/fax/MMS detail is not the owner's decision here. */
  smsCapable: boolean;
  mmsCapable: boolean;
};

/**
 * A provider resource pair Hone owns. Server-only: these SIDs are excluded
 * from the browser's column grant on studio_sms_senders precisely so they can
 * never be echoed back as authority.
 */
export type ProvisionedSender = {
  phoneNumber: string;
  phoneNumberSid: string;
  messagingServiceSid: string;
};

/** What a reconciliation lookup found for one claim key. */
export type ClaimedResources = {
  phoneNumber: string | null;
  phoneNumberSid: string | null;
  messagingServiceSid: string | null;
};

/**
 * Where a number actually lives, as a COMPLETE census of the account's
 * Messaging Services. WILLOW ADOPTION.
 *
 * Five states, and the distinction between the last three is the whole point.
 * A boolean "is it in the expected service" can only say no; it cannot say
 * whether the number is loose, somewhere else, or simply unknown — and those
 * demand different answers from an operator. Collapsing them is what would let
 * "we could not finish the census" read as "the number is free to attach".
 */
export type NumberAssociation =
  | { kind: "in_expected_service"; messagingServiceSid: string }
  | { kind: "in_other_service"; messagingServiceSid: string }
  | { kind: "not_associated" }
  /** More than one service claims the number. Contradictory: fail closed. */
  | { kind: "ambiguous"; messagingServiceSids: string[] }
  /** The census could not be COMPLETED. Never a synonym for absence. */
  | { kind: "unavailable"; reason: string };

/**
 * What the account already owns for a specific E.164, plus where it lives.
 *
 * `phoneNumberSid` is null when this account does not own the number at all.
 */
export type OwnedNumberFacts = {
  phoneNumberSid: string | null;
  /** Echoed back so the caller can prove the provider answered about the right number. */
  phoneNumber: string | null;
  association: NumberAssociation;
};

/**
 * The configuration a Messaging Service currently carries. Read, never written,
 * by the adoption path: an existing studio-owned service is not Hone's to
 * reconfigure without a human saying so.
 */
export type MessagingServiceConfig = {
  inboundRequestUrl: string | null;
  statusCallbackUrl: string | null;
};

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export type SearchNumbersInput = {
  /** ISO-3166 alpha-2, uppercase. */
  country: string;
  /** Optional area code / locality prefix where the provider supports it. */
  areaCode?: string | null;
  /** Bounded selection size. The orchestration clamps this to SEARCH_LIMITS. */
  limit: number;
};

/**
 * Bounds on a browser-facing selection. Small enough to be a decision, large
 * enough to be a choice.
 */
export const SEARCH_LIMITS = { min: 3, max: 10 } as const;

export type ProvisionInput = {
  /**
   * The durable claim key from claim_studio_sms_provisioning. It is written
   * into the provider resource (Twilio FriendlyName) so the resource itself
   * carries the handle -- that is what a lookup after a lost finalize finds.
   */
  claimKey: string;
  /** The exact number the owner chose. Never substituted if it has gone. */
  phoneNumber: string;
  /** Friendly label for the messaging service; carries no client data. */
  serviceLabel: string;
  /** Absolute URL Twilio posts inbound messages to. */
  inboundWebhookUrl: string;
  /** Absolute URL Twilio posts delivery status to. */
  statusCallbackUrl: string;
};

export interface SmsProvisioningProvider {
  readonly name: "twilio" | "fake";

  /**
   * READ ONLY. Must not purchase, reserve, create a messaging service, or
   * write any provider state. Returns a bounded candidate list.
   */
  searchAvailableNumbers(
    input: SearchNumbersInput,
  ): Promise<ProviderResult<{ candidates: AvailableNumberCandidate[] }>>;

  /**
   * Exact availability re-check for ONE number, immediately before purchase.
   *
   * Deliberately NOT "call searchAvailableNumbers and look for it": that page
   * is bounded to a handful of results, so a perfectly available number would
   * routinely be absent from it and be reported gone. This asks about the one
   * number.
   *
   * It narrows the window; it does not close it. The number can still be taken
   * between this call and the purchase, so `purchaseNumber` remains the
   * AUTHORITY on availability and returns `number_no_longer_available` itself.
   * This check exists so the common case fails before spending money, not so
   * the caller can skip handling the race.
   */
  isNumberAvailable(input: {
    country: string;
    phoneNumber: string;
  }): Promise<ProviderResult<{ available: boolean }>>;

  /**
   * THE RECONCILIATION PRIMITIVE. Ask the provider what already exists under
   * this claim key. Called BEFORE any purchase and again on every retry; it is
   * the only thing standing between a lost database write and a second
   * billable number.
   */
  lookupResourcesByClaim(
    claimKey: string,
  ): Promise<ProviderResult<{ found: ClaimedResources }>>;

  /**
   * READ-ONLY. Does this account own `phoneNumber`, and which Messaging Service
   * — if any — actually holds it?
   *
   * WILLOW ADOPTION. `lookupResourcesByClaim` cannot answer this: it searches on
   * the `hone-sms-claim:<key>` FriendlyName Hone stamps at purchase time, so it
   * finds only numbers Hone itself bought. A number the studio already owned
   * carries no such tag.
   *
   * The association is a COMPLETE census over the account's services. An
   * incomplete one must report `unavailable`, never `not_associated` — the
   * second reading is what would license attaching a number that is quietly
   * somewhere else.
   *
   * Performs NO mutation: it cannot purchase, attach, detach, move or create.
   */
  lookupOwnedNumber(input: {
    phoneNumber: string;
    expectedMessagingServiceSid: string;
  }): Promise<ProviderResult<{ facts: OwnedNumberFacts }>>;

  /**
   * READ-ONLY. The webhook configuration a Messaging Service carries today.
   *
   * Adoption COMPARES against this and refuses on a mismatch; it never writes.
   * Reconfiguring a service the studio already uses could silently break
   * whatever it serves, so that mutation needs an explicit human decision and
   * is not part of the adoption path.
   */
  readMessagingServiceConfig(input: {
    messagingServiceSid: string;
  }): Promise<ProviderResult<{ config: MessagingServiceConfig }>>;

  /** Create a messaging service tagged with the claim key. */
  createMessagingService(
    input: Pick<ProvisionInput, "claimKey" | "serviceLabel">,
  ): Promise<ProviderResult<{ messagingServiceSid: string }>>;

  /**
   * BILLABLE. Purchase one number, tagged with the claim key. Returns
   * `number_no_longer_available` when the chosen number has gone; the caller
   * must surface that, never substitute another.
   */
  purchaseNumber(
    input: Pick<ProvisionInput, "claimKey" | "phoneNumber">,
  ): Promise<ProviderResult<{ phoneNumberSid: string; phoneNumber: string }>>;

  /** Attach a purchased number to a messaging service. Idempotent. */
  attachNumberToService(input: {
    messagingServiceSid: string;
    phoneNumberSid: string;
  }): Promise<ProviderAck>;

  /** Point the messaging service's inbound handler at Hone. Idempotent. */
  configureInboundWebhook(input: {
    messagingServiceSid: string;
    inboundWebhookUrl: string;
  }): Promise<ProviderAck>;

  /** Point the messaging service's delivery-status handler at Hone. Idempotent. */
  configureStatusCallback(input: {
    messagingServiceSid: string;
    statusCallbackUrl: string;
  }): Promise<ProviderAck>;

  /**
   * Prove the sender can actually send. `active` is unreachable without this
   * returning ok -- the database CHECK enforces that independently.
   */
  sendProvisioningTest(input: {
    messagingServiceSid: string;
    to: string;
    body: string;
  }): Promise<ProviderResult<{ messageSid: string }>>;
}

// ---------------------------------------------------------------------------
// Fail-closed parsing helpers
// ---------------------------------------------------------------------------
//
// Every value taken from a provider response goes through one of these. An
// unexpected shape yields null and the caller returns
// `provider_response_unparseable` -- it never yields a partially-trusted
// object. A provider that answers 200 with something we do not recognise is
// treated as a failure, not as success.

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Twilio IncomingPhoneNumber SID shape. Mirrors the DB CHECK exactly. */
export function asPhoneNumberSid(value: unknown): string | null {
  const s = asString(value);
  return s && /^PN[0-9a-fA-F]{32}$/.test(s) ? s : null;
}

/** Twilio Messaging Service SID shape. Mirrors the DB CHECK exactly. */
export function asMessagingServiceSid(value: unknown): string | null {
  const s = asString(value);
  return s && /^MG[0-9a-fA-F]{32}$/.test(s) ? s : null;
}

/** E.164 as the DB CHECK and lib/sms/twilio.ts both define it. */
export function asE164(value: unknown): string | null {
  const s = asString(value);
  return s && /^\+[1-9][0-9]{7,14}$/.test(s) ? s : null;
}

/**
 * The provider-side form of a claim key. Hone's key is echoed into the
 * resource's FriendlyName under this prefix so a lookup can find it, and so a
 * resource NOT created by Hone can never be mistaken for one that was.
 */
export const CLAIM_FRIENDLY_NAME_PREFIX = "hone-sms-claim:";

export function claimFriendlyName(claimKey: string): string {
  return `${CLAIM_FRIENDLY_NAME_PREFIX}${claimKey}`;
}

/** The claim key shape minted by claim_studio_sms_provisioning. */
export function isClaimKey(value: unknown): value is string {
  const s = asString(value);
  return s !== null && /^hone-sms-[0-9a-f]{32}$/.test(s);
}
