import "server-only";
import crypto from "node:crypto";
import { classifyAssociation } from "./association";
import { asMessagingServiceSid } from "./types";
import {
  claimFriendlyName,
  providerError,
  type AvailableNumberCandidate,
  type ClaimedResources,
  type MessagingServiceConfig,
  type OwnedNumberFacts,
  type ProviderErrorCode,
  type ProviderAck,
  type ProviderResult,
  type SearchNumbersInput,
  type SmsProvisioningProvider,
} from "./types";

// Deterministic, in-memory SMS provisioning provider (COMMS-01B).
//
// WHY THIS EXISTS, AND WHY IT IS THE DEFAULT. Every provider effect in this
// slice is fake. A phone number is billable and recurring, so the first time
// Hone spends money at Twilio must be a separately authorized, deliberately
// observed act -- not a side effect of a test run, a CI job, a local `npm
// test`, or a preview deployment. ./index.ts therefore selects this
// implementation unless the real one is explicitly and unambiguously demanded.
//
// WHAT MAKES IT USEFUL RATHER THAN A STUB: it keeps a real resource store
// keyed by CLAIM KEY, exactly as Twilio does through FriendlyName. So
// `purchaseNumber` genuinely creates something that `lookupResourcesByClaim`
// can find afterwards. That is what lets a test reproduce the failure this
// whole design is built around -- provider purchase SUCCEEDS, Hone's finalize
// write is LOST -- and prove that the retry adopts the existing number instead
// of buying a second one. A stub returning canned values could not.
//
// It performs no I/O, no timers and no randomness: identifiers are derived
// from the claim key by hash, so the same attempt yields the same SIDs on
// every run and in every process.

// ---------------------------------------------------------------------------
// Deterministic identifiers
// ---------------------------------------------------------------------------

function hex32(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/** Shape-identical to a Twilio IncomingPhoneNumber SID. */
export function fakePhoneNumberSid(claimKey: string): string {
  return `PN${hex32(`pn:${claimKey}`)}`;
}

/** Shape-identical to a Twilio Messaging Service SID. */
export function fakeMessagingServiceSid(claimKey: string): string {
  return `MG${hex32(`mg:${claimKey}`)}`;
}

// ---------------------------------------------------------------------------
// Scripted behaviour
// ---------------------------------------------------------------------------

/**
 * How the fake should behave on the next call of a given kind. Tests set these
 * to reproduce a specific real-world failure; nothing else reads them.
 *
 * `purchaseThenLoseResponse` is the important one: the purchase SUCCEEDS and
 * the resource IS created in the store, but the caller receives a timeout.
 * That is the genuinely dangerous ambiguity -- Hone does not know whether it
 * owns a number -- and reconciliation is the only thing that resolves it.
 */
export type FakeProviderScript = {
  searchFails?: ProviderErrorCode;
  availabilityFails?: ProviderErrorCode;
  lookupFails?: ProviderErrorCode;
  createServiceFails?: ProviderErrorCode;
  purchaseFails?: ProviderErrorCode;
  purchaseThenLoseResponse?: boolean;
  attachFails?: ProviderErrorCode;
  webhookFails?: ProviderErrorCode;
  statusCallbackFails?: ProviderErrorCode;
  testSendFails?: ProviderErrorCode;
  /**
   * WILLOW ADOPTION. Numbers this ACCOUNT already owns, as if bought outside
   * Hone: E.164 -> its phone number SID. Absent means the account does not own
   * it.
   */
  preOwnedNumbers?: Record<string, string>;
  /**
   * The account's Messaging Services, in the order the list endpoint returns
   * them, each with the numbers it holds. The fake PAGINATES over this exactly
   * as the real adapter does, so a pagination test exercises real walking.
   */
  accountServices?: Array<{
    /** Null/undefined models a page entry with no SID; a bad string models a malformed one. */
    sid: string | null | undefined;
    numbers: string[];
    inboundUrl?: string | null;
    statusUrl?: string | null;
  } | null>;
  /** Page size for the service list walk. Small values force multiple pages. */
  servicePageSize?: number;
  /**
   * 1-based page index whose REQUEST fails. Mirrors the adapter: an HTTP-level
   * failure keeps its provider classification and is not a census gap.
   */
  failServicePage?: number;
  /** Provider error code the failing page returns. */
  failServicePageCode?: ProviderErrorCode;
  /** 1-based page index that returns 200 with unreadable content -> unavailable. */
  unparseableServicePage?: number;
  /** Make one membership probe unreadable. */
  membershipProbeFails?: boolean;
  /** Fail the ownership lookup itself. */
  ownedLookupFails?: ProviderErrorCode;
  /** Which sender the POOL used for the test send. Defaults to the service's first number. */
  testSendFrom?: string;
  /** The provider refuses the explicit From (not in the service's sender pool). */
  rejectExplicitFrom?: boolean;
  /** The response names a sender that CONTRADICTS the requested From. */
  reportContradictorySender?: string;
  /** The provider reported no sender at all. Must never read as success. */
  testSendFromMissing?: boolean;
  /** Fail the service configuration read. */
  serviceConfigFails?: ProviderErrorCode;
  /**
   * The provider ACKNOWLEDGES a configuration write and does not apply it.
   *
   * This is why post-write verification exists at all: a 2xx says the request
   * was accepted, not that the resource now holds the value. Without a fake
   * that can lie this way, a verification step is untestable and every "we
   * verified" claim is really a claim about the fake.
   */
  configureSilentlyDrops?: boolean;
  /** Numbers the fake considers already taken by someone else. */
  unavailableNumbers?: string[];
};

type PurchasedNumber = { phoneNumber: string; phoneNumberSid: string };

type StoredResources = {
  /**
   * EVERY number purchased under this claim, not just the first.
   *
   * Twilio will happily sell a second number carrying the same FriendlyName --
   * the tag is a label, not a constraint -- so a fake that silently deduped by
   * claim key would hide the exact catastrophe this design exists to prevent
   * and make a broken orchestration look correct.
   */
  numbers: PurchasedNumber[];
  messagingServiceSid: string | null;
  friendlyName: string;
};

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "provider_timeout",
  "provider_network",
  "provider_unavailable",
  "provider_rate_limited",
]);

