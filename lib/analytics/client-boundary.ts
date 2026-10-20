// Browser analytics privacy boundary (P1-ANALYTICS-01 / -02).
//
// Hone is a clinical app and the PostHog browser SDK initializes globally (all
// routes). The threat is NOT limited to autocapture: `$pageview` / `$pageleave`
// are NOT governed by `autocapture.url_allowlist`, so by default they leave
// EVERY route, and authenticated URLs carry linkable clinical identifiers
// (client/session/appointment/record UUIDs, query params). This was confirmed
// live: production PostHog Activity showed `$pageview` with Current URL
// `https://hone.care/clients/<uuid>`.
//
// Policy: FAIL CLOSED by (event, surface). The `before_send` guard
// (`guardBrowserEvent`) is the single authoritative boundary for EVERY browser
// event. An event survives ONLY if BOTH hold:
//   1. its `$current_url` pathname is one of the exact canonical marketing
//      routes (derived from the marketing page registry so sitemap, metadata,
//      tests and analytics cannot drift: a new route is NOT analytics-enabled
//      by placement), AND
//   2. its event name is on the marketing allowlist ($pageview, $pageleave,
//      the autocapture family, or an explicit `marketing:*` event).
// Everything else: the authenticated app, `/book/*`, portal, all six
// token-bearing routes, login/auth, payment, and any unknown/unparsable URL,
// is DROPPED (not redacted). Token redaction is defence in depth, not
// permission to transmit.
//
// Surviving marketing events are still sanitized: token path segments redacted,
// query stripped to reviewed attribution params, fragments removed, referrers
// sanitized, $elements attributes token-cleaned. Session replay, exception
// capture, surveys, heatmaps and performance capture are disabled in init.
//
// Pure module (no posthog-js import); unit-tested against event-shaped payloads.

import { MARKETING_PAGES } from "@/lib/marketing/content";
import { decodeBounded, redactIdsInPath, redactIdsInValue } from "@/lib/analytics/path-ids";
import { TOKEN_ROUTE_PREFIXES } from "@/lib/security/token-routes";

// The exact canonical marketing surfaces, derived from the single registry the
// sitemap and metadata also read. Analytics cannot drift from the site map.
export const MARKETING_ROUTES: ReadonlySet<string> = new Set(
  MARKETING_PAGES.map((p) => p.path),
);

// Token-bearing route prefixes. Any event on these is dropped; the token is
// also redacted wherever it appears (defence in depth). DERIVED from the
// canonical registry (lib/security/token-routes.ts) so it cannot drift: the
// hand-written copy here lacked /invitation (HIPAA-READY-01, #828).
export const TOKEN_PATH_PREFIXES: readonly string[] = TOKEN_ROUTE_PREFIXES.map(
  (prefix) => `${prefix}/`,
);

// Reviewed attribution query params retained on marketing URLs. Every other
// query parameter is stripped.
const ATTRIBUTION_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
]);

// Browser event names permitted on marketing surfaces. Fail closed: anything
// not here (including $identify, $web_vitals, $set, SDK internals) is dropped.
const MARKETING_ALLOWED_EVENTS = new Set([
  "$pageview",
  "$pageleave",
  "$autocapture",
  "$rageclick",
  "$dead_click",
]);
const MARKETING_EVENT_PREFIX = "marketing:";

// Property keys whose string value is a URL: sanitized as a URL (query/
// fragment/token handling), not merely token-redacted.
const URL_PROP_KEYS = new Set([
  "$current_url",
  "$referrer",
  "$initial_current_url",
  "$initial_referrer",
  "attr__href",
  "$pathname",
  "$initial_pathname",
  "$session_entry_url",
  "$session_entry_referrer",
  "$session_entry_pathname",
]);

/** A URL- or path-valued property (#828 G-07/G-26). Beyond the named keys,
 *  ANY key ending in _url, _referrer or _pathname is treated as one, so a URL
 *  property posthog-js adds later ($prev_pageview_pathname, ...) is sanitized
 *  rather than passed through. */
function isUrlPropKey(key: string): boolean {
  return URL_PROP_KEYS.has(key) || /(?:_url|_referrer|_pathname)$/.test(key);
}

