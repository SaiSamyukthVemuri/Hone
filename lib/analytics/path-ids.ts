// #828 G-07 / G-26: record ids in URL PATHS bound for analytics.
//
// Hone addresses clients, sessions, appointments and studios by UUID (and a
// few things by number), so an app page's path is a record reference:
// /clients/<uuid>/sessions/<uuid>. One set of rules, shared by the Vercel
// Analytics boundary (lib/analytics/vercel-url-redaction.ts, #842) and the
// PostHog browser boundary (lib/analytics/client-boundary.ts):
//   * a UUID or all-digit segment becomes [id];
//   * a long opaque segment (token-shaped) becomes [token];
//   * a segment is percent-decoded before it is judged (a %2D or %36 does not
//     hide an id), and one that cannot be decoded becomes [token];
//   * any UUID still embedded inside a segment ("client_<uuid>") becomes [id].
// Ordinary route words ("charting-records", "getting-started") are left alone.

export const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DIGIT_SEGMENT = /^\d+$/;
export const OPAQUE_SEGMENT = /^(?:(?=.*\d)[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{32,})$/;
const EMBEDDED_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** One already-decoded path segment, with any id replaced. */
export function redactIdSegment(segment: string): string {
  if (UUID_SEGMENT.test(segment) || DIGIT_SEGMENT.test(segment)) return "[id]";
  if (OPAQUE_SEGMENT.test(segment)) return "[token]";
  return segment.replace(EMBEDDED_UUID, "[id]");
}

/** A URL pathname with every id-bearing segment replaced. */
export function redactIdsInPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      let decoded = segment;
      // Decode to a fixed point (bounded): %252D is still a hyphen.
      for (let i = 0; i < 4 && decoded.includes("%"); i += 1) {
        let next: string;
        try {
          next = decodeURIComponent(decoded);
        } catch {
          return "[token]";
        }
        if (next === decoded) break;
        decoded = next;
      }
      if (decoded.includes("%") && /%[0-9a-f]{2}/i.test(decoded)) return "[token]";
      const redacted = redactIdSegment(decoded);
      return redacted === decoded ? segment : redacted;
    })
    .join("/");
}
