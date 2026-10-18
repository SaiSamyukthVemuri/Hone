import { effectiveInbound, inboundReaches } from "./inbound-routing";
import { configuredTwilioWebhookBase, normalizeTwilioWebhookUrl, twilioWebhookUrl } from "./webhook-base";

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

/**
 * Twilio connection overrides live in the URL FRAGMENT, which Twilio omits from
 * the HTTP request AND from the signature. Parsing and validating them is the
 * SMS lane's ONE strict normalizer (lib/sms/webhook-base.ts,
 * normalizeTwilioWebhookUrl, #863), shared with inboundReaches and adoption so
 * this preflight and adoption cannot disagree about which URL is which.
 */

/**
 * Twilio's documented webhook connection defaults (Webhook connection
 * overrides, checked 2026-10-13): ct 5000 ms, rt 15000 ms, tt 15000 ms, rc 1,
 * rp ct. ASSUMPTION (recorded in the handoff): a Setting that omits
 * totalTimeoutMs gets the same 15000 ms total, and one that omits
 * `connection` the same ct/rt; the Settings docs say only that Twilio
 * "applies defaults".
 */
const TWILIO_DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const TWILIO_DEFAULT_READ_TIMEOUT_MS = 15000;
const TWILIO_DEFAULT_TOTAL_TIME_MS = 15000;

/** Marker substituted for a URL the shared normalizer rejects. */
const INVALID_FRAGMENT = "invalid-fragment:";

/**
 * The delivery failures a STOP must survive (Codex P1 4264761390):
 *   connect      TCP connect or TLS handshake failure   (rp ct / CONNECTION_TIMEOUT)
 *   read_timeout no response within the read timeout    (rp rt / READ_TIMEOUT)
 *   server_error the route answered 5xx (a failed scan or write)  (rp 5xx / HTTP_5XX)
 *   client_error the route answered 4xx for a TRANSIENT failure: it returns
 *                400 when reading the request body throws, before any
 *                suppression (app/api/twilio/inbound-sms/route.ts; Codex P1
 *                4270801222)                                    (rp 4xx / HTTP_4XX)
 * `all` / `ALL` names all four. Twilio does NOT retry a partial response
 * (connection-overrides docs), so nothing here claims to recover one. The
 * route's own status codes are not changed here (that would alter live STOP
 * handling); the preflight demands the policy that survives them.
 */
type DeliveryFailure = "connect" | "read_timeout" | "server_error" | "client_error";
const DELIVERY_FAILURES: readonly DeliveryFailure[] = ["connect", "read_timeout", "server_error", "client_error"];
const URL_POLICY: Record<string, DeliveryFailure[]> = {
  ct: ["connect"],
  rt: ["read_timeout"],
  "5xx": ["server_error"],
  "4xx": ["client_error"],
  all: [...DELIVERY_FAILURES],
};
const SETTING_POLICY: Record<string, DeliveryFailure[]> = {
  CONNECTION_TIMEOUT: ["connect"],
  READ_TIMEOUT: ["read_timeout"],
  HTTP_5XX: ["server_error"],
  HTTP_4XX: ["client_error"],
  ALL: [...DELIVERY_FAILURES],
};

/**
 * Do retries recover EVERY delivery failure? All four classes (connect,
 * read_timeout, server_error, client_error) must be named, at least
 * one retry allowed, and the total budget must hold a worst-case first attempt
 * (connect + read timeout) AND one full retry: tt >= 2 * (ct + rt). A smaller
 * budget can expire before the retry starts or finishes, which configuration
 * cannot rule out, so it is not certified.
 */
function retriesRecoverEveryFailure(r: { named: readonly DeliveryFailure[]; count: number; ct: number; rt: number; tt: number }): boolean {
  return r.count >= 1 && DELIVERY_FAILURES.every((x) => r.named.includes(x)) && r.tt >= 2 * (r.ct + r.rt);
}

/**
 * Under a URL's own connection overrides (no Webhook Rule matches), do
 * Twilio's retries recover every delivery failure? Naming `rp` REPLACES the
 * default `ct`, so `#rp=5xx` alone leaves connect failures, read timeouts and
 * the route's transient 4xx unretried. No fragment means the defaults (ct only, budget 15000 < 40000):
 * no. An invalid fragment: no.
 *
 * SNI (Codex P1 4265363596): `sni=n` disables SNI on HTTPS connects; a
 * virtual-hosted endpoint then fails EVERY attempt at the TLS handshake, so
 * no retry count helps. Not certified (nothing here proves the endpoint works
 * without SNI).
 *
 * EDGES (Codex P2s 4265363603, 4266813200): retries move through the `e=`
 * list, so fewer than two edges give no alternate origin when that edge
 * fails. An omitted `e` is the documented single default edge (`ashburn`).
 * Not certified without two or more explicit edges (handoff A7). The edge
 * list counts only with Static Proxy off (the evaluator passes the account
 * fact; standalone callers get "off").
 */
export function retriesRecoverDelivery(url: string | null | undefined, staticProxyEnabled: boolean | null = false): boolean {
  if (urlTransport(url, "none", { staticProxyEnabled }) !== "ok") return false;
  const n = normalizeTwilioWebhookUrl(url);
  if (!n.ok) return false;
  const o = n.overrides ?? {};
  return retriesRecoverEveryFailure({
    named: (o.rp ?? ["ct"]).flatMap((t) => URL_POLICY[t] ?? []),
    count: o.rc ?? 1,
    ct: o.ct ?? TWILIO_DEFAULT_CONNECT_TIMEOUT_MS,
    rt: o.rt ?? TWILIO_DEFAULT_READ_TIMEOUT_MS,
    tt: o.tt ?? TWILIO_DEFAULT_TOTAL_TIME_MS,
  });
}

