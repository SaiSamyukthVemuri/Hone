import "server-only";
import { liveMobileVerificationArmed } from "./arming";
import type {
  MobileVerificationProvider,
  VerificationCheckOutcome,
  VerificationDestination,
  VerificationStartOutcome,
} from "./types";

// The REAL Twilio Verify adapter (WAIT B2b-2).
//
// THIS FILE IS INERT UNTIL SOMETHING ARMS IT, AND IT ENFORCES THAT ITSELF. Two
// independent points have to be true: `./index.ts` hands this adapter out only
// when `liveMobileVerificationArmed()` is true, AND `readConfig()` below re-checks
// the same predicate on every call. So constructing this class directly proves
// nothing and sends nothing, and an instance held across a change in process.env
// goes inert on its next call rather than at some later lifecycle event. Nothing
// here arms itself and there is no module-load side effect.
//
// THAT IS NOT A HOT KILL SWITCH, and an earlier revision of this header implied it
// was. On Vercel, unsetting a hosted variable does not mutate `process.env` in the
// deployment already serving traffic, so an ARMED deployment stays armed until it
// is redeployed. ./arming.ts carries the full statement and the house precedent.
//
// PHILOSOPHY, INHERITED FROM lib/sms/provider/twilio-provider.ts AND NOT
// RE-LITIGATED HERE:
//   * direct `fetch` against the REST API; the `twilio` npm SDK is NOT added.
//   * Basic Auth with the deployment-global account credentials.
//   * every call is bounded by an AbortController timeout.
//   * failures collapse to the caller's own vocabulary; nothing throws out.
//
// LOGGING DISCIPLINE: THIS FILE EMITS NO LOGS AT ALL. It holds an Auth Token, a
// full phone number, a one-time code and a raw provider payload in local scope.
// The simplest defensible position for such a module is that there is no log
// statement to audit, so none can drift into carrying one of them. Callers get a
// single enum value and decide what is safe to record.
// `tests/source-guards/mobile-verification-provider-guards.test.ts` asserts the
// absence rather than trusting this paragraph.
//
// WHY THE VOCABULARY IS NOT THE PROVISIONING TAXONOMY. lib/sms/provider/types.ts
// has a rich `ProviderError` because provisioning reconciles money-spending
// resources. Possession proof needs the opposite: the four coarse values in
// ./types.ts, which exist so that a surface cannot accidentally tell an
// anonymous caller WHICH way their attempt failed. Importing the richer taxonomy
// here would put a vocabulary in reach that this boundary is designed not to have.

const VERIFY_BASE = "https://verify.twilio.com/v2";

/**
 * Shorter than provisioning's 15s on purpose: a person is waiting on a form, and
 * a verification request that has not answered in ten seconds is not going to
 * answer usefully. An expired budget is `unavailable`, which invites a retry.
 */
const TIMEOUT_MS = 10_000;

/**
 * SMS AND ONLY SMS, AS A CONSTANT RATHER THAN A PARAMETER.
 *
 * Nothing above this boundary may select a channel. A channel is a claim about
 * what the person agreed to receive, and `./types.ts` deliberately gives the
 * boundary nothing but an E.164 string — no consent state, no studio, no entry.
 * A caller able to ask for `channel: "call"` would be making a consent decision
 * in a module that holds none of the facts needed to make it.
 */
const CHANNEL = "sms";

type Config = {
  accountSid: string;
  authToken: string;
  serviceSid: string;
};

/**
 * Read per call, never at module load, AND GATED ON THE ARMING FLAG.
 *
 * THE FLAG CHECK HERE IS NOT REDUNDANT WITH THE RESOLVER'S, AND AN EARLIER
 * REVISION OF THIS COMMENT WAS SIMPLY WRONG ABOUT THAT. It called this "the second
 * of the two independent checks" while checking only the three Twilio credentials
 * — a DIFFERENT condition — so the flag had exactly one enforcement point, in
 * `./index.ts`. Two things followed, both reproduced as failing tests:
 *
 *   * `new TwilioVerifyProvider().start(...)` sent a real SMS with the flag unset.
 *     Not hypothetical: the credentials are already present in every deployment
 *     that sends SMS, and that revision exported this class.
 *   * a provider obtained from the resolver BEFORE the flag was unset went on
 *     working, so "unset the flag" did not disarm a held instance and the
 *     documented rollback was wrong.
 *
 * Now the predicate is `./arming.ts`, one definition read by both, and this is
 * genuinely the second independent enforcement point: the resolver refuses to hand
 * the adapter out, and the adapter refuses to act. Either alone is sufficient.
 *
 * Returning null is a real outcome, not a defensive flourish: both operations turn
 * it into `unavailable` WITHOUT performing a request.
 */
