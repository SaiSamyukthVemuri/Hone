// ===========================================================================
// ONE rule for the public base of Hone's Twilio webhooks
// ===========================================================================
//
// Twilio signs the EXACT URL it calls. The signature-verifying routes
// (app/api/twilio/inbound-sms, app/api/twilio/message-status) rebuild that URL
// as TWILIO_WEBHOOK_BASE_URL + the request's path and query, and fall back to
// the URL the request actually arrived on when the variable is unset. A URL
// Hone configures on a number or Messaging Service must therefore be built
// from the SAME base, or every callback Twilio makes to it fails signature
// verification with a 403 (inbound STOP included).
//
// Both sides use this module, so the two cannot drift:
//   * routes:   canonicalTwilioSignedUrl(req.url)
//   * configure: twilioWebhookUrl(path, fallbackOrigin)
//
// Pure: reads only the env passed in.
// ===========================================================================

type Env = Readonly<Record<string, string | undefined>>;

/** The configured base, trailing slashes removed, or null when unset or empty. */
export function configuredTwilioWebhookBase(env: Env = process.env): string | null {
  const raw = env.TWILIO_WEBHOOK_BASE_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/** The URL the routes verify a Twilio signature against, for one request. */
export function canonicalTwilioSignedUrl(requestUrl: string, env: Env = process.env): string {
  const base = configuredTwilioWebhookBase(env);
  if (!base) return requestUrl;
  const u = new URL(requestUrl);
  return `${base}${u.pathname}${u.search}`;
}

/**
 * The public URL to CONFIGURE for a webhook path, or null when no usable base
 * exists. `fallbackOrigin` (the app origin) is used only when the base is
 * unset: the routes then verify against the request's own URL, which is that
 * origin when Twilio calls it. A base that is set but not an http(s) URL is
 * unusable (null): configuring it would only produce failing callbacks.
 */
export function twilioWebhookUrl(path: string, fallbackOrigin: string | null, env: Env = process.env): string | null {
  const base = configuredTwilioWebhookBase(env) ?? (fallbackOrigin ? fallbackOrigin.replace(/\/+$/, "") : null);
  if (!base) return null;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${base}${path}`;
}

// ===========================================================================
// Twilio CONNECTION OVERRIDES in a webhook URL's fragment
// ===========================================================================
//
// Twilio lets a webhook URL carry connection overrides after `#`
// (twilio.com/docs/usage/webhooks/webhooks-connection-overrides, checked
// 2026-10-13). It strips the fragment before calling, and it is not part of
// the signed URL, so `${base}/api/twilio/inbound-sms#rp=5xx` reaches Hone's
// route exactly as the plain URL does.
//
// ONE STRICT VALIDATOR (Codex decision on #863; shared with #873's STOP
// preflight). A fragment is recognised ONLY when it is entirely documented
// overrides with valid values; anything else (an unknown key, an invalid,
// ambiguous or duplicate value, an empty fragment, an arbitrary anchor) is a
// REFUSAL, never stripped. Scheme, host, path and query are compared EXACTLY:
// nothing before the `#` is normalised.
//
// Recognising a valid override proves only that the URL is the same endpoint.
// It is NOT evidence of reliable STOP redelivery: account Webhook Rules take
// precedence over URL overrides (effectiveConnectionSettings), and retry and
// fallback evidence is judged separately.
// ===========================================================================

export type ConnectionOverrides = {
  ct?: number;
  rt?: number;
  tt?: number;
  rc?: number;
  rp?: string[];
  sni?: "y" | "n";
  e?: string[];
};

export type NormalizedWebhookUrl =
  | { ok: true; url: string; overrides: ConnectionOverrides | null }
  | { ok: false; reason: "unparseable" | "invalid_fragment" };

const RETRY_POLICY_TOKENS = new Set(["4xx", "5xx", "ct", "rt", "all"]);
const EDGES = new Set([
  "sydney", "sao-paulo", "dublin", "frankfurt", "tokyo", "singapore", "ashburn", "umatilla", "roaming",
  "ashburn-ix", "san-jose-ix", "sao-paulo-ix", "london-ix", "frankfurt-ix", "singapore-ix", "tokyo-ix", "sydney-ix",
]);
const INT = /^(0|[1-9][0-9]*)$/;

function intIn(v: string, lo: number, hi: number): number | null {
  if (!INT.test(v)) return null;
  const n = Number(v);
  return n >= lo && n <= hi ? n : null;
}

function tokenList(v: string, allowed: Set<string>): string[] | null {
  const parts = v.split(",");
  if (parts.length === 0 || parts.some((p) => !allowed.has(p))) return null;
  return new Set(parts).size === parts.length ? parts : null;
}

function parseOverrides(fragment: string): ConnectionOverrides | null {
  if (fragment.length === 0) return null;
  const out: ConnectionOverrides = {};
  const seen = new Set<string>();
  for (const pair of fragment.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0 || pair.indexOf("=", eq + 1) !== -1) return null;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value.length === 0 || seen.has(key)) return null;
    seen.add(key);
    switch (key) {
      case "ct": { const n = intIn(value, 100, 10_000); if (n === null) return null; out.ct = n; break; }
      case "rt": { const n = intIn(value, 100, 15_000); if (n === null) return null; out.rt = n; break; }
      case "tt": { const n = intIn(value, 100, 15_000); if (n === null) return null; out.tt = n; break; }
      case "rc": { const n = intIn(value, 0, 5); if (n === null) return null; out.rc = n; break; }
      case "rp": { const l = tokenList(value, RETRY_POLICY_TOKENS); if (!l) return null; out.rp = l; break; }
      case "sni": { if (value !== "y" && value !== "n") return null; out.sni = value; break; }
      case "e": { const l = tokenList(value, EDGES); if (!l) return null; out.e = l; break; }
      default:
        return null;
    }
  }
  return out;
}

/** The URL Twilio calls (nothing before `#` changed) and its validated overrides. */
export function normalizeTwilioWebhookUrl(raw: string | null | undefined): NormalizedWebhookUrl {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "unparseable" };
  const hash = raw.indexOf("#");
  const url = hash === -1 ? raw : raw.slice(0, hash);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, reason: "unparseable" };
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (hash === -1) return { ok: true, url, overrides: null };
  const overrides = parseOverrides(raw.slice(hash + 1));
  return overrides ? { ok: true, url, overrides } : { ok: false, reason: "invalid_fragment" };
}

/** Is `actual` (as configured at the provider) the same webhook endpoint as `required`? */
export function sameTwilioWebhook(actual: string | null | undefined, required: string): boolean {
  const n = normalizeTwilioWebhookUrl(actual);
  return n.ok && n.url === required;
}

/**
 * The connection settings Twilio actually applies: a matching account Webhook
 * Rule's settings take PRECEDENCE over the URL's overrides (Codex decision on
 * #863). `rule` undefined = unknown (not read): the result is unknown too.
 */
export function effectiveConnectionSettings(
  url: NormalizedWebhookUrl,
  rule: ConnectionOverrides | null | undefined,
): { source: "rule" | "url" | "default"; settings: ConnectionOverrides } | { source: "unknown" } {
  if (rule === undefined || !url.ok) return { source: "unknown" };
  if (rule !== null) return { source: "rule", settings: rule };
  return url.overrides ? { source: "url", settings: url.overrides } : { source: "default", settings: {} };
}
