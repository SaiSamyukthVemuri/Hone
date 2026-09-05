import "server-only";
import crypto from "node:crypto";
import {
  claimFriendlyName,
  providerError,
  type AvailableNumberCandidate,
  type ClaimedResources,
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
    createService: 0,
    purchase: 0,
    attach: 0,
    inboundWebhook: 0,
    statusCallback: 0,
    testSend: 0,
  };

  script: FakeProviderScript = {};

  constructor(script: FakeProviderScript = {}) {
    this.script = script;
  }

  /** Everything the fake believes it owns. Test-facing inspection only. */
  ownedNumbers(): string[] {
    return [...this.store.values()].flatMap((r) =>
      r.numbers.map((n) => n.phoneNumber),
    );
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

  async configureInboundWebhook(): Promise<ProviderAck> {
    this.calls.inboundWebhook += 1;
    if (this.script.webhookFails) return this.fail(this.script.webhookFails);
    return { ok: true };
  }

  async configureStatusCallback(): Promise<ProviderAck> {
    this.calls.statusCallback += 1;
    if (this.script.statusCallbackFails) {
      return this.fail(this.script.statusCallbackFails);
    }
    return { ok: true };
  }

  async sendProvisioningTest(): Promise<ProviderResult<{ messageSid: string }>> {
    this.calls.testSend += 1;
    if (this.script.testSendFails) return this.fail(this.script.testSendFails);
    return { ok: true, messageSid: `SM${hex32("test")}` };
  }
}