export class FakeSmsProvisioningProvider implements SmsProvisioningProvider {
  readonly name = "fake" as const;

  /** Resources this provider "owns", keyed by claim key -- Twilio's FriendlyName. */
  private readonly store = new Map<string, StoredResources>();

  /** Call counters, so a test can assert AT MOST ONE PURCHASE happened. */
  readonly calls = {
    search: 0,
    availability: 0,
    lookup: 0,
    ownedLookup: 0,
    serviceConfigRead: 0,
    servicePages: 0,
    createService: 0,
    purchase: 0,
    attach: 0,
    inboundWebhook: 0,
    statusCallback: 0,
    testSend: 0,
  };

  /**
   * Configuration actually applied to a service, overlaying the scripted
   * starting state. Twilio persists these writes; a fake that only counted
   * them would make a re-read return the pre-write value and turn every
   * verification test green for the wrong reason.
   */
  private readonly serviceConfig = new Map<
    string,
    { inbound?: string | null; status?: string | null }
  >();

  script: FakeProviderScript = {};

  constructor(script: FakeProviderScript = {}) {
    this.script = script;
  }

  /** Everything the fake believes it owns. Test-facing inspection only. */
  /**
   * EVERY number this fake account holds, from either source.
   *
   * The union matters because `preOwnedNumbers` models inventory the studio
   * bought outside Hone -- it carries no claim-key tag, so it is invisible to
   * the claim-key store. Reading only that store let one number be reported as
   * already owned by the adoption path AND advertised as available AND
   * purchased, three answers no real account can give at once. A fake that
   * permits what the provider cannot is worse than a missing test: it makes
   * green meaningless exactly where the orchestration relies on it.
   */
  ownedNumbers(): string[] {
    const fromClaims = [...this.store.values()].flatMap((r) =>
      r.numbers.map((n) => n.phoneNumber),
    );
    const preOwned = Object.keys(this.script.preOwnedNumbers ?? {});
    return [...new Set([...fromClaims, ...preOwned])];
  }

  reset(script: FakeProviderScript = {}): void {
    this.store.clear();
    this.script = script;
    for (const key of Object.keys(this.calls) as Array<keyof typeof this.calls>) {
      this.calls[key] = 0;
    }
  }

