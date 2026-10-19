"use server";

import {
  liveProvisioningArmed,
  resolveProvisioningProvider,
} from "@/lib/sms/provider";
import { searchAvailableSenderNumbers } from "@/lib/sms/provisioning";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// Settings → Integrations server actions.
//
// SMS-NUMBER-SEARCH-01. Hone ships a complete per-studio SMS sender lifecycle --
// purchase orchestration, adoption, a lease fence, and an eight-status state
// machine with its transition guard and readiness constraint in migration 0191 --
// and until #749 no product path could reach ANY of it. #749 made the RESULT
// visible: an owner can now see whether their studio has a sender. This action
// makes the FIRST STEP reachable: an owner can ask which numbers their studio
// could actually use.
//
// WHAT THIS DELIBERATELY IS NOT.
//
// It does not buy, claim, reserve, adopt, configure, test, finalize or release
// anything. `searchAvailableSenderNumbers` states its own posture: "Writes
// nothing: no claim, no row, no status change, no messaging service, and above
// all no purchase or reservation. An owner may browse as often as they like and
// it costs nothing and commits to nothing." This action adds no write of its own
// on top of that, so the studio's sender row -- and its absence -- is exactly as
// it was before the owner pressed the button.
//
// There is NO admin / service-role client in this file, and that is a design
// statement rather than an omission: a read-only candidate search needs no
// elevated privilege, and `tests/source-guards/sms-number-search-boundary.test.ts`
// fails if one appears here. The same guard pins the absence of every write
// symbol in the lifecycle, so the next slice has to add its caller deliberately
// instead of inheriting one.
//
// THE PROVIDER BOUNDARY -- AND WHY THE FENCE ALONE WAS NOT ENOUGH.
//
// The provider comes from `resolveProvisioningProvider()`, which returns the
// FAKE unless `HONE_SMS_PROVISIONING_LIVE === "true"` AND both Twilio
// credentials are present. The credentials are already set wherever Hone sends
// SMS, so the flag is the only input an operator must add deliberately -- which
// is the whole reason it exists. That flag is absent from production, preview and
// development, so nothing here can contact Twilio or spend money until someone
// arms it on purpose. Arming is a separate authorized provider operation and is
// NOT part of this slice.
//
// THE DEFECT THAT FENCE DID NOT CLOSE, and it is the reason for the gate below.
// The first revision of this action reasoned about the fence in terms of MONEY
// and MUTATION only, and on those it was right. It never asked what the fake
// RETURNS. `FakeSmsProvisioningProvider.searchAvailableNumbers` synthesizes
// candidates -- `+1${areaCode}555xxxx`, locality "Testville" -- so in every
// deployed configuration an owner pressing Find numbers was shown INVENTED
// numbers presented as genuinely available. Nothing was spent and nothing was
// written, and the surface still lied.
//
// So an unarmed deployment REFUSES rather than answering from the fake. The
// fake remains the right default for the resolver -- the provisioning and
// adoption suites depend on it -- and the judgement that a test double must
// never reach a real owner belongs to the caller, which is here.
//
// TWO ENFORCEMENT POINTS, ONE PREDICATE, following the lesson
// `lib/waitlist/mobile-verification/arming.ts` was written to record: this
// action refuses, AND the page does not render the control at all. Either can
// fail independently and the owner still never sees a fabricated number.
//
// AUTHORIZATION IS PROVED HERE, BECAUSE THE ORCHESTRATION SAYS SO.
//
// `searchAvailableSenderNumbers` requires authorization and says it "is proved by
// the caller before this is reached" -- one studio's owner has no business
// enumerating on behalf of another. So this action re-derives identity from the
// session and refuses a non-owner, exactly as the page above it does. No studio
// id crosses the wire: the studio is whatever the signed-in owner's own record
// says it is, so there is no id for a browser to tamper with.

/** The owner-safe shape of one candidate. Carries no provider SID, by construction. */
export type SenderNumberCandidateView = {
  /** E.164, e.g. "+14165550123". */
  phoneNumber: string;
  /** Display form as the provider gave it, e.g. "(416) 555-0123". */
  formatted: string;
  /** Locality, e.g. "Toronto". Null when the provider does not supply one. */
  locality: string | null;
  /** Region / province / state code, e.g. "ON". Null when unknown. */
  region: string | null;
  /** ISO-3166 alpha-2, echoed from the search so the result states its own scope. */
  country: string;
  /** A sender must be able to send SMS. MMS is not part of this decision. */
  smsCapable: boolean;
};

export type SenderNumberSearchResult =
  | {
      ok: true;
      candidates: SenderNumberCandidateView[];
      /** What was actually searched, so the result never implies a wider scope. */
      searchedCountry: string;
      searchedAreaCode: string | null;
    }
  | { ok: false; message: string };

