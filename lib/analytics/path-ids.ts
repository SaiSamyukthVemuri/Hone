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

// A percent-encoded separator (%2F, %5C, any case, possibly double-encoded)
// decodes into SEVERAL logical segments: "calendar%2F42" is calendar/42.
// Each decoded part is judged on its own (Codex P1 4305142681).
const SEPARATOR = /[\\/]/;
const ENCODED = /%[0-9a-f]{2}/i;
const MAX_DECODE_ROUNDS = 4;

function redactOnePart(part: string): string {
  if (UUID_SEGMENT.test(part) || DIGIT_SEGMENT.test(part)) return "[id]";
  if (OPAQUE_SEGMENT.test(part)) return "[token]";
  return part.replace(EMBEDDED_UUID, "[id]");
}

/** One already-decoded path segment, with any id replaced. A decoded segment
 *  that contains `/` or `\` is split and each part judged separately. */
export function redactIdSegment(segment: string): string {
  if (!SEPARATOR.test(segment)) return redactOnePart(segment);
  return segment
    .split(SEPARATOR)
    .map((part) => (part === "" ? part : redactOnePart(part)))
    .join("/");
}

/** One RAW path segment: percent-decoded to a fixed point (bounded), then
 *  judged part by part. Fail closed: a segment that cannot be decoded, or is
 *  still encoded after the bound, becomes [token]. Unchanged segments are
 *  returned exactly as they came. */
export function redactEncodedSegment(segment: string): string {
  if (segment === "") return segment;
  let decoded = segment;
  for (let i = 0; i < MAX_DECODE_ROUNDS && ENCODED.test(decoded); i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return "[token]";
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (ENCODED.test(decoded)) return "[token]";
  const redacted = redactIdSegment(decoded);
  return redacted === decoded ? segment : redacted;
}

/** A URL pathname with every id-bearing segment replaced. */
export function redactIdsInPath(pathname: string): string {
  return pathname.split("/").map(redactEncodedSegment).join("/");
}
