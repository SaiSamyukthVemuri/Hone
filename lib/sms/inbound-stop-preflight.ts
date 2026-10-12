import { effectiveInbound, inboundReaches } from "./inbound-routing";
import { twilioWebhookUrl } from "./webhook-base";

// ===========================================================================
// WILLOW-STOP-PREFLIGHT-01 (#824): will a STOP sent to a STUDIO's number reach
// Hone, authenticate, and opt the person out everywhere?
// ===========================================================================
//
// Per-studio routing (draft #858) sends from the studio's own Twilio
// Messaging Service. A client replying STOP to that number reaches Hone only
// if the SERVICE forwards inbound messages to Hone's inbound route, signed in
// a way the route accepts. If not, the route answers 403, writes nothing, and
// the person stays subscribed: STOP silently fails. This module decides, from
// facts an operator gathers read-only, whether that path is proven. It reads
// nothing, configures nothing, sends nothing.
//
// HOW THE ROUTE AUTHENTICATES (app/api/twilio/inbound-sms/route.ts):
//   * No TWILIO_AUTH_TOKEN: 500, nothing written.
//   * No X-Twilio-Signature: 403, nothing written.
//   * Signed URL = TWILIO_WEBHOOK_BASE_URL + request pathname + search (or
//     request.url when the base is unset, which on Vercel can be an internal
//     hostname Twilio never signed). HMAC-SHA1 with TWILIO_AUTH_TOKEN over that
//     URL plus the sorted form fields. Mismatch: 403, nothing written.
//   * Body fields (MessagingServiceSid, AccountSid, To) are NOT authority: only
//     the signature is. STOP is phone-wide: it never resolves a studio, so the
//     0191 service->studio mapping is not on the STOP path at all.
// So the studio service must POST to EXACTLY expectedInboundWebhookUrl(env),
// and Twilio must sign with the account whose token Hone holds.
//
// ONE BASE (#863, lib/sms/webhook-base.ts). The routes verify against
// canonicalTwilioSignedUrl and the sender controls configure and require
// twilioWebhookUrl, both from TWILIO_WEBHOOK_BASE_URL. `one_base` checks the
// URL the controls would configure IS the URL the route verifies; with the
// base unset the controls fall back to the app origin while the route falls
// back to the request URL (on Vercel possibly internal), so it fails.
//
// WHERE INBOUND GOES (#863, lib/sms/inbound-routing.ts): the SMS lane's
// effectiveInbound / inboundReaches decide, so this preflight and sender
// adoption cannot disagree: the number's own sms_url when
// use_inbound_webhook_on_number is on, else the service's inbound_request_url;
// null inbound URL with the flag off means inbound is DISABLED; anything not
// reported is unknown.
//
// Every fact is pass, fail or UNKNOWN, and UNKNOWN is a cutover blocker:
// a STOP path that has not been shown to work is treated as not working.
// ===========================================================================

export const INBOUND_STOP_PATH = "/api/twilio/inbound-sms";

type Env = Readonly<Record<string, string | undefined>>;

export type ExpectedInboundUrl =
  | { ok: true; url: string }
  | { ok: false; reason: "base_unset" | "base_not_https" | "base_has_path_query_or_fragment" | "base_unparseable" };

/**
 * The one URL a studio service's inbound webhook may name. Built from
 * TWILIO_WEBHOOK_BASE_URL exactly as the route rebuilds the signed URL. The
 * base must be a bare https origin: a path in it would be counted twice by the
 * route (base + full request pathname), and a query or fragment would change
 * what Twilio signs.
 */
export function expectedInboundWebhookUrl(env: Env = process.env): ExpectedInboundUrl {
  const raw = env.TWILIO_WEBHOOK_BASE_URL;
  if (!raw || raw.trim() === "") return { ok: false, reason: "base_unset" };
  const base = raw.replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return { ok: false, reason: "base_unparseable" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "base_not_https" };
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "" || u.username || u.password) {
    return { ok: false, reason: "base_has_path_query_or_fragment" };
  }
  return { ok: true, url: `${u.origin}${INBOUND_STOP_PATH}` };
}

