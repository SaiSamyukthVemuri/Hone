// Client-side analytics privacy boundary (P1-ANALYTICS-01 / P1-ANALYTICS-02).
//
// Hone is a clinical app. The PostHog browser SDK initializes globally (every
// route), so WITHOUT a boundary, autocapture would run on the authenticated
// clinical product and on token-bearing public routes, where element
// attributes (`href` on a "Cancel appointment" link, for example) contain
// reusable bearer credentials. `mask_all_text` only masks textContent — it
// does not protect attributes — and `sanitize_properties` in the original
// integration only sanitized $current_url/$referrer, not the serialized
// `$elements` / `elements_chain` payload of an autocapture event.
//
// Model: an explicit SURFACE ALLOWLIST, not a sensitive-route denylist.
// Autocapture is permitted ONLY on the enumerated public marketing pages.
// Everything else — the authenticated app, public booking, portal, and every
// token-bearing route — sends no autocapture events at all. Two independent
// layers enforce this:
//
//   1. `autocapture.url_allowlist` (SDK-level): PostHog only arms autocapture
//      on allowlisted URLs.
//   2. `before_send` (guarantee): any autocapture-family event whose URL is
//      not allowlisted is DROPPED, and every string in an outgoing event
//      (including $elements attributes and elements_chain) is token-sanitized.
//
// Pure module: no PostHog import, unit-testable in isolation.

// Token-bearing route prefixes. These are credentials; a URL containing one
// must never leave the app un-redacted. Keep in sync with TOKEN_ROUTE_PATTERNS
// in next.config.ts and the token routes in lib/supabase/middleware.ts.
export const TOKEN_PATH_PREFIXES = [
  "/portal/verify/",
  "/cancel/",
  "/reschedule/",
  "/manage/",
  "/intake/",
  "/calendar-feed/",
];

// The ONLY surfaces where autocapture may run: the public marketing site.
// Exact-match paths plus the /resources/* article prefix. Deliberately
// excluded: /login, /book/* (public booking collects client identity),
// /portal*, every token route, and the entire authenticated app.
export const AUTOCAPTURE_ALLOWED_EXACT_PATHS = [
  "/",
  "/pricing",
  "/electrolysis-software",
  "/features/treatment-memory",
  "/features/booking-calendar",
  "/features/charting-records",
  "/resources",
  "/demo",
  "/privacy",
  "/terms",
];

export const AUTOCAPTURE_ALLOWED_PREFIXES = ["/resources/"];

/** True only for the enumerated public marketing surfaces. */
export function isAutocaptureAllowedPath(pathname: string): boolean {
  if (AUTOCAPTURE_ALLOWED_EXACT_PATHS.includes(pathname)) return true;
  return AUTOCAPTURE_ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
}

// URL-allowlist regexes handed to PostHog's autocapture config. Anchored on
// the path portion of the full URL the SDK matches against, tolerating an
// optional trailing slash and query/hash suffixes.
export const AUTOCAPTURE_URL_ALLOWLIST: RegExp[] = [
  ...AUTOCAPTURE_ALLOWED_EXACT_PATHS.map(
    (p) =>
      new RegExp(
        `^https?://[^/]+${p === "/" ? "/" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?([?#].*)?$`,
      ),
  ),
  ...AUTOCAPTURE_ALLOWED_PREFIXES.map(
    (p) =>
      new RegExp(`^https?://[^/]+${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+`),
  ),
];

/** Redact the token segment of any token-bearing path inside a string. Works
 *  on full URLs and on bare paths (as found in attr__href / elements_chain). */
export function sanitizeTokenPaths(value: string): string {
  let out = value;
  for (const prefix of TOKEN_PATH_PREFIXES) {
    // The token is the path segment immediately after the prefix. Stop at a
    // segment/query/fragment/quote boundary so surrounding text is preserved.
    const re = new RegExp(
      `${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^/?#"'\\s]+`,
      "g",
    );
    out = out.replace(re, `${prefix}[token]`);
  }
  return out;
}

/** Legacy single-URL sanitizer (kept for $current_url / $referrer). */
export function sanitizeUrl(url: string): string {
  return sanitizeTokenPaths(url);
}

const AUTOCAPTURE_EVENT_NAMES = new Set([
  "$autocapture",
  "$rageclick",
  "$dead_click",
  "$heatmap",
  "$$heatmap",
]);

function deepSanitizeStrings(value: unknown, depth: number): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") return sanitizeTokenPaths(value);
  if (Array.isArray(value)) return value.map((v) => deepSanitizeStrings(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepSanitizeStrings(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Loose structural constraint so this module does not depend on posthog-js
// types; generic so the function is directly assignable to BeforeSendFn.
type OutgoingEventShape = {
  event?: string;
  properties?: Record<string, unknown>;
};

/**
 * before_send guarantee layer:
 *  - DROP any autocapture-family event whose $current_url is not an
 *    allowlisted marketing surface (belt-and-suspenders over url_allowlist).
 *  - Token-sanitize EVERY string in the event properties — including
 *    $elements[].attr__href / attr__src and the serialized elements_chain —
 *    so a bearer token can never ride an attribute or URL property.
 */
export function guardOutgoingEvent<T extends OutgoingEventShape | null>(
  event: T,
): T | null {
  if (!event) return event;

  if (event.event && AUTOCAPTURE_EVENT_NAMES.has(event.event)) {
    const url = event.properties?.["$current_url"];
    let allowed = false;
    if (typeof url === "string") {
      try {
        allowed = isAutocaptureAllowedPath(new URL(url).pathname);
      } catch {
        allowed = false; // unparsable URL -> fail closed
      }
    }
    if (!allowed) return null;
  }

  if (event.properties) {
    event.properties = deepSanitizeStrings(event.properties, 0) as Record<
      string,
      unknown
    >;
  }

  return event;
}
