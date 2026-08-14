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

// The exact canonical marketing surfaces, derived from the single registry the
// sitemap and metadata also read. Analytics cannot drift from the site map.
export const MARKETING_ROUTES: ReadonlySet<string> = new Set(
  MARKETING_PAGES.map((p) => p.path),
);

// Token-bearing route prefixes. Any event on these is dropped; the token is
// also redacted wherever it appears (defence in depth).
export const TOKEN_PATH_PREFIXES = [
  "/portal/verify/",
  "/cancel/",
  "/reschedule/",
  "/manage/",
  "/intake/",
  "/calendar-feed/",
];

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
]);

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
  for (const prefix of TOKEN_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      pathname = `${prefix}[token]`;
      break;
    }
  }
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (ATTRIBUTION_PARAMS.has(k)) params.set(k, v);
  }
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : "";
  return relative ? `${pathname}${suffix}` : `${u.origin}${pathname}${suffix}`;
}

/** Legacy single-URL sanitizer (token redaction only). */
export function sanitizeUrl(url: string): string {
  return sanitizeTokenPaths(url);
}

function sanitizeProps(value: unknown, key: string, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return typeof value === "string" ? "[redacted]" : value;
  }
  if (typeof value === "string") {
    return URL_PROP_KEYS.has(key)
      ? sanitizeMarketingUrl(value)
      : sanitizeTokenPaths(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeProps(v, key, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeProps(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

// Loose structural constraint so this module avoids depending on posthog-js
// types; generic so it is directly assignable to BeforeSendFn.
type OutgoingEventShape = {
  event?: string;
  properties?: Record<string, unknown>;
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
  return event;
}
