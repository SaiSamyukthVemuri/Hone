import "server-only";
import {
  asArray,
  asBoolean,
  asE164,
  asMessagingServiceSid,
  asPhoneNumberSid,
  asRecord,
  asString,
  claimFriendlyName,
  providerError,
  type AvailableNumberCandidate,
  type ClaimedResources,
  type ProviderError,
  type ProviderAck,
  type ProviderResult,
  type SearchNumbersInput,
  type SmsProvisioningProvider,
} from "./types";

// The real Twilio provisioning adapter (COMMS-01B).
//
// PHILOSOPHY, INHERITED FROM lib/sms/twilio.ts AND NOT RE-LITIGATED HERE:
//   * direct `fetch` against the REST API; the `twilio` npm SDK is NOT added.
//     Convenience is not a measured reason, and an SDK here would put a large
//     dependency between Hone and the only calls it makes that spend money.
//   * Basic Auth with the deployment-global account credentials.
//   * every call is bounded by an AbortController timeout.
//   * failures collapse to the shared taxonomy; nothing throws to the caller.
//
// LOGGING DISCIPLINE. This file emits NO logs at all. That is the simplest
// defensible position for a module holding an Auth Token, full phone numbers
// and raw provider payloads in local scope: there is no log statement to audit,
// so none can drift into carrying one of them. Failures are returned as tags
// and the orchestration decides what is safe to record.
//
// FAIL-CLOSED PARSING. Every field read from a response goes through the
// validators in ./types. A 200 whose body we do not recognise is
// `provider_response_unparseable`, not a partially-populated success. We never
// persist a SID we did not verify the shape of.
//
// THE CLAIM KEY IS THE POINT. Every resource this file creates is tagged with
// `hone-sms-claim:<claimKey>` as its FriendlyName, and lookupResourcesByClaim
// searches on exactly that. This is what lets Hone discover a number it bought
// but failed to write down, instead of buying a second one.

const API_BASE = "https://api.twilio.com/2010-04-01";
const MESSAGING_BASE = "https://messaging.twilio.com/v1";
const TIMEOUT_MS = 15_000;

type Credentials = { accountSid: string; authToken: string };

function readCredentials(): Credentials | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return { accountSid, authToken };
}

/** Map a transport/HTTP outcome onto the shared taxonomy. */
function httpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return providerError("provider_unauthorized", false);
  }
  if (status === 429) return providerError("provider_rate_limited", true);
  if (status >= 500) return providerError("provider_unavailable", true);
  return providerError("provider_rejected", false);
}

type RawResponse = { status: number; json: unknown };

/**
 * One bounded request. Returns the status and parsed JSON, or a taxonomy
 * error. The Auth Token is used here and never leaves this function; the
 * response body is returned to the caller in-process and is never logged or
 * persisted by anyone.
 */