  private fail(code: ProviderErrorCode) {
    return providerError(code, RETRYABLE.has(code));
  }

  private slot(claimKey: string): StoredResources {
    const existing = this.store.get(claimKey);
    if (existing) return existing;
    const created: StoredResources = {
      numbers: [],
      messagingServiceSid: null,
      friendlyName: claimFriendlyName(claimKey),
    };
    this.store.set(claimKey, created);
    return created;
  }

  async searchAvailableNumbers(
    input: SearchNumbersInput,
  ): Promise<ProviderResult<{ candidates: AvailableNumberCandidate[] }>> {
    this.calls.search += 1;
    if (this.script.searchFails) return this.fail(this.script.searchFails);

    const area = input.areaCode ?? "416";
    const taken = new Set([
      ...(this.script.unavailableNumbers ?? []),
      ...this.ownedNumbers(),
    ]);

    const candidates: AvailableNumberCandidate[] = [];
    for (let i = 0; candidates.length < input.limit && i < 50; i += 1) {
      const line = String(5550100 + i).slice(-7);
      const phoneNumber = `+1${area}${line}`;
      if (taken.has(phoneNumber)) continue;
      candidates.push({
        phoneNumber,
        formatted: `(${area}) ${line.slice(0, 3)}-${line.slice(3)}`,
        locality: "Testville",
        region: "ON",
        country: input.country,
        smsCapable: true,
        mmsCapable: true,
      });
    }
    if (candidates.length === 0) return this.fail("no_numbers_available");
    return { ok: true, candidates };
  }

  async isNumberAvailable(input: {
    country: string;
    phoneNumber: string;
  }): Promise<ProviderResult<{ available: boolean }>> {
    this.calls.availability += 1;
    if (this.script.availabilityFails) {
      return this.fail(this.script.availabilityFails);
    }
    const taken = new Set([
      ...(this.script.unavailableNumbers ?? []),
      ...this.ownedNumbers(),
    ]);
    return { ok: true, available: !taken.has(input.phoneNumber) };
  }

  /**
   * WILLOW ADOPTION. Reports what the account owns and WHERE the number lives.
   *
   * Mutates nothing -- in particular it never adds to `store`, so a test cannot
   * conjure an adopted resource by asking about it. It walks the service list in
   * pages and probes membership per service, the same shape as the real adapter,
   * so pagination and partial-census behaviour are genuinely exercised rather
   * than stubbed.
   */
  async lookupOwnedNumber(input: {
    phoneNumber: string;
    expectedMessagingServiceSid: string;
  }): Promise<ProviderResult<{ facts: OwnedNumberFacts }>> {
    this.calls.ownedLookup += 1;
    if (this.script.ownedLookupFails) return this.fail(this.script.ownedLookupFails);

    const sid = this.script.preOwnedNumbers?.[input.phoneNumber];
    if (!sid) {
      return {
        ok: true,
        facts: {
          phoneNumberSid: null,
          phoneNumber: null,
          association: { kind: "unavailable", reason: "number_not_owned" },
        },
      };
    }

    const services = this.script.accountServices ?? [];
    const pageSize = this.script.servicePageSize ?? 100;
    const holders: string[] = [];
    let page = 0;

    for (let i = 0; i < services.length || i === 0; i += pageSize) {
      page += 1;
      this.calls.servicePages += 1;
      if (this.script.failServicePage === page) {
        // A FAILED PAGE IS NOT AN EMPTY PAGE -- and it is not a census gap
        // either. It keeps its provider classification.
        return this.fail(this.script.failServicePageCode ?? "provider_unavailable");
      }
      if (this.script.unparseableServicePage === page) {
        // 200, but the body could not be read. THAT is a census gap.
        return {
          ok: true,
          facts: {
            phoneNumberSid: sid,
            phoneNumber: input.phoneNumber,
            association: { kind: "unavailable", reason: "service_page_unparseable" },
          },
        };
      }
      for (const svc of services.slice(i, i + pageSize)) {
        // Mirror the adapter's per-entry parse. Whatever the adapter does with
        // an entry it cannot read, the fake must do too, or every census test
        // is a statement about the fake rather than about the adapter.
        // Mirror the adapter: an unreadable entry fails the census closed.
        const svcSid = asMessagingServiceSid(svc?.sid ?? null);
        if (!svcSid) {
          return {
            ok: true,
            facts: {
              phoneNumberSid: sid,
              phoneNumber: input.phoneNumber,
              association: { kind: "unavailable", reason: "service_page_unparseable" },
            },
          };
        }
        if (this.script.membershipProbeFails) {
          return this.fail(this.script.failServicePageCode ?? "provider_unavailable");
        }
        if (svc!.numbers.includes(input.phoneNumber)) holders.push(svcSid);
      }
      if (services.length === 0) break;
    }

    return {
      ok: true,
      facts: {
        phoneNumberSid: sid,
        phoneNumber: input.phoneNumber,
        association: classifyAssociation(holders, input.expectedMessagingServiceSid),
      },
    };
  }