/**
 * THE ONE TRANSPORT VALIDATOR for a webhook URL Twilio requests, primary or
 * fallback (Codex P1s 4265363596, 4265522953; P2 4265363603). Under the
 * account's Webhook Rules (`rules`):
 *   "none"    no Rule matches, so the URL's overrides apply: `sni=n` (every
 *             TLS handshake to this virtual-hosted endpoint fails) is UNSAFE,
 *             and so is any edge list of fewer than two (no alternate
 *             origin). An OMITTED `e` is Twilio's documented single default
 *             edge, `ashburn` (Codex P2 4266813200): one edge, so UNSAFE;
 *   "matched" the Setting decides edges (webhook_zones judges them), so `e=`
 *             is ignored; Settings have no SNI field, so whether a URL
 *             `sni=n` still applies is undocumented: UNKNOWN (handoff A8);
 *   "unknown" the Rules are unread, so `sni=n` or a one-edge `e=` is UNKNOWN.
 * An unparseable URL or fragment is unsafe. An omitted sni is Twilio's
 * default (SNI on) and fine.
 */
type Transport = "ok" | "unsafe" | "unknown";
const worst = (...ts: Transport[]): Transport => (ts.includes("unsafe") ? "unsafe" : ts.includes("unknown") ? "unknown" : "ok");

/** The account facts the transport validator needs besides the URL. */
type TransportContext = {
  /**
   * Static Proxy on the account (Codex P2 4267597875): Twilio IGNORES `e=`
   * when it is enabled, so an edge list proves no alternate origin. Undefined
   * or null = not read.
   */
  staticProxyEnabled?: boolean | null;
};

function urlTransport(url: string | null | undefined, rules: "none" | "matched" | "unknown", ctx: TransportContext = {}): Transport {
  const n = normalizeTwilioWebhookUrl(url);
  if (!n.ok) return "unsafe";
  const o = n.overrides ?? {};
  const bad: Transport = rules === "none" ? "unsafe" : "unknown";
  const sni: Transport = o.sni === "n" ? (rules === "none" ? "unsafe" : "unknown") : "ok";
  // Edges: under a matching Rule the Setting's edgeZones govern. Otherwise an
  // omitted e is the single default edge (ashburn), and an edge list counts
  // only once Static Proxy is known to be off. Twilio moves to the next edge
  // only ON A RETRY (Codex P1 4268714206), so the list counts only when a
  // connect/TLS failure at the first edge is retried: rc >= 1, a policy
  // naming ct (or all; the default is ct), and a total that holds the failed
  // connect plus one whole attempt, tt >= 2 * ct + rt.
  const ct = o.ct ?? TWILIO_DEFAULT_CONNECT_TIMEOUT_MS;
  const rt = o.rt ?? TWILIO_DEFAULT_READ_TIMEOUT_MS;
  const tt = o.tt ?? TWILIO_DEFAULT_TOTAL_TIME_MS;
  const failsOverEdges =
    (o.rc ?? 1) >= 1 && (o.rp ?? ["ct"]).flatMap((t) => URL_POLICY[t] ?? []).includes("connect") && tt >= 2 * ct + rt;
  const edges: Transport =
    rules === "matched"
      ? "ok"
      : (o.e?.length ?? 1) < 2 || !failsOverEdges
        ? bad
        : ctx.staticProxyEnabled === false
          ? "ok"
          : "unknown";
  return worst(sni, edges);
}

/**
 * The URL Twilio actually requests and signs: the configured URL without its
 * fragment of documented connection overrides (shared normalizer). A URL the
 * normalizer rejects (an invalid or empty fragment) never matches the expected
 * one.
 */
export function signedFormOfConfiguredUrl<T extends string | null | undefined>(url: T): T | string {
  if (typeof url !== "string") return url;
  const n = normalizeTwilioWebhookUrl(url);
  return n.ok ? n.url : `${INVALID_FRAGMENT}${url}`;
}

type Env = Readonly<Record<string, string | undefined>>;

export type ExpectedInboundUrl =
  | { ok: true; url: string }
  | { ok: false; reason: "base_unset" | "base_not_https" | "base_has_path_query_or_fragment" | "base_unparseable" };

/**
 * The one URL a studio service's inbound webhook may name. Built from
 * TWILIO_WEBHOOK_BASE_URL exactly as the route rebuilds the signed URL. The
 * base must be a bare https origin: a path in it would be counted twice by the
 * route (base + full request pathname), and a query or fragment would change
 * what Twilio signs. The URL is the RAW base plus the path, exactly as
 * canonicalTwilioSignedUrl builds it (Codex P2 4251745257): URL.origin would
 * drop an explicit :443 or lowercase the host, naming a URL the route never
 * verifies against.
 */
export function expectedInboundWebhookUrl(env: Env = process.env): ExpectedInboundUrl {
  const raw = env.TWILIO_WEBHOOK_BASE_URL;
  if (!raw || raw.trim() === "") return { ok: false, reason: "base_unset" };
  const base = configuredTwilioWebhookBase(env) ?? "";
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return { ok: false, reason: "base_unparseable" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "base_not_https" };
  // The RAW base too (Codex P2 4267597865): an empty "?" or "#" parses to an
  // empty search/hash, yet the route path appended after it would be query or
  // fragment text, never the pathname.
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "" || u.username || u.password || /[?#]/.test(base)) {
    return { ok: false, reason: "base_has_path_query_or_fragment" };
  }
  return { ok: true, url: `${base}${INBOUND_STOP_PATH}` };
}

