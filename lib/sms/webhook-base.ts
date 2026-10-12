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