const MAX_DEPTH = 8;

export function isMarketingPath(pathname: string): boolean {
  return MARKETING_ROUTES.has(pathname);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// SDK-level defence in depth: autocapture is only ARMED on marketing routes, so
// the SDK does not even generate autocapture events elsewhere. `before_send`
// (guardBrowserEvent) remains the authoritative guarantee for every event type.
export const AUTOCAPTURE_URL_ALLOWLIST: RegExp[] = [...MARKETING_ROUTES].map(
  (p) =>
    new RegExp(`^https?://[^/]+${p === "/" ? "/" : escapeRegex(p)}/?([?#].*)?$`),
);

/** Pathname of an absolute URL, or null if unparsable. */
function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function isAllowedMarketingEvent(name: string): boolean {
  return (
    MARKETING_ALLOWED_EVENTS.has(name) || name.startsWith(MARKETING_EVENT_PREFIX)
  );
}

/** Redact token segments in any string (full URL or bare path). */
export function sanitizeTokenPaths(value: string): string {
  let out = value;
  for (const prefix of TOKEN_PATH_PREFIXES) {
    const re = new RegExp(
      `${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^/?#"'\\s]+`,
      "g",
    );
    out = out.replace(re, `${prefix}[token]`);
  }
  return out;
}

/**
 * Rebuild a URL/path keeping only path (token-redacted) + reviewed attribution
 * query params. Fragments dropped. Handles absolute and relative inputs;
 * returns "[redacted]" for the unparsable case.
 */
export function sanitizeMarketingUrl(raw: string): string {
  let u: URL;
  let relative = false;
  try {
    u = new URL(raw);
  } catch {
    try {
      u = new URL(raw, "https://redacted.invalid");
      relative = true;
    } catch {
      return "[redacted]";
    }
  }
  let pathname = u.pathname;
  let tokenRoute = false;
  for (const prefix of TOKEN_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      pathname = `${prefix}[token]`;
      tokenRoute = true;
      break;
    }
  }
  // Record ids in an app path never leave (#828 G-07/G-26): a $referrer or
  // $initial_current_url can name /clients/<uuid>/sessions/<uuid> even on a
  // marketing-page event. Same rules as the Vercel Analytics boundary (#842).
  // Canonical marketing paths carry no ids (and long slugs such as
  // "electrolysis-treatment-record-checklist" must not read as tokens).
  if (!tokenRoute && !isMarketingPath(pathname)) pathname = redactIdsInPath(pathname);
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    // The VALUE is kept for attribution, minus any record id (Codex P1 4309025843).
    if (ATTRIBUTION_PARAMS.has(k)) params.set(k, redactIdsInValue(v));
  }
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : "";
  return relative ? `${pathname}${suffix}` : `${u.origin}${pathname}${suffix}`;
}

/** Legacy single-URL sanitizer (token redaction only). */
export function sanitizeUrl(url: string): string {
  return sanitizeTokenPaths(url);
}

// Campaign parameters posthog-js copies into STANDALONE properties, bare or
// with its $initial_ / $session_entry_ prefixes: the utm_* set plus the ad
// click ids it collects. Their values are kept for attribution, minus any
// record id (Codex P1 4309025843). PostHog's own ids ($session_id,
// distinct_id, $device_id, uuid) are not here and are never touched.
const CAMPAIGN_PROP = new RegExp(
  "^(?:\\$initial_|\\$session_entry_)?(?:utm_(?:source|medium|campaign|term|content)|" +
    "gclid|gad_source|gclsrc|dclid|gbraid|wbraid|fbclid|msclkid|twclid|li_fat_id|mc_cid|igshid|ttclid|rdt_cid|epik|qclid|sccid|irclid|_kx)$",
);