// One line per refusal the search can produce, as an exhaustive Record so a new
// provider error code cannot be added upstream without this file failing to
// compile. The same discipline the recipient invitation screen uses for
// `BookingRefusal`.
//
// None of these mention Twilio. The owner is choosing a phone number, not
// operating a provider account, and a provider's name in an error message is a
// support burden rather than an explanation.
const REFUSAL_COPY: Record<
  | "not_authorized"
  | "invalid_input"
  | "provider_not_configured"
  | "provider_timeout"
  | "provider_network"
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_unauthorized"
  | "number_no_longer_available"
  | "no_numbers_available"
  | "provider_response_unparseable"
  | "provider_resource_mismatch"
  | "provider_rejected"
  | "provider_error_unspecified"
  | "lease_lost",
  string
> = {
  not_authorized: "Only the studio owner can look up numbers.",
  invalid_input:
    "Enter a two-letter country code, and an area code of 2 to 5 digits if you want one.",
  // The honest reading of an unarmed deployment: number lookup is not switched
  // on here. It is not an error the owner can clear, so it does not invite a retry.
  provider_not_configured:
    "Number lookup is not switched on for this deployment yet.",
  provider_timeout: "The number lookup timed out. Please try again.",
  provider_network: "We could not reach the number lookup. Please try again.",
  provider_unavailable:
    "Number lookup is temporarily unavailable. Please try again shortly.",
  provider_rate_limited:
    "Too many lookups just now. Please wait a moment and try again.",
  provider_unauthorized:
    "Number lookup is not configured correctly. Please contact support.",
  // Reachable here only if the provider narrows availability mid-search. Never
  // substitute a different number: the owner asked about a specific one.
  number_no_longer_available:
    "That number is no longer available. Please search again.",
  no_numbers_available:
    "No numbers are available for that country and area code. Try a different area code.",
  provider_response_unparseable:
    "The number lookup returned something we could not read. Please try again.",
  provider_resource_mismatch:
    "The number lookup returned something unexpected. Please try again.",
  provider_rejected: "The number lookup was refused. Please contact support.",
  provider_error_unspecified:
    "The number lookup failed. Please try again shortly.",
  // Not a provider condition: the fencing wrapper emits it when a worker has
  // been displaced. A search holds no lease, so reaching this would mean the
  // fence changed shape -- answer honestly rather than inventing a cause.
  lease_lost: "The number lookup could not be completed. Please try again.",
};

/**
 * Look up phone numbers the studio could use as its SMS sender.
 *
 * Read-only in every sense that matters: no database write, no provider
 * mutation, no money, no commitment. Returns the candidates or one refusal line.
 */
export async function searchSenderNumbersAction(
  _prev: SenderNumberSearchResult | null,
  formData: FormData,
): Promise<SenderNumberSearchResult> {
  const { practitioner } = await getCurrentPractitionerWithStudio();

  // Owner-only, re-derived from the session rather than trusted from the form.
  // Defence in depth: the page already redirects a non-owner, and this refuses
  // one again for the direct-POST case that never rendered the page at all.
  if (practitioner.role !== "owner") {
    return { ok: false, message: REFUSAL_COPY.not_authorized };
  }

  // UNARMED MEANS REFUSE, NOT ANSWER-FROM-THE-FAKE. Checked before the inputs
  // are even read: an unarmed deployment has nothing to say about any country,
  // so validating the form first would answer a narrower question than the one
  // being refused.
  if (!liveProvisioningArmed()) {
    return { ok: false, message: REFUSAL_COPY.provider_not_configured };
  }

  const country = (formData.get("country") ?? "").toString().trim().toUpperCase();
  const rawAreaCode = (formData.get("areaCode") ?? "").toString().trim();
  const areaCode = rawAreaCode === "" ? null : rawAreaCode;

  const outcome = await searchAvailableSenderNumbers({
    provider: resolveProvisioningProvider(),
    country,
    areaCode,
  });

  if (!outcome.ok) {
    return { ok: false, message: REFUSAL_COPY[outcome.reason] };
  }

  // Narrow to the owner-safe view explicitly rather than forwarding the
  // provider's object. A candidate carries no SID today, and spreading it would
  // mean a future field reaching the browser because nobody re-read this line.
  return {
    ok: true,
    searchedCountry: country,
    searchedAreaCode: areaCode,
    candidates: outcome.candidates.map((c) => ({
      phoneNumber: c.phoneNumber,
      formatted: c.formatted,
      locality: c.locality,
      region: c.region,
      country: c.country,
      smsCapable: c.smsCapable,
    })),
  };
}
