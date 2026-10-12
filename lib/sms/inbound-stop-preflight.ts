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
// ONE BASE. The routes verify against TWILIO_WEBHOOK_BASE_URL, and that is the
// authority. Sender adoption (#863) compares a service's webhooks against the
// APP origin (NEXT_PUBLIC_APP_ORIGIN, else VERCEL_URL). If the two differ, a
// service can pass adoption with an inbound URL every STOP is refused on, so
// their agreement is a check of its own.
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
    inboundRequestUrl?: string | null;
    inboundMethod?: string | null;
    /** Twilio: when true, inbound goes to the NUMBER's webhook, not the service's. */
    useInboundWebhookOnNumber?: boolean | null;
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
  checks.push(
    svc?.inboundRequestUrl === undefined
      ? check("service_inbound_url", "unknown", "studio service inbound_request_url not read")
      : expected.ok && svc.inboundRequestUrl === expected.url
        ? check("service_inbound_url", "pass", "studio service posts inbound to the expected URL")
        : check("service_inbound_url", "fail", "studio service inbound_request_url is not exactly the expected URL"),
  );
  checks.push(
    svc?.inboundMethod === undefined
      ? check("service_inbound_method", "unknown", "studio service inbound method not read")
      : svc.inboundMethod?.toUpperCase() === "POST"
        ? check("service_inbound_method", "pass", "inbound method POST")
        : check("service_inbound_method", "fail", "inbound method is not POST: the route only accepts POST"),
  );
  checks.push(
    svc?.useInboundWebhookOnNumber === undefined || svc.useInboundWebhookOnNumber === null
      ? check("service_owns_inbound", "unknown", "use_inbound_webhook_on_number not read")
      : svc.useInboundWebhookOnNumber
        ? check("service_owns_inbound", "fail", "inbound goes to the NUMBER's webhook, bypassing the service's")
        : check("service_owns_inbound", "pass", "inbound handled by the service's webhook"),
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

  // The origin adoption checks webhooks against, as getRequiredAppOrigin
  // derives it, must be the base the routes verify against.
  const appOriginRaw = f.env.NEXT_PUBLIC_APP_ORIGIN ?? (f.env.VERCEL_URL ? `https://${f.env.VERCEL_URL}` : undefined);
  let appOrigin: string | null = null;
  try {
    appOrigin = appOriginRaw ? new URL(appOriginRaw).origin : null;
  } catch {
    appOrigin = null;
  }
  checks.push(
    appOriginRaw === undefined || f.env.TWILIO_WEBHOOK_BASE_URL === undefined
      ? check("one_base", "unknown", "app origin (adoption's base) and TWILIO_WEBHOOK_BASE_URL (the routes' base) not both observed")
      : expected.ok && appOrigin !== null && `${appOrigin}${INBOUND_STOP_PATH}` === expected.url
        ? check("one_base", "pass", "adoption and the routes use the same base")
        : check("one_base", "fail", "adoption's app origin differs from TWILIO_WEBHOOK_BASE_URL: a service can pass adoption yet have every STOP refused"),
  );

  const blockers = checks.filter((c) => c.status !== "pass").map((c) => c.id);
  return { ready: blockers.length === 0, checks, blockers };
}
