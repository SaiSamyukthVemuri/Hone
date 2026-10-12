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
//   * an unparsable URL, or any bearer-token route, drops the event (null);
//   * the query string and fragment are dropped (they can carry ids, emails,
//     return paths). Canonical marketing pages keep only the reviewed
//     attribution params, via the same sanitizer PostHog uses;
//   * /book/<slug> becomes /book/[studio];
//   * a UUID, an all-digit id or a long opaque token-shaped segment becomes
//     [id] / [token].
// Vercel's own `route` field is already a template (/clients/[id]) and is left
// untouched.

import {
  TOKEN_PATH_PREFIXES,
  isMarketingPath,
  sanitizeMarketingUrl,
} from "@/lib/analytics/client-boundary";

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGIT_SEGMENT = /^\d+$/;
// Opaque, credential- or id-shaped: long, URL-safe, and containing a digit.
// Ordinary route words ("charting-records", "getting-started") have no digit.
const OPAQUE_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;

function redactSegment(segment: string): string {
  if (UUID_SEGMENT.test(segment) || DIGIT_SEGMENT.test(segment)) return "[id]";
  if (OPAQUE_SEGMENT.test(segment)) return "[token]";
  return segment;
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

  if (TOKEN_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }
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