  /** WILLOW ADOPTION. Read-only: the service's current webhook configuration. */
  async readMessagingServiceConfig(input: {
    messagingServiceSid: string;
  }): Promise<ProviderResult<{ config: MessagingServiceConfig }>> {
    this.calls.serviceConfigRead += 1;
    if (this.script.serviceConfigFails) return this.fail(this.script.serviceConfigFails);
    const svc = (this.script.accountServices ?? []).find((x) => x?.sid === input.messagingServiceSid);
    if (!svc) return this.fail("provider_resource_mismatch");
    const applied = this.serviceConfig.get(input.messagingServiceSid);
    return {
      ok: true,
      config: {
        inboundRequestUrl:
          applied && "inbound" in applied ? (applied.inbound ?? null) : (svc.inboundUrl ?? null),
        statusCallbackUrl:
          applied && "status" in applied ? (applied.status ?? null) : (svc.statusUrl ?? null),
      },
    };
  }

  async lookupResourcesByClaim(
    claimKey: string,
  ): Promise<ProviderResult<{ found: ClaimedResources }>> {
    this.calls.lookup += 1;
    if (this.script.lookupFails) return this.fail(this.script.lookupFails);

    const found = this.store.get(claimKey);
    // Two numbers under one claim is unresolvable, exactly as the real adapter
    // treats it: refuse to choose rather than guess which one Hone owns.
    if (found && found.numbers.length > 1) {
      return this.fail("provider_resource_mismatch");
    }
    const only = found?.numbers[0] ?? null;
    return {
      ok: true,
      found: {
        phoneNumber: only?.phoneNumber ?? null,
        phoneNumberSid: only?.phoneNumberSid ?? null,
        messagingServiceSid: found?.messagingServiceSid ?? null,
      },
    };
  }

  async createMessagingService(input: {
    claimKey: string;
    serviceLabel: string;
  }): Promise<ProviderResult<{ messagingServiceSid: string }>> {
    this.calls.createService += 1;
    if (this.script.createServiceFails) {
      return this.fail(this.script.createServiceFails);
    }
    const slot = this.slot(input.claimKey);
    slot.messagingServiceSid ??= fakeMessagingServiceSid(input.claimKey);
    return { ok: true, messagingServiceSid: slot.messagingServiceSid };
  }

  async purchaseNumber(input: {
    claimKey: string;
    phoneNumber: string;
  }): Promise<ProviderResult<{ phoneNumberSid: string; phoneNumber: string }>> {
    this.calls.purchase += 1;

    if (this.script.unavailableNumbers?.includes(input.phoneNumber)) {
      return this.fail("number_no_longer_available");
    }
    // ALREADY OWNED OUTSIDE HONE. Twilio cannot sell an account a number that
    // account already holds, so neither can the fake -- and the existing "gone"
    // code is the honest answer rather than a new vocabulary.
    //
    // Scoped to `preOwnedNumbers` rather than to all of ownedNumbers(): that is
    // the narrowest thing that models the defect, and it leaves the claim-key
    // store's own same-claim repurchase behaviour (return the existing SID
    // rather than mint a second) exactly as it was. Widening it to ownedNumbers()
    // was tried against the full suite and changed nothing, so this is a choice
    // about blast radius, NOT a claim that a test would catch the difference.
    if (this.script.preOwnedNumbers && input.phoneNumber in this.script.preOwnedNumbers) {
      return this.fail("number_no_longer_available");
    }
    if (this.script.purchaseFails) return this.fail(this.script.purchaseFails);

    // The number is bought FIRST, exactly as Twilio would. Whether the caller
    // ever learns about it is a separate question, decided below.
    const slot = this.slot(input.claimKey);
    let purchased = slot.numbers.find(
      (n) => n.phoneNumber === input.phoneNumber,
    );
    if (!purchased) {
      // A DISTINCT number under the same claim is a DISTINCT billable
      // purchase. The provider does not deduplicate on our behalf.
      purchased = {
        phoneNumber: input.phoneNumber,
        phoneNumberSid: fakePhoneNumberSid(`${input.claimKey}:${input.phoneNumber}`),
      };
      slot.numbers.push(purchased);
    }

    if (this.script.purchaseThenLoseResponse) {
      // THE DANGEROUS CASE. Money has been spent and the caller is told
      // nothing but "timeout". Only a lookup by claim key can find this.
      return this.fail("provider_timeout");
    }

    return {
      ok: true,
      phoneNumberSid: purchased.phoneNumberSid,
      phoneNumber: purchased.phoneNumber,
    };
  }

