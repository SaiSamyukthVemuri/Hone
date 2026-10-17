// HIPAA-READY-01 G-07 (issue #828): the URL boundary for Vercel Web Analytics
// and Speed Insights.
//
// SafeAnalytics mounts both scripts on the authenticated app, /admin and
// /book. Each page view and each web-vital sample sends the page URL, so before
// this boundary a URL such as /clients/<client-uuid>/sessions/<session-uuid>,
// or the studio a prospective patient is booking with (/book/<slug>), reached
// a provider whose BAA coverage for Hone is unverified. A record identifier
// next to appointment or treatment context is PHI in a covered studio's hands.
//
// The boundary is pure and fails closed:
//   * an unparsable URL, or any route in the canonical bearer-token registry
//     (lib/security/token-routes.ts), drops the event (null);
//   * the query string and fragment are dropped (they can carry ids, emails,
//     return paths). Canonical marketing pages keep only the reviewed
//     attribution params, via the same sanitizer PostHog uses;
//   * /book/<slug> becomes /book/[studio];
//   * a UUID, an all-digit id or a long opaque token-shaped segment becomes
//     [id] / [token].
// Vercel's own `route` field is already a template (/clients/[id]) and is left
// untouched.

import {
  isMarketingPath,
  sanitizeMarketingUrl,
} from "@/lib/analytics/client-boundary";
import { TOKEN_ROUTE_PREFIXES } from "@/lib/security/token-routes";
import { redactIdSegment as redactSegment } from "@/lib/analytics/path-ids";

// UUID / digit / opaque segment rules: lib/analytics/path-ids.ts, shared with
// the PostHog boundary (#828 G-07/G-26).

/** True for any path under a bearer-token route family in the canonical
 *  registry (lib/security/token-routes.ts), including the bare prefix. */
function isTokenRoute(pathname: string): boolean {
  return TOKEN_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}


/**
 * The URL Vercel may receive for this page, or null to drop the event.
 */
export function redactVercelAnalyticsUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const pathname = u.pathname;

  if (isTokenRoute(pathname)) return null;
  if (isMarketingPath(pathname)) {
    return sanitizeMarketingUrl(`${u.origin}${pathname}${u.search}`);
  }

  const segments = pathname.split("/");
  const out = segments.map((segment, i) => {
    if (segment === "") return segment;
    // segments[0] is "" for an absolute path, so /book/<slug> is index 2.
    if (i === 2 && segments[1] === "book") return "[studio]";
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return "[token]";
    }
    return redactSegment(decoded);
  });
  return `${u.origin}${out.join("/")}`;
}

type UrlEvent = { url: string };

/**
 * A `beforeSend` for both <Analytics /> and <SpeedInsights />: same event,
 * redacted URL, or null to drop it.
 */
export function redactVercelEvent<E extends UrlEvent>(event: E): E | null {
  const url = redactVercelAnalyticsUrl(event.url);
  return url === null ? null : { ...event, url };
}