/** One observed fact; `undefined` means it was not (or could not be) read. */
export type InboundStopFacts = {
  /** The Hone deployment's env (presence and the base URL's value). */
  env: Env;
  /**
   * Indirect proof that the base URL and auth token validate REAL Twilio
   * signatures in this deployment: ledger rows whose provider_status_at was
   * stamped by the signature-verified /api/twilio/message-status route, in a
   * recent window. Built from the same base and token as the inbound route.
   */
  recentSignatureVerifiedCallbacks?: number;
  /** GET on the expected URL from outside: 405 = the POST route, no redirect. */
  endpointProbe?: { status: number; redirectedTo: string | null };
  /** The studio's service, read-only (provider.readMessagingServiceConfig and console). */
  service?: {
    /** MessagingServiceConfig.inboundRequestUrl; undefined = not read. */
    inboundRequestUrl?: string | null;
    /** MessagingServiceConfig.useInboundWebhookOnNumber; null = not reported (UNKNOWN). */
    useInboundWebhookOnNumber?: boolean | null;
    /** OwnedNumberFacts.numberSmsUrl; undefined = not reported, null = none. */
    numberSmsUrl?: string | null;
    /** The service's inbound_method (when the service routes inbound). */
    inboundMethod?: string | null;
    /** The number's sms_method (when the number routes inbound). */
    numberSmsMethod?: string | null;
    /** The account that owns the service; must be the account of TWILIO_AUTH_TOKEN. */
    accountSid?: string | null;
  };
  /** The account TWILIO_AUTH_TOKEN belongs to (TWILIO_ACCOUNT_SID), as confirmed by the operator. */
  honeAccountSid?: string | null;
  /** resolve_studio_by_sms_messaging_service(service) — must be the studio being cut over. */
  mappedStudioId?: string | null;
  expectedStudioId?: string | null;
  /**
   * Whether the service forwards STOP-family keywords to the inbound webhook
   * (Twilio opt-out handling). Only observable on a live STOP; undefined until
   * the approved first live verification.
   */
  stopForwardedToWebhook?: boolean;
};

export type CheckStatus = "pass" | "fail" | "unknown";
export type PreflightCheck = { id: string; status: CheckStatus; detail: string };
export type PreflightResult = { ready: boolean; checks: PreflightCheck[]; blockers: string[] };

const check = (id: string, status: CheckStatus, detail: string): PreflightCheck => ({ id, status, detail });