function readConfig(): Config | null {
  // FIRST, AND ON EVERY CALL, so there is no cached answer for the resolver and
  // this file to disagree about. Rollback still requires a redeploy; see ./arming.ts.
  if (!liveMobileVerificationArmed()) return null;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!accountSid || !authToken || !serviceSid) return null;
  return { accountSid, authToken, serviceSid };
}

type RawResponse = { status: number; json: unknown };

/**
 * One bounded POST. Returns the status and parsed body, or null for a transport
 * failure (timeout, abort, DNS, TLS, connection reset).
 *
 * NULL IS NOT "FAILED", IT IS "UNKNOWN", and the distinction is the whole reason
 * both callers map it to `unavailable` rather than to a refusal. A timed-out
 * check may have been approved on Twilio's side; reporting it as `rejected` would
 * tell a person their code was wrong about a proof that may well have succeeded.
 */
async function post(
  config: Config,
  path: string,
  form: URLSearchParams,
): Promise<RawResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${VERIFY_BASE}/Services/${config.serviceSid}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${config.accountSid}:${config.authToken}`,
        ).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // Non-JSON body. Left null; both callers fail closed on the shape check.
    }
    return { status: res.status, json };
  } catch {
    // Deliberately not distinguishing a timeout from a network error. Both are
    // "we do not know what happened", both are retryable, and neither may be
    // reported as a statement about the person's code.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** The provider's `status` string, or null when the body is not the shape we expect. */
function statusOf(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const raw = (json as { status?: unknown }).status;
  return typeof raw === "string" ? raw : null;
}

/** The provider's numeric error code, or null. */
function errorCodeOf(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const raw = (json as { code?: unknown }).code;
  return typeof raw === "number" ? raw : null;
}

/**
 * Twilio Verify error codes this adapter recognises.
 *
 * THESE ARE REFINEMENTS, NOT THE MAPPING. Every branch below decides first on
 * the HTTP status class, which is the part that cannot be wrong, and consults a
 * code only to move an outcome WITHIN a safe default. So if one of these numbers
 * is ever wrong or retired, the result is a coarser answer — never a promotion,
 * never a false statement about someone's code, never a retry loop.
 *
 * THE TWO OPERATIONS DO NOT SHARE A SET, AND THEY MUST NOT BE REUNIFIED. One
 * shared `RATE_LIMIT_CODES` was this file's first revision and it put 60202 —
 * "max CHECK attempts reached for this verification" — into `rate_limited` on the
 * check path. That was wrong twice over, and the second way is the one that
 * matters:
 *
 *   1. IT GAVE FALSE RETRY ADVICE. A verification whose attempts are exhausted is
 *      terminal; `rate_limited` invites a caller to wait and try the same code
 *      again, which will never work.
 *   2. IT REOPENED THE MEMBERSHIP ORACLE. `./types.ts` collapses "wrong, expired,
 *      already-consumed, too many attempts" into ONE value precisely so a surface
 *      cannot tell an anonymous caller which happened -- because learning that a
 *      code EXISTED to be exhausted is learning that the number is on a waitlist.
 *      A distinct `rate_limited` on the check path handed that distinction back.
 *
 * So `rate_limited` on CHECK means only what the contract says it means: too many
 * checks in the current WINDOW. Exhausting one verification's attempts is
 * `rejected`, alongside wrong and expired, where the contract puts it.
 *
 * THE HTTP STATUS EACH ONE ARRIVES WITH IS NOT UNIFORM, which is why the code is
 * consulted before the status class. 60202 arrives with a 429, so a branch keyed on
 * 429 shadows it; that was the P2 at 7e5f78e1.
 *
 *   20429  too many requests (a genuine window limit, on either operation)
 *   60202  max CHECK attempts reached, WITH HTTP 429 -> the verification is dead,
 *          so `rejected` -- and the status class must not get to answer first
 *   60203  max SEND attempts reached for this destination -> `rate_limited` on
 *          start, which is exactly "too many challenges in the current window"
 *   60212  too many concurrent requests for this destination -> `rate_limited`
 */
const START_RATE_LIMIT_CODES = new Set<number>([20429, 60203, 60212]);
const CHECK_RATE_LIMIT_CODES = new Set<number>([20429, 60212]);
/** Terminal for this verification, so it is a statement about the code. */
const CHECK_REJECTION_CODES = new Set<number>([60202]);

export class TwilioVerifyProvider implements MobileVerificationProvider {
  async start(destination: VerificationDestination): Promise<VerificationStartOutcome> {
    const config = readConfig();
    if (!config) return "unavailable";

    const form = new URLSearchParams();
    form.set("To", destination.e164);
    form.set("Channel", CHANNEL);

    const res = await post(config, "/Verifications", form);
    if (!res) return "unavailable";

    if (res.status === 201 || res.status === 200) {
      // A started verification is `pending` — it is waiting for the person. Any
      // other status on a 2xx here means this adapter and Verify disagree about
      // the contract, which is an outage and not a refusal to report.
      //
      // `approved` IS EXPLICITLY NOT ACCEPTED ON START. A start that reported an
      // approval would be a possession proof nobody proved, and it is the one
      // response shape that must never be trusted from this endpoint.
      return statusOf(res.json) === "pending" ? "started" : "unavailable";
    }

    // Code before status class, for the reason `check` below spells out: several
    // Verify limit codes arrive with a 429 and several with a 400, so keying on the
    // status class first makes the outcome depend on which one Twilio chose.
    const code = errorCodeOf(res.json);
    if (code !== null && START_RATE_LIMIT_CODES.has(code)) return "rate_limited";

    if (res.status === 429) return "rate_limited";
    if (res.status === 401 || res.status === 403) {
      // Bad or unauthorized credentials. Not the person's fault and not a
      // statement about their number, so it must not surface as a refusal.
      return "unavailable";
    }
    if (res.status >= 500) return "unavailable";

    if (res.status >= 400) {
      // A 4xx that is not a rate limit means Verify will not start a challenge
      // for this destination — an unroutable number, a landline, a parameter it
      // rejects. `refused` is the honest answer and it invites no retry.
      return "refused";
    }

    return "unavailable";
  }

  async check(
    destination: VerificationDestination,
    code: string,
  ): Promise<VerificationCheckOutcome> {
    const config = readConfig();
    if (!config) return "unavailable";

    const form = new URLSearchParams();
    form.set("To", destination.e164);
    form.set("Code", code);

    const res = await post(config, "/VerificationCheck", form);
    if (!res) return "unavailable";

    if (res.status === 200) {
      switch (statusOf(res.json)) {
        case "approved":
          // THE ONLY VALUE IN THIS FILE THAT CAN LEAD TO A PROMOTION.
          return "approved";
        case "pending":
          // The verification is still open, so the code submitted was not the
          // right one. This is the ordinary wrong-code case.
          return "rejected";
        case "canceled":
          return "rejected";
        default:
          // Includes a body with no `status` at all. An unrecognised 200 is a
          // contract disagreement, which is an outage — never `rejected`.
          return "unavailable";
      }
    }

    if (res.status === 404) {
      // NO PENDING VERIFICATION FOR THIS DESTINATION: it expired, or it was
      // already consumed, or none was ever started.
      //
      // THIS COLLAPSES INTO `rejected` ON PURPOSE, and it is the one mapping in
      // this file chosen for a privacy reason rather than a truth reason.
      // `./types.ts` requires it: telling an anonymous caller that a code was
      // "expired rather than wrong" tells them the code EXISTED, which tells them
      // the number is on a waitlist. Verify deletes a verification on expiry, so
      // `expired` has no status of its own to report even if we wanted to.
      return "rejected";
    }

    // THE ERROR CODE IS CONSULTED BEFORE ANY STATUS CLASS, AND THAT ORDER IS THE
    // WHOLE FIX. The previous revision put this table inside the `>= 400` arm,
    // below an `if (res.status === 429) return "rate_limited"` — and Twilio reports
    // 60202 WITH HTTP 429. So the generic branch answered first and the real
    // exhausted-attempt response still returned `rate_limited`, which is exactly
    // the defect that revision set out to remove. It looked fixed only because the
    // test modelled 60202 as a 400, which is the status that made the fix appear to
    // work. A status class is a coarse fact about a response; the error code is the
    // specific one, so the specific fact decides first.
    // NAMED `errorCode`, NOT `code`: this function's own parameter is the person's
    // one-time code, and two things called `code` in one body is how the wrong one
    // gets passed somewhere.
    const errorCode = errorCodeOf(res.json);
    // Terminal before window, so an exhausted verification can never be reported as
    // retryable whichever set a future code lands in.
    if (errorCode !== null && CHECK_REJECTION_CODES.has(errorCode)) return "rejected";
    if (errorCode !== null && CHECK_RATE_LIMIT_CODES.has(errorCode)) return "rate_limited";

    if (res.status === 429) return "rate_limited";
    if (res.status === 401 || res.status === 403) return "unavailable";
    if (res.status >= 500) return "unavailable";

    if (res.status >= 400) {
      // AND HERE `check` DIVERGES FROM `start`, DELIBERATELY. A 4xx on start is
      // Verify refusing a destination, which is a real refusal. A 4xx on CHECK
      // is a malformed request — our bug, not a judgement on the person's code —
      // so it is an outage. `rejected` is a statement about what the person
      // typed, and only a 200/pending, a 200/canceled or the 404 above earns it.
      return "unavailable";
    }

    return "unavailable";
  }
}