async function request(
  creds: Credentials,
  url: string,
  init: { method: "GET" | "POST"; form?: URLSearchParams },
): Promise<ProviderResult<RawResponse>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${creds.accountSid}:${creds.authToken}`,
        ).toString("base64")}`,
        Accept: "application/json",
        ...(init.form
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: init.form ? init.form.toString() : undefined,
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // Non-JSON body. Left null; callers fail closed on the shape check.
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    // A timeout is the AMBIGUOUS case: the request may have been executed.
    // Both are retryable so the attempt is parked with its claim intact and
    // reconciliation resolves the ambiguity by asking the provider.
    return providerError(
      timedOut ? "provider_timeout" : "provider_network",
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseCandidate(raw: unknown, country: string): AvailableNumberCandidate | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const phoneNumber = asE164(rec.phone_number);
  if (!phoneNumber) return null;
  const capabilities = asRecord(rec.capabilities) ?? {};
  const smsCapable = asBoolean(capabilities.SMS ?? capabilities.sms);
  // A number that cannot carry SMS is not a candidate for an SMS sender.
  if (!smsCapable) return null;
  return {
    phoneNumber,
    formatted: asString(rec.friendly_name) ?? phoneNumber,
    locality: asString(rec.locality),
    region: asString(rec.region),
    country: asString(rec.iso_country) ?? country,
    smsCapable: true,
    mmsCapable: asBoolean(capabilities.MMS ?? capabilities.mms),
  };
}

export const twilioProvisioningProvider: SmsProvisioningProvider = {
  name: "twilio",

  async searchAvailableNumbers(
    input: SearchNumbersInput,
  ): Promise<ProviderResult<{ candidates: AvailableNumberCandidate[] }>> {
    const creds = readCredentials();
    if (!creds) return providerError("provider_not_configured", false);

    const params = new URLSearchParams();
    params.set("SmsEnabled", "true");
    params.set("PageSize", String(input.limit));
    if (input.areaCode) params.set("AreaCode", input.areaCode);

    const url =
      `${API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}` +
      `/AvailablePhoneNumbers/${encodeURIComponent(input.country)}/Local.json` +
      `?${params.toString()}`;

    const res = await request(creds, url, { method: "GET" });
    if (!res.ok) return res;
    if (res.status !== 200) return httpError(res.status);

    const body = asRecord(res.json);
    const list = body ? asArray(body.available_phone_numbers) : null;
    if (!list) return providerError("provider_response_unparseable", false);

    const candidates: AvailableNumberCandidate[] = [];
    for (const raw of list) {
      const candidate = parseCandidate(raw, input.country);
      // A malformed entry is skipped, not guessed at. The bound still holds.
      if (candidate) candidates.push(candidate);
      if (candidates.length >= input.limit) break;
    }
    if (candidates.length === 0) {
      return providerError("no_numbers_available", false);
    }
    return { ok: true, candidates };
  },

  async isNumberAvailable(input: {
    country: string;
    phoneNumber: string;
  }): Promise<ProviderResult<{ available: boolean }>> {
    const creds = readCredentials();
    if (!creds) return providerError("provider_not_configured", false);

    // `Contains` accepts a full E.164 value, so this asks about exactly the
    // number the owner chose rather than paging through a candidate list.
    const params = new URLSearchParams();
    params.set("Contains", input.phoneNumber);
    params.set("SmsEnabled", "true");
    params.set("PageSize", "1");

    const url =
      `${API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}` +
      `/AvailablePhoneNumbers/${encodeURIComponent(input.country)}/Local.json` +
      `?${params.toString()}`;

    const res = await request(creds, url, { method: "GET" });
    if (!res.ok) return res;
    if (res.status !== 200) return httpError(res.status);

    const body = asRecord(res.json);
    const list = body ? asArray(body.available_phone_numbers) : null;
    if (!list) return providerError("provider_response_unparseable", false);

    // Fail closed on identity: an entry only counts when it is THAT number.
    const available = list.some((raw) => {
      const rec = asRecord(raw);
      return rec !== null && asE164(rec.phone_number) === input.phoneNumber;
    });
    return { ok: true, available };
  },

  async lookupResourcesByClaim(
    claimKey: string,
  ): Promise<ProviderResult<{ found: ClaimedResources }>> {
    const creds = readCredentials();
    if (!creds) return providerError("provider_not_configured", false);

    const tag = claimFriendlyName(claimKey);
    const found: ClaimedResources = {
      phoneNumber: null,
      phoneNumberSid: null,
      messagingServiceSid: null,
    };

    // 1. Did a number get purchased under this claim?
    const numbersUrl =
      `${API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}` +
      `/IncomingPhoneNumbers.json?FriendlyName=${encodeURIComponent(tag)}&PageSize=2`;
    const numbersRes = await request(creds, numbersUrl, { method: "GET" });
    if (!numbersRes.ok) return numbersRes;
    if (numbersRes.status !== 200) return httpError(numbersRes.status);

    const numbersBody = asRecord(numbersRes.json);
    const numbers = numbersBody ? asArray(numbersBody.incoming_phone_numbers) : null;
    if (!numbers) return providerError("provider_response_unparseable", false);
    if (numbers.length > 1) {
      // Two numbers under one claim is the exact catastrophe this design
      // exists to prevent. Refuse to choose; an operator must look.
      return providerError("provider_resource_mismatch", false);
    }
    if (numbers.length === 1) {
      const rec = asRecord(numbers[0]);
      const sid = rec ? asPhoneNumberSid(rec.sid) : null;
      const num = rec ? asE164(rec.phone_number) : null;
      if (!sid || !num) return providerError("provider_response_unparseable", false);
      found.phoneNumberSid = sid;
      found.phoneNumber = num;
    }

    // 2. Did a messaging service get created under this claim? Twilio's
    //    Messaging API has no FriendlyName filter, so this is a bounded scan
    //    of Hone's OWN services -- never of tenant state.
    const servicesRes = await request(
      creds,
      `${MESSAGING_BASE}/Services?PageSize=100`,
      { method: "GET" },
    );
    if (!servicesRes.ok) return servicesRes;
    if (servicesRes.status !== 200) return httpError(servicesRes.status);

    const servicesBody = asRecord(servicesRes.json);
    const services = servicesBody ? asArray(servicesBody.services) : null;
    if (!services) return providerError("provider_response_unparseable", false);

    const matches = services.filter((raw) => {
      const rec = asRecord(raw);
      return rec !== null && asString(rec.friendly_name) === tag;
    });
    if (matches.length > 1) {
      return providerError("provider_resource_mismatch", false);
    }
    if (matches.length === 1) {
      const rec = asRecord(matches[0]);
      const sid = rec ? asMessagingServiceSid(rec.sid) : null;
      if (!sid) return providerError("provider_response_unparseable", false);
      found.messagingServiceSid = sid;
    }

    return { ok: true, found };
  },

  async createMessagingService(input: {
    claimKey: string;
    serviceLabel: string;
  }): Promise<ProviderResult<{ messagingServiceSid: string }>> {
    const creds = readCredentials();
    if (!creds) return providerError("provider_not_configured", false);

    const form = new URLSearchParams();
    // The claim key IS the friendly name. The operator-facing label is not
    // used here: the name has to be machine-findable for reconciliation, and
    // two purposes on one field is how a lookup silently stops matching.
    form.set("FriendlyName", claimFriendlyName(input.claimKey));

    const res = await request(creds, `${MESSAGING_BASE}/Services`, {
      method: "POST",
      form,
    });
    if (!res.ok) return res;
    if (res.status !== 201 && res.status !== 200) return httpError(res.status);

    const sid = asMessagingServiceSid(asRecord(res.json)?.sid);
    if (!sid) return providerError("provider_response_unparseable", false);
    return { ok: true, messagingServiceSid: sid };
  },

  async purchaseNumber(input: {
    claimKey: string;
    phoneNumber: string;
  }): Promise<ProviderResult<{ phoneNumberSid: string; phoneNumber: string }>> {
    const creds = readCredentials();
    if (!creds) return providerError("provider_not_configured", false);

    const form = new URLSearchParams();
    // EXACT number only. Twilio also accepts AreaCode here, which would let it
    // pick something else; passing it would be a silent substitution and is
    // deliberately absent.
    form.set("PhoneNumber", input.phoneNumber);
    // The claim key, written into the billable resource itself. This is the
    // handle a lookup finds when Hone loses the finalize write.
    form.set("FriendlyName", claimFriendlyName(input.claimKey));

    const res = await request(
      creds,
      `${API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}/IncomingPhoneNumbers.json`,
      { method: "POST", form },
    );
    if (!res.ok) return res;

    if (res.status === 400 || res.status === 404) {
      // Twilio 21422 / 21421: the number is no longer purchasable. The owner
      // chose THAT number; we surface it and stop.
      return providerError("number_no_longer_available", false);
    }
    if (res.status !== 201 && res.status !== 200) return httpError(res.status);

    const rec = asRecord(res.json);
    const sid = asPhoneNumberSid(rec?.sid);
    const number = asE164(rec?.phone_number);
    if (!sid || !number) return providerError("provider_response_unparseable", false);
    return { ok: true, phoneNumberSid: sid, phoneNumber: number };
  },

  async attachNumberToService(input: {
    messagingServiceSid: string;
    phoneNumberSid: string;
  }): Promise<ProviderAck> {
    const creds = readCredentials();
    if (!creds) return providerError("provider_not_configured", false);

    const form = new URLSearchParams();
    form.set("PhoneNumberSid", input.phoneNumberSid);

    const res = await request(
      creds,
      `${MESSAGING_BASE}/Services/${encodeURIComponent(input.messagingServiceSid)}/PhoneNumbers`,
      { method: "POST", form },
    );
    if (!res.ok) return res;
    // 409 means the number is already in the pool -- the retry case, and a
    // success for our purposes.
    if (res.status === 409) return { ok: true };
    if (res.status !== 201 && res.status !== 200) return httpError(res.status);
    return { ok: true };
  },

  async configureInboundWebhook(input: {
    messagingServiceSid: string;
    inboundWebhookUrl: string;
  }): Promise<ProviderAck> {
    const creds = readCredentials();
    if (!creds) return providerError("provider_not_configured", false);

    const form = new URLSearchParams();
    form.set("InboundRequestUrl", input.inboundWebhookUrl);
    form.set("InboundMethod", "POST");

    const res = await request(
      creds,
      `${MESSAGING_BASE}/Services/${encodeURIComponent(input.messagingServiceSid)}`,
      { method: "POST", form },
    );
    if (!res.ok) return res;
    if (res.status !== 200) return httpError(res.status);
    return { ok: true };
  },

  async configureStatusCallback(input: {
    messagingServiceSid: string;
    statusCallbackUrl: string;
  }): Promise<ProviderAck> {
    const creds = readCredentials();
    if (!creds) return providerError("provider_not_configured", false);

    const form = new URLSearchParams();
    form.set("StatusCallback", input.statusCallbackUrl);

    const res = await request(
      creds,
      `${MESSAGING_BASE}/Services/${encodeURIComponent(input.messagingServiceSid)}`,
      { method: "POST", form },
    );
    if (!res.ok) return res;
    if (res.status !== 200) return httpError(res.status);
    return { ok: true };
  },

  async sendProvisioningTest(input: {
    messagingServiceSid: string;
    to: string;
    body: string;
  }): Promise<ProviderResult<{ messageSid: string }>> {
    const creds = readCredentials();
    if (!creds) return providerError("provider_not_configured", false);

    const form = new URLSearchParams();
    form.set("MessagingServiceSid", input.messagingServiceSid);
    form.set("To", input.to);
    form.set("Body", input.body);

    const res = await request(
      creds,
      `${API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`,
      { method: "POST", form },
    );
    if (!res.ok) return res;
    if (res.status !== 201 && res.status !== 200) return httpError(res.status);

    const sid = asString(asRecord(res.json)?.sid);
    if (!sid) return providerError("provider_response_unparseable", false);
    return { ok: true, messageSid: sid };
  },
};