export function evaluateInboundStopPreflight(f: InboundStopFacts): PreflightResult {
  const checks: PreflightCheck[] = [];
  const expected = expectedInboundWebhookUrl(f.env);

  checks.push(
    expected.ok
      ? check("base_url", "pass", `inbound URL is ${expected.url}`)
      : check("base_url", f.env.TWILIO_WEBHOOK_BASE_URL === undefined ? "unknown" : "fail", `TWILIO_WEBHOOK_BASE_URL: ${expected.reason}`),
  );

  checks.push(
    f.env.TWILIO_AUTH_TOKEN === undefined
      ? check("auth_token", "unknown", "TWILIO_AUTH_TOKEN presence not observed")
      : f.env.TWILIO_AUTH_TOKEN.trim() === ""
        ? check("auth_token", "fail", "TWILIO_AUTH_TOKEN is empty: the route answers 500 to every STOP")
        : check("auth_token", "pass", "TWILIO_AUTH_TOKEN present"),
  );

  checks.push(
    f.recentSignatureVerifiedCallbacks === undefined
      ? check("signing_proven", "unknown", "no evidence that this deployment's base URL and token validate real Twilio signatures")
      : f.recentSignatureVerifiedCallbacks > 0
        ? check("signing_proven", "pass", `${f.recentSignatureVerifiedCallbacks} recent signature-verified delivery callbacks on the same base and token`)
        : check("signing_proven", "unknown", "no recent signature-verified callbacks to prove the base URL and token"),
  );

  checks.push(
    !f.endpointProbe
      ? check("endpoint_reachable", "unknown", "expected URL not probed")
      : f.endpointProbe.redirectedTo
        ? check("endpoint_reachable", "fail", `expected URL redirects (${f.endpointProbe.status}): Twilio would sign one URL and land on another`)
        : f.endpointProbe.status === 405
          ? check("endpoint_reachable", "pass", "expected URL serves the POST-only route (GET 405), no redirect")
          : check("endpoint_reachable", "fail", `expected URL answered GET ${f.endpointProbe.status}, not the route's 405`),
  );

  const svc = f.service;
  // The service URL is needed only when the number does NOT override it: with
  // use_inbound_webhook_on_number on, effectiveInbound never reads it.
  const routing =
    svc && (svc.inboundRequestUrl !== undefined || svc.useInboundWebhookOnNumber === true)
      ? {
          serviceInboundUrl: svc.inboundRequestUrl ?? null,
          useInboundWebhookOnNumber: svc.useInboundWebhookOnNumber ?? null,
          numberSmsUrl: svc.numberSmsUrl,
        }
      : null;
  const effective = routing ? effectiveInbound(routing) : null;
  const reaches = routing && expected.ok ? inboundReaches(routing, expected.url) : routing ? "no" : "unknown";
  checks.push(
    reaches === "yes"
      ? check("inbound_reaches", "pass", `inbound (${effective?.kind}) posts to the expected URL`)
      : reaches === "unknown"
        ? check(
            "inbound_reaches",
            "unknown",
            effective?.kind === "unknown" ? `not reported: ${effective.missing}` : "studio service inbound routing not read",
          )
        : check(
            "inbound_reaches",
            "fail",
            effective?.kind === "disabled"
              ? "inbound is DISABLED on the service (no inbound_request_url): every STOP is lost"
              : effective?.kind === "number_url_missing"
                ? "use_inbound_webhook_on_number is on but the number has no sms_url"
                : "effective inbound URL is not exactly the expected URL",
          ),
  );

  const method =
    effective?.kind === "service" ? svc?.inboundMethod : effective?.kind === "number" ? svc?.numberSmsMethod : undefined;
  checks.push(
    method === undefined || method === null
      ? check("inbound_method", "unknown", "method of the effective inbound route not read")
      : method.toUpperCase() === "POST"
        ? check("inbound_method", "pass", "inbound method POST")
        : check("inbound_method", "fail", "inbound method is not POST: the route only accepts POST"),
  );
  checks.push(
    !svc?.accountSid || !f.honeAccountSid
      ? check("signing_account", "unknown", "service account or Hone account not confirmed")
      : svc.accountSid === f.honeAccountSid
        ? check("signing_account", "pass", "service is in the account whose token Hone validates with")
        : check("signing_account", "fail", "service is in another (sub)account: its requests are signed with a token Hone does not hold"),
  );

  checks.push(
    f.mappedStudioId === undefined || !f.expectedStudioId
      ? check("studio_mapping", "unknown", "service->studio mapping not read")
      : f.mappedStudioId === f.expectedStudioId
        ? check("studio_mapping", "pass", "the service maps to exactly the studio being cut over")
        : check("studio_mapping", "fail", "the service maps to another studio, or to none"),
  );

  checks.push(
    f.stopForwardedToWebhook === undefined
      ? check("stop_forwarded", "unknown", "STOP forwarding by the service's opt-out handling not yet observed (first approved live verification)")
      : f.stopForwardedToWebhook
        ? check("stop_forwarded", "pass", "a live STOP to the studio number reached the route and stamped phone-wide")
        : check("stop_forwarded", "fail", "the service consumed STOP without forwarding it to Hone"),
  );

  // The URL #863's sender controls would configure and require, from the same
  // app origin getRequiredAppOrigin derives, must be the URL the route verifies.
  const appOriginRaw = f.env.NEXT_PUBLIC_APP_ORIGIN || (f.env.VERCEL_URL ? `https://${f.env.VERCEL_URL}` : undefined);
  const configured = twilioWebhookUrl(INBOUND_STOP_PATH, appOriginRaw ?? null, f.env);
  checks.push(
    f.env.TWILIO_WEBHOOK_BASE_URL === undefined
      ? check("one_base", "unknown", "TWILIO_WEBHOOK_BASE_URL not observed: the controls would fall back to the app origin, the route to the request URL")
      : expected.ok && configured === expected.url
        ? check("one_base", "pass", "the URL the sender controls configure is the URL the route verifies")
        : check("one_base", "fail", "the URL the sender controls would configure differs from the URL the route verifies"),
  );

  const blockers = checks.filter((c) => c.status !== "pass").map((c) => c.id);
  return { ready: blockers.length === 0, checks, blockers };
}