  async attachNumberToService(): Promise<ProviderAck> {
    this.calls.attach += 1;
    if (this.script.attachFails) return this.fail(this.script.attachFails);
    return { ok: true };
  }

  async configureInboundWebhook(input: {
    messagingServiceSid: string;
    inboundWebhookUrl: string;
  }): Promise<ProviderAck> {
    this.calls.inboundWebhook += 1;
    if (this.script.webhookFails) return this.fail(this.script.webhookFails);
    if (!this.script.configureSilentlyDrops) {
      const cur = this.serviceConfig.get(input.messagingServiceSid) ?? {};
      cur.inbound = input.inboundWebhookUrl;
      this.serviceConfig.set(input.messagingServiceSid, cur);
    }
    return { ok: true };
  }

  async configureStatusCallback(input: {
    messagingServiceSid: string;
    statusCallbackUrl: string;
  }): Promise<ProviderAck> {
    this.calls.statusCallback += 1;
    if (this.script.statusCallbackFails) {
      return this.fail(this.script.statusCallbackFails);
    }
    if (!this.script.configureSilentlyDrops) {
      const cur = this.serviceConfig.get(input.messagingServiceSid) ?? {};
      cur.status = input.statusCallbackUrl;
      this.serviceConfig.set(input.messagingServiceSid, cur);
    }
    return { ok: true };
  }

  async sendProvisioningTest(input: {
    messagingServiceSid: string;
    to: string;
    body: string;
    fromPhoneNumber?: string;
  }): Promise<ProviderResult<{ messageSid: string; sentFrom: string | null }>> {
    this.calls.testSend += 1;
    if (this.script.testSendFails) return this.fail(this.script.testSendFails);

    const svc = (this.script.accountServices ?? []).find(
      (x) => x?.sid === input.messagingServiceSid,
    );

    if (input.fromPhoneNumber) {
      // EXPLICIT SENDER. Twilio refuses a From that is not in the service's
      // sender pool, so the fake refuses it too -- otherwise adoption's proof
      // would be a statement about the fake's leniency.
      const inPool = svc?.numbers.includes(input.fromPhoneNumber) ?? false;
      if (this.script.rejectExplicitFrom || (svc && !inPool)) {
        return this.fail("provider_rejected");
      }
      return {
        ok: true,
        messageSid: `SM${hex32(`test:${input.fromPhoneNumber}`)}`,
        // The response may not have caught up; null is normal, not a failure.
        sentFrom: this.script.testSendFromMissing
          ? null
          : (this.script.reportContradictorySender ?? input.fromPhoneNumber),
      };
    }

    // NO explicit sender: the service chooses. This is the purchase path, whose
    // pool holds exactly one number.
    const fromOwned = svc?.numbers[0] ?? null;
    const fromClaim =
      [...this.store.values()].find((r) => r.messagingServiceSid === input.messagingServiceSid)
        ?.numbers[0]?.phoneNumber ?? null;
    const sentFrom = this.script.testSendFromMissing
      ? null
      : (this.script.testSendFrom ?? fromOwned ?? fromClaim);

    return { ok: true, messageSid: `SM${hex32(`test:${input.messagingServiceSid}`)}`, sentFrom };
  }


}