/** One observed fact; `undefined` means it was not (or could not be) read. */
export type InboundStopFacts = {
  /** The Hone deployment's env (presence and the base URL's value). */
  env: Env;
  /**
   * Indirect proof that the base URL and auth token validate REAL Twilio
   * signatures in this deployment: ledger rows whose provider_status_at was
   * stamped by the signature-verified /api/twilio/message-status route, which
   * is built from the same base and token as the inbound route. A callback
   * proves only the credentials it was verified with, so it counts only when
   * it postdates the CURRENT token and base (Codex P1 4251931839): a rotation
   * or base change since then leaves signing unproven. A null field = not read.
   */
  signatureProof?: {
    /** ISO time of the newest signature-verified callback. */
    lastVerifiedCallbackAt: string | null;
    /**
     * ISO time the current TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_BASE_URL both
     * became active on the production deployment (the later of the two env
     * changes and the deployment that picked them up).
     */
    credentialsActiveSince: string | null;
  };
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
    /** MessagingServiceConfig.inboundMethod; null/undefined = not reported. */
    inboundMethod?: string | null;
    /** OwnedNumberFacts.numberSmsMethod; null/undefined = not reported. */
    numberSmsMethod?: string | null;
    /** OwnedNumberFacts.numberSmsApplicationSid; undefined = not reported, null = none. */
    numberSmsApplicationSid?: string | null;
    /** The account that owns the service; must be the account of TWILIO_AUTH_TOKEN. */
    accountSid?: string | null;
    /**
     * The service's fallback_url and fallback_method, read-only: Twilio sends a
     * request there when the primary fails. A fallback that is exactly the
     * expected route, by POST, may redeliver a STOP the primary failed, if it
     * recovers its own failures (redelivers / recovers below).
     */
    fallbackUrl?: string | null;
    fallbackMethod?: string | null;
    /**
     * The NUMBER's own sms_fallback_url / sms_fallback_method. With
     * use_inbound_webhook_on_number on, Twilio uses the number's webhook AND
     * fallback instead of the service's (Services resource docs), so only these
     * count on that path (Codex P1 4254537025).
     */
    numberSmsFallbackUrl?: string | null;
    numberSmsFallbackMethod?: string | null;
    /** The number the numberSms* facts above were read from (E.164). */
    checkedNumber?: string | null;
    /**
     * Every number in the service's sender pool, with its own number-level
     * routing. Needed when use_inbound_webhook_on_number is on and outbound is
     * not pinned to checkedNumber: the service may send from any of them, and
     * a reply goes back to whichever did.
     */
    senderPool?: Array<{
      phoneNumber: string;
      smsUrl: string | null | undefined;
      smsMethod?: string | null;
      smsApplicationSid?: string | null;
      /** The member's own sms_fallback_url / sms_fallback_method (undefined = not read). */
      smsFallbackUrl?: string | null;
      smsFallbackMethod?: string | null;
    }>;
  };
  /**
   * The From that routed sends pin (draft #858 posts the checked sender's
   * phone_number as From beside the service). Undefined = not established.
   */
  routedFromNumber?: string | null;
  /**
   * The account's Webhook Rules for the expected URL (Webhooks configuration
   * API, read-only). A matching Rule's Setting TAKES PRECEDENCE over URL
   * connection overrides (Twilio's Webhooks configuration FAQ), may split
   * traffic between two Settings, and a Setting may SIGN with a SharedKey
   * instead of the account auth token, which the route cannot verify. Twilio
   * applies a default Rule to any otherwise-unmatched URL, so "no match" means
   * no exact, prefix or default Rule matches. Undefined = not read.
   */
  /**
   * Propagation of the Webhooks configuration (Codex P1 4259214614; the
   * Webhooks configuration FAQ, re-checked 2026-10-14, now says 30 TO 90 s):
   * a write is saved at once but takes up to 90 s to reach the delivery plane.
   * Rule writes return an Operation to poll until COMPLETED; Settings,
   * AuthProfiles and SharedKeys create none, so 90 s must pass. Until then a STOP may be signed or retried by the OLD configuration.
   */
  webhookPropagation?: {
    /**
     * The status of the LATEST Operation for each Rule matching (or formerly
     * matching) the URL: PENDING | RUNNING | COMPLETED | CANCELLED | FAILED
     * (Track webhook rule changes, checked 2026-10-13). [] = no Rule was
     * written. CANCELLED and FAILED are terminal: the change will never take
     * effect, so waiting cannot help (Codex P2 4259396130).
     */
    ruleOperationStatuses: readonly string[] | null;
    /** Seconds since the last Rule, Setting, AuthProfile or SharedKey change. */
    secondsSinceLastConfigChange: number | null;
  };
  webhookRules?:
    | { matched: false }
    | {
        matched: true;
        /**
         * The Rule's one or two Settings (Webhook Rules/Settings docs, checked
         * 2026-10-13). A null field = not reported. An omitted retryPolicy
         * means NO retries: pass retryOn [] and retryCount 0.
         */
        settings: Array<{
          /**
           * The Setting's type (Codex P2 4305024182; Webhooks configuration
           * FAQ): "SYSTEM" is Twilio's built-in Setting, the documented first
           * step of migrating an existing webhook, and it keeps reading
           * connection overrides from the webhook URL, so its share is judged
           * by the URL's own retries and transport. "CUSTOMER" uses this
           * Setting's retryPolicy and timeouts. Undefined/null = not read.
           */
          settingType?: "SYSTEM" | "CUSTOMER" | null;
          /** The Setting's share of matching traffic, 0-100; only non-zero shares are ever used. */
          percentage: number | null;
          /**
           * The EFFECTIVE auth scheme Twilio uses to authenticate itself to the
           * endpoint (Codex P1 4264160015; Settings and AuthProfiles docs,
           * checked 2026-10-13): auth.value.scheme for source INLINE, or the
           * referenced AuthProfile's type for source REFERENCE. OAUTH2 |
           * BASIC | DIGEST | NONE; null = not read (including an unread
           * AuthProfile). Never the credentials themselves.
           */
          authScheme: string | null;
          /** signature.type: "ACCOUNT_AUTH_TOKEN" | "SHARED_KEY" | "NONE". */
          signatureType: string | null;
          /** signature.algorithm: "HMAC_SHA1" | "HMAC_SHA256". */
          signatureAlgorithm: string | null;
          /** connection.retryPolicy.retryOn: HTTP_4XX, HTTP_5XX, CONNECTION_TIMEOUT, READ_TIMEOUT, ALL. */
          retryOn: string[] | null;
          /** connection.retryPolicy.retryCount, 0-5. */
          retryCount: number | null;
          /** connection.totalTimeoutMs (100-60000); undefined = omitted (assumed 15000). */
          totalTimeoutMs?: number | null;
          /** connection.connectTimeoutMs (100-10000); undefined = `connection` omitted (5000). */
          connectTimeoutMs?: number | null;
          /** connection.readTimeoutMs (100-15000); undefined = `connection` omitted (15000). */
          readTimeoutMs?: number | null;
          /**
           * The Setting's edgeZones (Codex P2 4264761398; Choose webhook edge
           * zones, checked 2026-10-13): "omitted" = observed absent, every zone
           * eligible; an object = the priority-ordered zone IDs, with
           * allowZoneFallback undefined when omitted (documented default
           * FALSE) and null when not read; null = the Setting's edgeZones not
           * read.
           */
          edgeZones: "omitted" | { zones: readonly string[]; allowZoneFallback?: boolean | null } | null;
        }>;
      };
  /**
   * Whether Static Proxy is enabled on the account (Console, read-only).
   * Twilio ignores the URL `e=` parameter under it, so with no Rule matching
   * an edge list is resilience proof only when this is false (Codex P2
   * 4267597875). Undefined or null = not read.
   */
  staticProxyEnabled?: boolean | null;
  /**
   * The current edge-zone catalog (GET /v1/Webhooks/EdgeZones): each zone's ID
   * and how many edge locations are active in it. Needed only to judge a
   * Setting that restricts zones without fallback. Undefined = not read.
   */
  edgeZoneCatalog?: ReadonlyArray<{ id: string; activeEdgeLocations: number }>;
  /** The account TWILIO_AUTH_TOKEN belongs to (TWILIO_ACCOUNT_SID), as confirmed by the operator. */
  honeAccountSid?: string | null;
  /** resolve_studio_by_sms_messaging_service(service) — must be the studio being cut over. */
  mappedStudioId?: string | null;
  expectedStudioId?: string | null;
  /**
   * The approved first live STOP to the studio number, as observed in Hone
   * (Codex P1 4251745248): forwarding alone proves nothing, the route must
   * also have ACCEPTED it (200, i.e. signature verified) and stamped the
   * phone-wide opt-out. Undefined until that verification; a null field =
   * not read.
   */
  liveStopObservation?: {
    /** A request for that STOP reached the inbound route at all. */
    reachedRoute: boolean | null;
    /** The route's response status for it. */
    routeStatus: number | null;
    /** The phone-wide opt-out was stamped for that phone by that STOP. */
    phoneWideOptOutStamped: boolean | null;
    /** ISO time of that STOP; undefined or null = not read. */
    observedAt?: string | null;
  };
  /**
   * The studio service's opt-out handling, read-only from the Console (Codex
   * P1 4266130958): Twilio forwards keyword messages (STOP and its family) to
   * the inbound webhook only when the service is NOT configured to drop them
   * (Advanced Opt-Out; Twilio help "How to Track Opt-Out, In and Help
   * Messages Using the OptOutType Parameter"). The live observation proves
   * only the configuration it ran under, so it counts only when it postdates
   * the last change to this configuration. A null field = not read.
   */
  /**
   * When the CURRENT inbound STOP handler and its database became active
   * (Codex P1 4273253239): the live STOP proves only the code and schema it
   * ran against. A later deployment or migration (a permission, schema or
   * handler regression) can make every STOP answer 500 before suppression, so
   * the observation counts only when it postdates BOTH. Read-only: the
   * production deployment serving /api/twilio/inbound-sms (Vercel, its
   * ready time) and the newest applied migration (its applied time). ISO
   * strings; null or undefined = not read.
   */
  currentActivation?: {
    handlerDeployedAt: string | null;
    databaseMigratedAt: string | null;
  };
  optOutConfiguration?: {
    /** The service drops opt-out keyword messages instead of forwarding them. */
    dropsKeywordMessages: boolean | null;
    /** ISO time of the last change to the service's opt-out configuration (its creation if never changed). */
    lastChangedAt: string | null;
  };
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

  const sp = f.signatureProof;
  const lastVerified = sp?.lastVerifiedCallbackAt ? Date.parse(sp.lastVerifiedCallbackAt) : NaN;
  const activeSince = sp?.credentialsActiveSince ? Date.parse(sp.credentialsActiveSince) : NaN;
  checks.push(
    sp === undefined
      ? check("signing_proven", "unknown", "no evidence that this deployment's base URL and token validate real Twilio signatures")
      : Number.isNaN(activeSince)
        ? check("signing_proven", "unknown", "when the current token and base became active is not read: a callback cannot be tied to them")
        : Number.isNaN(lastVerified)
          ? check("signing_proven", "unknown", "no signature-verified callback observed to prove the base URL and token")
          : lastVerified > activeSince
            ? check("signing_proven", "pass", "a signature-verified delivery callback arrived after the current token and base became active")
            : check("signing_proven", "unknown", "every signature-verified callback predates the current token or base: wait for one under the current credentials"),
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
          serviceInboundUrl: signedFormOfConfiguredUrl(svc.inboundRequestUrl ?? null),
          serviceInboundMethod: svc.inboundMethod ?? null,
          useInboundWebhookOnNumber: svc.useInboundWebhookOnNumber ?? null,
          numberSmsUrl: signedFormOfConfiguredUrl(svc.numberSmsUrl),
          numberSmsMethod: svc.numberSmsMethod,
          numberSmsApplicationSid: svc.numberSmsApplicationSid,
        }
      : null;
  const effective = routing ? effectiveInbound(routing) : null;
  const reaches = routing && expected.ok ? inboundReaches(routing, expected.url) : routing ? "no" : "unknown";
  checks.push(
    reaches === "yes"
      ? check("inbound_reaches", "pass", `inbound (${effective?.kind}) POSTs to the expected URL`)
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
                : effective?.kind === "application_override"
                  ? "a TwiML application on the number overrides its sms_* URLs: inbound never reaches Hone"
                  : (effective?.kind === "service" || effective?.kind === "number") && effective.method !== "POST"
                    ? `inbound method is ${effective.method}, not POST: the route only accepts POST`
                    : (effective?.kind === "service" || effective?.kind === "number") && effective.url.startsWith(INVALID_FRAGMENT)
                      ? "the inbound URL's fragment is not valid Twilio connection overrides (documented keys ct, rt, tt, rc, rp, sni, e with their documented values)"
                      : "effective inbound URL is not exactly the expected URL",
          ),
  );

  // The method is part of inboundReaches since #863 ed7334da: no separate check.

  // A STOP the route answers 500 must be redelivered (Codex P1 4254444665).
  // Evaluated only once inbound reaches the route, so a wrong URL is reported
  // once, by inbound_reaches.
  // ACCOUNT WEBHOOK RULES (Codex P1s 4254537039, 4254655904): a matching
  // Rule's Settings override URL connection overrides and decide signing. The
  // route verifies ONLY the account auth token with HMAC-SHA1, so every Setting
  // that can receive traffic (non-zero percentage, Codex P2 4254655911) must
  // be ACCOUNT_AUTH_TOKEN + HMAC_SHA1.
  // AUTHENTICATION (Codex P1 4264160015): every such Setting must also use auth
  // scheme NONE. The route authenticates Twilio only by that signature and has
  // no OAuth2, Basic or Digest support; with OAuth2, a failed token exchange
  // makes Twilio DROP matching webhooks for up to 300 s (error 97001), so a
  // STOP is lost while every signature and retry fact still reads correct.
  // Supporting OAuth2 would need its own design and proof.
  const rules = f.webhookRules;
  const allSettings = rules?.matched ? rules.settings : [];
  // A COMPLETE split (Codex P1 4274472921; Webhook Rules docs): one or two
  // Settings whose integer shares, each 0-100, sum to exactly 100. A partial
  // read (one 50% Setting with its partner omitted), an invalid share or a
  // bad sum leaves traffic unaccounted for, so nothing is certified from it.
  const sharesKnown =
    allSettings.length >= 1 &&
    allSettings.length <= 2 &&
    allSettings.every((x) => typeof x.percentage === "number" && Number.isInteger(x.percentage) && x.percentage >= 0 && x.percentage <= 100) &&
    allSettings.reduce((sum, x) => sum + (x.percentage as number), 0) === 100;
  const live = allSettings.filter((x) => (x.percentage ?? 1) > 0);
  const signing: "yes" | "no" | "unknown" =
    !sharesKnown || live.length === 0
      ? "unknown"
      : live.some(
            (x) =>
              (x.signatureType !== null && x.signatureType !== "ACCOUNT_AUTH_TOKEN") ||
              (x.signatureAlgorithm !== null && x.signatureAlgorithm !== "HMAC_SHA1"),
          )
        ? "no"
        : live.some((x) => x.signatureType === null || x.signatureAlgorithm === null)
          ? "unknown"
          : "yes";
  const KNOWN_UNSUPPORTED_AUTH = ["OAUTH2", "BASIC", "DIGEST"];
  const auth: "yes" | "no" | "unknown" =
    !sharesKnown || live.length === 0
      ? "unknown"
      : live.some((x) => x.authScheme !== null && KNOWN_UNSUPPORTED_AUTH.includes(x.authScheme))
        ? "no"
        : live.some((x) => x.authScheme !== "NONE")
          ? "unknown"
          : "yes";
  checks.push(
    rules === undefined
      ? check("webhook_rules", "unknown", "account Webhook Rules not read: a matching Rule overrides URL overrides and decides signing")
      : !rules.matched
        ? check("webhook_rules", "pass", "no exact, prefix or default Webhook Rule matches the inbound URL")
        : auth === "no"
          ? check(
              "webhook_rules",
              "fail",
              "a Setting receiving traffic authenticates with OAUTH2, BASIC or DIGEST: the route supports only auth scheme NONE, and an OAuth2 token failure drops STOPs for up to 300 s",
            )
          : signing === "yes" && auth === "yes"
          ? check("webhook_rules", "pass", "every Setting receiving traffic uses auth scheme NONE and signs with the account auth token, HMAC-SHA1")
          : signing === "no"
            ? check(
                "webhook_rules",
                "fail",
                "a Setting receiving traffic does not sign with the account auth token by HMAC-SHA1 (SHARED_KEY, NONE or HMAC_SHA256): the route refuses every STOP",
              )
            : check("webhook_rules", "unknown", "a Webhook Rule matches but its Settings' shares, auth scheme or signing are not reported (or the auth scheme is unrecognised)"),
  );

  // EDGE ZONES (Codex P2 4264761398): a Setting restricted to zones without
  // fallback fails delivery whenever none of them has an available point of
  // presence. Each live Setting must be unrestricted ("omitted": every zone
  // eligible), allow zone fallback, or list at least two catalogued zones with
  // active edge locations. This only CLASSIFIES what is configured: whether to
  // add zones or enable fallback is a data-residency decision for the owner.
  if (rules?.matched) {
    const catalog = f.edgeZoneCatalog;
    const zoneVerdict = (x: (typeof live)[number]): "yes" | "no" | "unknown" => {
      const z = x.edgeZones;
      if (z === null || z === undefined) return "unknown";
      if (z === "omitted") return "yes";
      const zones: unknown = (z as { zones?: unknown }).zones;
      if (
        typeof z !== "object" ||
        !Array.isArray(zones) ||
        zones.length === 0 ||
        !zones.every((id) => typeof id === "string" && id.length > 0) ||
        new Set(zones).size !== zones.length
      ) {
        return "unknown";
      }
      if (z.allowZoneFallback === null || (z.allowZoneFallback !== undefined && typeof z.allowZoneFallback !== "boolean")) return "unknown";
      if (z.allowZoneFallback === true) return "yes";
      // Omitted allowZoneFallback is the documented default, false.
      if (catalog === undefined) return "unknown";
      const available = (zones as string[]).filter((id) => catalog.some((c) => c.id === id && c.activeEdgeLocations > 0));
      return available.length >= 2 ? "yes" : "no";
    };
    const verdicts = sharesKnown ? live.map(zoneVerdict) : ["unknown" as const];
    checks.push(
      verdicts.includes("no")
        ? check(
            "webhook_zones",
            "fail",
            "a live Setting restricts delivery to fewer than two available edge zones without allowZoneFallback: a zone outage drops the STOP. List another zone or allow fallback, unless data residency rules it out (an owner decision)",
          )
        : verdicts.includes("unknown")
          ? check(
              "webhook_zones",
              "unknown",
              "a live Setting's edgeZones, its allowZoneFallback or the edge-zone catalog is not read (or malformed): re-read the Setting and GET /v1/Webhooks/EdgeZones",
            )
          : check("webhook_zones", "pass", "every live Setting may use every zone, falls back to any zone, or lists at least two available zones"),
    );
  }

  // PROPAGATION: only meaningful once the Rules are read (unread Rules already
  // block). In flight it is unknown ("wait"); a terminal FAILED or CANCELLED
  // Operation is a failure, since waiting cannot make it take effect.
  if (rules !== undefined) {
    const p = f.webhookPropagation;
    const PROPAGATION_SECONDS = 90;
    const statuses = p?.ruleOperationStatuses ?? null;
    const terminal = (statuses ?? []).filter((st) => st === "FAILED" || st === "CANCELLED");
    const unrecognised = (statuses ?? []).filter((st) => !["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(st));
    checks.push(
      terminal.length > 0
        ? check(
            "webhook_propagation",
            "fail",
            `a Rule Operation ended ${terminal.join(", ")}: that change will never take effect. Read the Operation's error, fix and re-apply the Rule, then re-read`,
          )
        : p === undefined || statuses === null || p.secondsSinceLastConfigChange === null
          ? check("webhook_propagation", "unknown", "Webhooks configuration propagation not read: confirm Rule Operations are COMPLETED and 90 s have passed since the last change")
          : unrecognised.length > 0
            ? check("webhook_propagation", "unknown", `unrecognised Rule Operation status ${unrecognised.join(", ")}: re-read`)
            : statuses.every((st) => st === "COMPLETED") && p.secondsSinceLastConfigChange >= PROPAGATION_SECONDS
              ? check("webhook_propagation", "pass", "Rule Operations COMPLETED and the configuration has been unchanged for at least 90 s")
              : check(
                  "webhook_propagation",
                  "unknown",
                  "Webhooks configuration still propagating (an Operation is PENDING or RUNNING, or less than 90 s since the last change): wait, then re-read",
                ),
    );
  }

  // Do the account Rules' retries recover every delivery failure (Codex P1
  // 4264761390)? "n/a" = no Rule matches, so the URL's own overrides decide.
  // Every Setting that receives traffic must, on its own.
  const settingRecovers = (x: (typeof live)[number]): "yes" | "no" | "unknown" => {
    if (x.retryOn === null || x.retryCount === null || x.totalTimeoutMs === null || x.connectTimeoutMs === null || x.readTimeoutMs === null) {
      return "unknown";
    }
    return retriesRecoverEveryFailure({
      named: x.retryOn.flatMap((t) => SETTING_POLICY[t] ?? []),
      count: x.retryCount,
      ct: x.connectTimeoutMs ?? TWILIO_DEFAULT_CONNECT_TIMEOUT_MS,
      rt: x.readTimeoutMs ?? TWILIO_DEFAULT_READ_TIMEOUT_MS,
      tt: x.totalTimeoutMs ?? TWILIO_DEFAULT_TOTAL_TIME_MS,
    })
      ? "yes"
      : "no";
  };
  const ruleRetries: "yes" | "no" | "unknown" | "n/a" =
    rules === undefined
      ? "unknown"
      : !rules.matched
        ? "n/a"
        : !sharesKnown || live.length === 0
          ? "unknown"
          : live.map(settingRecovers).reduce<"yes" | "no" | "unknown">(
              (acc, v) => (acc === "no" || v === "no" ? "no" : acc === "unknown" || v === "unknown" ? "unknown" : "yes"),
              "yes",
            );
  /**
   * One webhook's recovery from a failed delivery: retries covering every
   * failure under the effective configuration, or its own same-route POST
   * fallback. ASSUMPTION (recorded in the handoff): Twilio requests the
   * fallback "if an error occurs while retrieving or executing the TwiML" at
   * the primary URL (Messaging Services and IncomingPhoneNumbers docs), which
   * covers connect failures, timeouts, 4xx and 5xx alike. The fallback is the same
   * URL, so the same Rule, Setting and edge zones govern it too.
   */
  const ruleState = rules === undefined ? "unknown" : rules.matched ? "matched" : "none";
  /**
   * Does ONE requested URL recover its own delivery failures? Its retries must
   * cover connect/TLS, read timeout, 4xx AND 5xx with at least one retry and the
   * 2 * (ct + rt) budget (the URL's overrides with no Rule; every live
   * Setting's under a matching Rule; unknown with the Rules unread), and its
   * transport (SNI, edges, Static Proxy) must not defeat them. The SAME test
   * for the primary and the fallback (Codex P1 4269949178): a fallback is
   * just another request, and the same database-backed route can answer it
   * 500 again, so endpoint, method and edges alone never certify it.
   */
  const combine = (retries: "yes" | "no" | "unknown", transport: Transport): "yes" | "no" | "unknown" =>
    retries === "no" || transport === "unsafe" ? "no" : retries === "unknown" || transport === "unknown" ? "unknown" : "yes";
  // The URL's own overrides: the whole verdict with no matching Rule, and a
  // SYSTEM Setting's share under one (Codex P2 4305024182).
  const urlRecovers = (u: string | null | undefined) =>
    combine(retriesRecoverDelivery(u, false) ? "yes" : "no", urlTransport(u, "none", { staticProxyEnabled: f.staticProxyEnabled }));
  const recovers = (u: string | null | undefined): "yes" | "no" | "unknown" => {
    if (ruleState === "none") return urlRecovers(u);
    if (ruleState === "unknown" || !rules?.matched || !sharesKnown || live.length === 0) {
      return combine("unknown", urlTransport(u, "unknown", { staticProxyEnabled: f.staticProxyEnabled }));
    }
    // Under a matching Rule EVERY live share must recover on its own terms.
    const matchedTransport = urlTransport(u, "matched", { staticProxyEnabled: f.staticProxyEnabled });
    return live
      .map((x): "yes" | "no" | "unknown" =>
        x.settingType === "SYSTEM"
          ? urlRecovers(u)
          : x.settingType === "CUSTOMER"
            ? combine(settingRecovers(x), matchedTransport)
            : "unknown",
      )
      .reduce<"yes" | "no" | "unknown">(
        (acc, v) => (acc === "no" || v === "no" ? "no" : acc === "unknown" || v === "unknown" ? "unknown" : "yes"),
        "yes",
      );
  };
  const redelivers = (url: string | null | undefined, fbUrl: string | null | undefined, fbMethod: string | null | undefined) => {
    const primary = recovers(url);
    if (primary === "yes") return "yes" as const;
    // The fallback's fragment is stripped only to compare endpoints.
    const fallbackIsRoute = !!expected.ok && signedFormOfConfiguredUrl(fbUrl ?? null) === expected.url;
    const fallbackPost = fallbackIsRoute && typeof fbMethod === "string" && fbMethod.toUpperCase() === "POST";
    const fallback = fallbackPost ? recovers(fbUrl) : "no";
    if (fallback === "yes") return "fallback" as const;
    // Anything not read stays UNKNOWN (Codex P2 4254851468): the fallback URL,
    // or, for a fallback that IS the route, its method or its recovery.
    const fallbackUnread = fbUrl === undefined || (fallbackIsRoute && fbMethod === undefined) || fallback === "unknown";
    return primary === "unknown" || fallbackUnread ? ("unknown" as const) : ("no" as const);
  };

  // A STOP the route answers 500 must be redelivered (Codex P1 4254444665).
  // Evaluated only once inbound reaches the route, so a wrong URL is reported
  // once, by inbound_reaches. Under the number override, only the NUMBER's
  // fallback is used (Codex P1 4254537025).
  if (reaches === "yes" && svc) {
    const onNumber = effective?.kind === "number";
    const fallbackName = onNumber ? "the number's sms_fallback_url" : "the service's fallback_url";
    const verdict = onNumber
      ? redelivers(svc.numberSmsUrl, svc.numberSmsFallbackUrl, svc.numberSmsFallbackMethod)
      : redelivers(svc.inboundRequestUrl, svc.fallbackUrl, svc.fallbackMethod);
    checks.push(
      verdict === "yes"
        ? check(
            "stop_redelivery",
            "pass",
            ruleRetries === "yes"
              ? "every live Setting retries connect failures, read timeouts, 4xx and 5xx within its budget (retryOn ALL, or HTTP_4XX, HTTP_5XX, CONNECTION_TIMEOUT and READ_TIMEOUT; retryCount>=1; totalTimeoutMs>=2*(connect+read)); a partial response is never retried by Twilio"
              : "the inbound URL's overrides retry connect failures, read timeouts, 4xx and 5xx within tt (rp=all or rp=4xx,5xx,ct,rt; rc>=1; tt>=2*(ct+rt)); a partial response is never retried by Twilio",
          )
        : verdict === "fallback"
          ? check("stop_redelivery", "pass", `${fallbackName} is the same route, by POST`)
          : verdict === "unknown"
            ? check(
                "stop_redelivery",
                "unknown",
                `delivery recovery not proven: read the account Webhook Rules (every live Setting's retryPolicy and timeouts) and ${fallbackName}`,
              )
            : check(
                "stop_redelivery",
                "fail",
                `a STOP whose delivery fails (connect/TLS, read timeout, a transient 4xx or 5xx) may never be redelivered: the retries do not cover all four within their budget, and ${fallbackName} does not recover its own failures. Needed: rp=all or rp=4xx,5xx,ct,rt (a Setting: retryOn ALL, or HTTP_4XX, HTTP_5XX, CONNECTION_TIMEOUT and READ_TIMEOUT); rc>=1; tt>=2*(ct+rt). Retries are bounded by rc (at most 5): a signature failure (403) is fixed through the signing checks, never by retrying`,
              ),
    );
  }

  // ONE NUMBER OR ALL OF THEM. With the number-level override on, each pool
  // number has its own webhook. Replies go to the number that sent, so either
  // routed sends are pinned to the checked number, or every pool number must
  // reach the expected URL too. With the override off, the service URL serves
  // every number and there is nothing more to check.
  if (svc?.useInboundWebhookOnNumber === true) {
    const pinned =
      !!svc.checkedNumber && !!f.routedFromNumber && svc.checkedNumber === f.routedFromNumber;
    const pool = svc.senderPool;
    const poolVerdict =
      pool === undefined || !expected.ok
        ? "unknown"
        : pool.length === 0
          ? "unknown"
          : pool
              .map((n) =>
                inboundReaches(
                  {
                    serviceInboundUrl: signedFormOfConfiguredUrl(svc.inboundRequestUrl ?? null),
                    serviceInboundMethod: svc.inboundMethod ?? null,
                    useInboundWebhookOnNumber: true,
                    numberSmsUrl: signedFormOfConfiguredUrl(n.smsUrl),
                    numberSmsMethod: n.smsMethod,
                    numberSmsApplicationSid: n.smsApplicationSid,
                  },
                  expected.url,
                ),
              )
              .reduce<"yes" | "no" | "unknown">(
                (acc, v) => (acc === "no" || v === "no" ? "no" : acc === "unknown" || v === "unknown" ? "unknown" : "yes"),
                "yes",
              );
    // Each pool member's own retries or own fallback (Codex P2 4254655918).
    // Three-state (Codex P2 4254745411): an unread member is UNKNOWN, never "lost".
    const memberVerdicts = (pool ?? []).map((n) => redelivers(n.smsUrl, n.smsFallbackUrl, n.smsFallbackMethod));
    const poolRedelivery: "yes" | "no" | "unknown" =
      pool === undefined || memberVerdicts.length === 0
        ? "unknown"
        : memberVerdicts.includes("no")
          ? "no"
          : memberVerdicts.includes("unknown")
            ? "unknown"
            : "yes";
    checks.push(
      pinned
        ? check("sender_pool", "pass", "routed sends are pinned to the checked number, so replies return to it")
        : poolVerdict === "yes" && poolRedelivery === "no"
          ? check("sender_pool", "fail", "a pool number neither retries every delivery failure nor falls back to the route: a STOP may be lost")
          : poolVerdict === "yes" && poolRedelivery === "unknown"
            ? check("sender_pool", "unknown", "a pool number's delivery recovery is not proven: read its Webhook Rule and sms_fallback_url")
          : poolVerdict === "yes"
          ? check("sender_pool", "pass", `every pool number (${pool!.length}) reaches the expected URL by POST and recovers failed deliveries`)
          : poolVerdict === "no"
            ? check("sender_pool", "fail", "a pool number's own webhook does not reach the expected URL by POST")
            : check("sender_pool", "unknown", "outbound not pinned to the checked number and the sender pool not fully read"),
    );
  }

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

  // Raw facts may be partial or malformed (Codex P2 4270134232): only an
  // explicit, well-typed value counts. dropsKeywordMessages must be exactly
  // false to pass and exactly true to refuse; anything else is unknown. A null
  // object never throws.
  const stop = f.liveStopObservation ?? undefined;
  const optOut = f.optOutConfiguration ?? undefined;
  const isoTime = (v: unknown) => (typeof v === "string" && v.length > 0 ? Date.parse(v) : NaN);
  const observedAt = isoTime(stop?.observedAt);
  const optOutChangedAt = isoTime(optOut?.lastChangedAt);
  const activation = f.currentActivation ?? undefined;
  const handlerDeployedAt = isoTime(activation?.handlerDeployedAt);
  const databaseMigratedAt = isoTime(activation?.databaseMigratedAt);
  const stopObservedOk = stop?.reachedRoute === true && stop.routeStatus === 200 && stop.phoneWideOptOutStamped === true;
  checks.push(
    optOut?.dropsKeywordMessages === true
      ? check("stop_forwarded", "fail", "the service is configured to drop opt-out keyword messages: a STOP never reaches Hone, whatever an earlier observation showed")
      : stop === undefined
        ? check("stop_forwarded", "unknown", "STOP suppression not yet observed (first approved live verification)")
        : stop.reachedRoute === false
          ? check("stop_forwarded", "fail", "the service consumed STOP without forwarding it to Hone")
          : typeof stop.routeStatus === "number" && stop.routeStatus !== 200
            ? check("stop_forwarded", "fail", `the route answered ${stop.routeStatus} to the STOP: it was forwarded but not accepted, so nothing was suppressed`)
            : stop.routeStatus === 200 && stop.phoneWideOptOutStamped === false
              ? check("stop_forwarded", "fail", "the route accepted the STOP but no phone-wide opt-out was stamped")
              : !stopObservedOk
                ? check("stop_forwarded", "unknown", "the live STOP's delivery, response status or phone-wide stamp was not read (or not well-formed)")
                : optOut?.dropsKeywordMessages !== false
                  ? check("stop_forwarded", "unknown", "the service's opt-out configuration (does it drop keyword messages?) was not read as an explicit true/false")
                  : Number.isNaN(observedAt) || Number.isNaN(optOutChangedAt)
                    ? check("stop_forwarded", "unknown", "the live STOP's time or the opt-out configuration's last change was not read: the observation cannot be tied to the current configuration")
                    : !(observedAt > optOutChangedAt)
                      ? check("stop_forwarded", "unknown", "the opt-out configuration changed after the live STOP was observed: re-verify with a new approved live STOP")
                      : Number.isNaN(handlerDeployedAt) || Number.isNaN(databaseMigratedAt)
                        ? check("stop_forwarded", "unknown", "when the current inbound handler deployment and database migration became active was not read: the observation cannot be tied to the code and schema now serving STOP")
                        : observedAt > handlerDeployedAt && observedAt > databaseMigratedAt
                          ? check("stop_forwarded", "pass", "a live STOP, after the last opt-out change and after the current handler deployment and database migration, was accepted (200) and stamped the phone-wide opt-out")
                          : check("stop_forwarded", "unknown", "the inbound handler was deployed or the database migrated after the live STOP was observed: re-verify with a new approved live STOP"),
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