// A string that names a path or URL (has a "/") and carries a record id. Bare
// UUIDs are PostHog's OWN ids ($session_id, distinct_id, $device_id, uuid:
// UUIDv7) and are kept; any id inside a path-like string is replaced, whatever
// the key (Codex P2/P1 audit, 4309044244).
// Decided on the DECODED text (Codex 4309069522), never on a raw signal: an
// encoded string (it decodes to something else) or one that contains "/" is
// redacted; a bare, unencoded UUID (PostHog's own id) is kept. Undecodable or
// over-encoded text fails closed to [token].
function redactPathLikeIds(value: string): string {
  const decoded = decodeBounded(value);
  if (decoded === null) return "[token]";
  // A BARE, unencoded UUID is PostHog's own id: kept. Any other string that
  // holds a UUID ("word:<uuid>", "/clients/<uuid>", an encoded id) loses it.
  if (decoded === value && BARE_UUID.test(value)) return value;
  return redactIdsInValue(value);
}
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A string that IS a URL, absolute (http/https) or app-relative, is sanitized
// AS a URL whatever its key (Codex 4309069519): query and fragment dropped,
// path ids redacted. Decided by PARSING the decoded text the way a browser
// would (Codex 4309252679), never by a textual prefix: the WHATWG parser
// trims leading/trailing C0 controls and spaces, drops tabs and newlines
// anywhere, and reads "\\" as "/" in an http(s) URL, so " https:\\host\\…",
// "https:host/…" and "ht<LF>tps://…" are all http(s) URLs.
function whatwgTrim(value: string): string {
  return value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
}
function looksLikeUrl(value: string): boolean {
  const decoded = decodeBounded(value) ?? value;
  try {
    const u = new URL(decoded);
    if (u.protocol === "http:" || u.protocol === "https:") return true;
  } catch {
    // not absolute; may still be app-relative
  }
  const trimmed = whatwgTrim(decoded);
  return trimmed.startsWith("/") || trimmed.startsWith("\\");
}

// A STRING is treated as a non-http(s) URL only when that is UNAMBIGUOUS
// (Codex 4309185282: "summer:sale" and autocapture's "a:attr__href=…" are not
// URLs, and turning them into a placeholder broke attribution):
//   * the scheme is followed by "//" (an authority form: ftp://, file://,
//     custom-app://…), or
//   * the scheme is one of the path-less schemes that carry data, or
//   * the scheme is WHATWG-special (ftp, ws, wss, file), where "\\" is a
//     separator too, so "ftp:\\\\host\\…" is as much a URL as "ftp://host/…"
//     (Codex 4309252679).
// Any other "word:rest" string is ordinary text and goes through the value
// rules below, so a record id inside it is still redacted. URL INSTANCES are
// unambiguous and handled in sanitizeProps by type.
const NON_HTTP_URL_PLACEHOLDER = "[url]";
const DATA_SCHEMES = new Set(["mailto", "data", "javascript", "blob", "tel", "sms", "file"]);
const SPECIAL_SCHEMES = new Set(["ftp", "ws", "wss", "file"]);
function isNonHttpUrl(value: string): boolean {
  const decoded = whatwgTrim(decodeBounded(value) ?? value);
  const m = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(decoded);
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  if (scheme === "http" || scheme === "https") return false;
  return m[2]!.startsWith("//") || DATA_SCHEMES.has(scheme) || SPECIAL_SCHEMES.has(scheme);
}

// PostHog autocapture's own structural fields: never classified as URLs
// (their syntax is selectors, "a:attr__href=…"), but record ids inside them
// are still redacted.
const STRUCTURAL_KEYS = new Set(["$elements_chain", "$el_text"]);

/** Object keys lose record ids too (decoded first, unconditionally); a
 *  collision gets a numeric suffix so no value is silently dropped. */
function sanitizeKey(key: string, taken: Record<string, unknown>): string {
  const base = redactIdsInValue(key);
  if (!Object.hasOwn(taken, base)) return base;
  let n = 2;
  while (Object.hasOwn(taken, `${base}#${n}`)) n += 1;
  return `${base}#${n}`;
}

/**
 * Every value that leaves is sanitized; NOTHING passes through unexamined
 * (Codex 4309044244: an over-depth container used to be returned as is).
 *   * strings: URL keys as URLs, campaign keys by value, path-like strings
 *     lose ids, all lose token paths; over the depth limit, "[redacted]";
 *   * containers over the depth limit: "[depth-limited]", never the original;
 *   * URL instances: withheld as "[url]" without reading their properties;
 *     non-http(s) URL strings likewise "[url]";
 *   * Date: sanitized as its ISO string through intrinsic methods only;
 *   * every other object with a toJSON, and Map / Set / class instances /
 *     any non-plain prototype: "[unsupported]", WITHOUT calling toJSON
 *     (Codex 4309252682: a toJSON can serialize hidden state);
 *   * arrays and plain objects: element by element, keys included;
 *   * number / boolean / null / undefined: as is (no text to carry an id);
 *   * bigint / symbol / function: dropped (undefined).
 */
