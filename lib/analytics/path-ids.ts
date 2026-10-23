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

// What a part may contain once emitted: RFC 3986 unreserved characters only
// (plus the [id] placeholder). Anything else (? # @ = & % space, control
// characters, non-ASCII) could rebuild URL syntax or carry text such as an
// email, so the part becomes [token] (Codex P1 4305158024).
const SAFE_PART = /^[A-Za-z0-9._~-]*$/;

function emitPart(part: string): string {
  const redacted = redactOnePart(part);
  if (redacted === "[id]" || redacted === "[token]") return redacted;
  return SAFE_PART.test(redacted.replace(/\[id\]/g, "")) ? redacted : "[token]";
}

// URL syntax can HIDE an id inside a part ("42#notes", "<uuid>?email=…"), so a
// part is also judged by its unreserved runs.
const NON_UNRESERVED = /[^A-Za-z0-9._~-]+/;
function holdsId(part: string): boolean {
  if (part === "") return false;
  if (redactOnePart(part) !== part) return true;
  return part.split(NON_UNRESERVED).some((run) => run !== "" && redactOnePart(run) !== run);
}

/** One already-decoded path segment, with any id replaced. A decoded segment
 *  that contains `/` or `\` is split and each part judged separately; every
 *  emitted part is a placeholder or unreserved-only text. */
export function redactIdSegment(segment: string): string {
  return segment
    .split(SEPARATOR)
    .map((part) => (part === "" ? part : emitPart(part)))
    .join("/");
}

/** One RAW path segment: percent-decoded to a fixed point (bounded), then
 *  judged part by part. Returned unchanged (still encoded) when no decoded
 *  part holds an id or token; otherwise the output is placeholders and
 *  unreserved text only, so no decoded `?`, `#`, `@`, `%` or other syntax is ever
 *  emitted. Fail closed: an undecodable or still-encoded segment is [token]. */
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
  // No id or token in any decoded part: the segment is returned EXACTLY as it
  // came (still encoded, never decoded bytes), as before this boundary.
  if (!decoded.split(SEPARATOR).some(holdsId)) {
    return segment;
  }
  const out = redactIdSegment(decoded);
  // Post-check: a changed segment may never carry URL syntax or escapes.
  return /[?#@%\s]/.test(out) ? "[token]" : out;
}

/** A retained query or attribution VALUE (#828 G-07/G-26, Codex P1
 *  4309025843): percent-decoded to a fixed point (bounded), then every record
 *  id (a dashed UUID, anywhere in the value) becomes [id]; the rest of the
 *  value is kept, so attribution still works ("spring-<uuid>" becomes
 *  "spring-[id]"). Only UUIDs, not digit runs or long tokens: campaign values
 *  legitimately hold years ("spring 2026") and ad-platform click ids, and
 *  Hone's record ids are UUIDs. Fail closed: an undecodable or still-encoded
 *  value becomes [token]. The caller re-encodes the result, so decoded text
 *  never rebuilds URL syntax. */
/** Percent-decode to a fixed point (bounded); null when undecodable or still
 *  encoded after the bound. Decide on the DECODED value, never on a raw-text
 *  signal (Codex 4309069522: "%36f1…" hid a UUID from a raw check). */
export function decodeBounded(value: string): string | null {
  let decoded = value;
  for (let i = 0; i < MAX_DECODE_ROUNDS && ENCODED.test(decoded); i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) break;
    decoded = next;
  }
  return ENCODED.test(decoded) ? null : decoded;
}

export function redactIdsInValue(value: string): string {
  const decoded = decodeBounded(value);
  if (decoded === null) return "[token]";
  // replace() (not .test() on the global regex, whose lastIndex would carry
  // over between calls and skip a match).
  const redacted = decoded.replace(EMBEDDED_UUID, "[id]");
  return redacted === decoded ? value : redacted;
}

/** A URL pathname with every id-bearing segment replaced. */
export function redactIdsInPath(pathname: string): string {
  return pathname.split("/").map(redactEncodedSegment).join("/");
}
