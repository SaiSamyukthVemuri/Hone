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

/** Upper bound on the Services pagination walk; reaching it fails closed. */
const SERVICE_PAGE_LIMIT = 50;

/**
 * Twilio error codes that genuinely mean "this number cannot be bought".
 *   21422 - phone number is not available for purchase
 *   21421 - phone number is invalid
 *   21452 - no phone numbers found matching the request
 * Any other 400 is a rejection choosing a different number will not fix.
 */
const NUMBER_UNAVAILABLE_CODES = new Set<number>([21421, 21422, 21452]);

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

    // `Contains` MATCHES ON DIGITS AND `*`, NOT ON E.164. Passing the leading
    // `+` makes Twilio answer 400, which this adapter maps to a rejection --
    // so with the live provider armed, EVERY provisioning attempt would have
    // died here, before any purchase, on a number that was perfectly
    // available. The fake never saw it because a fake does not enforce a
    // provider's parameter grammar.
    //
    // Send digits; keep the E.164 comparison on the RESPONSE, where the
    // provider does speak E.164.
    const params = new URLSearchParams();
    params.set("Contains", input.phoneNumber.replace(/\D/g, ""));
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
    //    Messaging API has no FriendlyName filter, so this is a scan of Hone's
    //    OWN services -- never of tenant state.
    //
    //    IT MUST FOLLOW EVERY PAGE. One service per SMS-enabled studio means
    //    the account crosses a single page at ~100 studios, and a first-page-only
    //    scan would then report "no service under this claim" while the service
    //    sits on page two. Reconciliation would create a second one, and the
    //    number already attached to the missed service would take the
    //    already-in-pool path -- leaving provisioning quietly inconsistent.
    //    An incomplete scan is not absence, so exhausting the pages is the only
    //    reading of "not found" this function is allowed to make.
    const matches: unknown[] = [];
    let nextUrl: string | null = `${MESSAGING_BASE}/Services?PageSize=100`;
    let pagesFetched = 0;

    while (nextUrl) {
      // Bound the walk so a malformed `next_page_url` cannot loop forever.
      // Reaching the bound is NOT treated as absence; it fails closed.
      if (pagesFetched >= SERVICE_PAGE_LIMIT) {
        return providerError("provider_response_unparseable", false);
      }
      pagesFetched += 1;

      const servicesRes: ProviderResult<RawResponse> = await request(
        creds,
        nextUrl,
        { method: "GET" },
      );
      if (!servicesRes.ok) return servicesRes;
      if (servicesRes.status !== 200) return httpError(servicesRes.status);

      const servicesBody = asRecord(servicesRes.json);
      const services = servicesBody ? asArray(servicesBody.services) : null;
      if (!services) return providerError("provider_response_unparseable", false);

      for (const raw of services) {
        const rec = asRecord(raw);
        if (rec !== null && asString(rec.friendly_name) === tag) matches.push(rec);
      }

      // Twilio paginates via `meta.next_page_url`, explicitly null on the last
      // page. AN EXPLICIT null IS THE ONLY THING THAT ENDS THIS SCAN.
      //
      // Collapsing "absent metadata", "a non-string cursor" and "a cursor
      // pointing somewhere else" into null would let a 200 with a valid
      // `services` array but broken pagination read as proof that no matching
      // service exists -- and creating the duplicate that proof licenses is
      // exactly what the exhaustive scan exists to prevent. Malformed is not
      // finished.
      const meta = servicesBody ? asRecord(servicesBody.meta) : null;
      if (!meta || !("next_page_url" in meta)) {
        return providerError("provider_response_unparseable", false);
      }
      const rawNext = meta.next_page_url;
      if (rawNext === null) {
        nextUrl = null;
      } else {
        const next = asString(rawNext);
        // Only follow Twilio's own host; a redirected cursor is not a page of
        // ours, and is a response we refuse rather than quietly truncate on.
        if (!next || !next.startsWith(MESSAGING_BASE)) {
          return providerError("provider_response_unparseable", false);
        }
        nextUrl = next;
      }
    }

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
      // READ THE CODE, DO NOT ASSUME IT. Twilio returns 400 for plenty that has
      // nothing to do with availability -- invalid configuration, a missing
      // regulatory bundle or address, an account restriction. Telling an owner
      // "that number is gone, pick another" when the real problem follows them
      // to every number sends them round a loop that cannot terminate.
      //
      // Only the documented unavailable-number codes mean what the retry advice
      // implies; everything else is a rejection the owner cannot fix by
      // choosing differently.
      const code = asRecord(res.json)?.code;
      const unavailable =
        typeof code === "number" && NUMBER_UNAVAILABLE_CODES.has(code);
      return providerError(
        unavailable ? "number_no_longer_available" : "provider_rejected",
        false,
      );
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