function sanitizeProps(value: unknown, key: string, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (depth > MAX_DEPTH) return "[redacted]";
    if (STRUCTURAL_KEYS.has(key)) return redactIdsInValue(sanitizeTokenPaths(value));
    if (CAMPAIGN_PROP.test(key)) return redactIdsInValue(sanitizeTokenPaths(value));
    if (isNonHttpUrl(value)) return NON_HTTP_URL_PLACEHOLDER;
    if (isUrlPropKey(key)) return sanitizeMarketingUrl(value);
    // A URL-shaped value under any other key: sanitized as the URL it decodes
    // to, so an encoded "%2Fclients%2F…%3F…" loses its query too.
    if (looksLikeUrl(value)) return sanitizeMarketingUrl(decodeBounded(value) ?? "[redacted]");
    return redactPathLikeIds(sanitizeTokenPaths(value));
  }
  if (typeof value !== "object") return undefined;
  if (depth > MAX_DEPTH) return "[depth-limited]";
  // URL objects previously exposed no fields. Do not introduce serialization
  // of arbitrary hidden PII in their origin, path or retained attribution.
  // SDK string URLs retain the separately reviewed URL/campaign rules.
  if (value instanceof URL) return NON_HTTP_URL_PLACEHOLDER;
  // Never dispatch through instance methods: even intrinsic toJSON calls an
  // overridable toISOString. Read the internal time and serialize a fresh Date.
  if (value instanceof Date) {
    let iso: unknown;
    try {
      const time = Date.prototype.getTime.call(value);
      iso = Number.isFinite(time) ? new Date(time).toISOString() : null;
    } catch {
      return "[unsupported]";
    }
    return sanitizeProps(iso, key, depth + 1);
  }
  // Checking a serializer must not execute it: even a non-enumerable getter
  // can publish hidden state into fields that Object.entries would then send.
  for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value === "function") return "[unsupported]";
    break;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeProps(v, key, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "[unsupported]";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[sanitizeKey(k, out)] = sanitizeProps(v, k, depth + 1);
  }
  return out;
}

// Loose structural constraint so this module avoids depending on posthog-js
// types; generic so it is directly assignable to BeforeSendFn.
type OutgoingEventShape = {
  event?: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
};

/**
 * before_send: the single authoritative browser-event boundary. Returns the
 * (sanitized) event only for an allowed marketing event on a canonical
 * marketing route; returns null (drop) for everything else, fail closed.
 */
export function guardBrowserEvent<T extends OutgoingEventShape | null>(
  event: T,
): T | null {
  if (!event) return event;

  const name = event.event;
  if (typeof name !== "string" || name.length === 0) return null; // fail closed

  const props = event.properties;
  const currentUrl =
    props && typeof props.$current_url === "string" ? props.$current_url : null;
  const pathname = currentUrl ? pathnameOf(currentUrl) : null;

  // Fail closed: require a parsable marketing URL AND an allowed marketing
  // event name. Drops all authenticated, booking, portal, token, login,
  // payment, unknown-route and malformed-URL events (and $identify, which is
  // handled server-side).
  if (
    pathname === null ||
    !isMarketingPath(pathname) ||
    !isAllowedMarketingEvent(name)
  ) {
    return null;
  }

  if (props) {
    event.properties = sanitizeProps(props, "", 0) as Record<string, unknown>;
  }
  // Person properties travel beside `properties` and carry the same URL keys
  // ($set_once.$initial_current_url, ...): sanitized the same way.
  if (event.$set && typeof event.$set === "object") {
    event.$set = sanitizeProps(event.$set, "", 0) as Record<string, unknown>;
  }
  if (event.$set_once && typeof event.$set_once === "object") {
    event.$set_once = sanitizeProps(event.$set_once, "", 0) as Record<string, unknown>;
  }
  return event;
}
