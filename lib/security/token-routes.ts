// The single canonical registry of token-bearing public route families.
//
// F-PRIV-001. These six route families carry a REPLAYABLE BEARER CREDENTIAL as
// a dynamic path segment: possession of the URL is possession of the
// authorization. That makes the path itself secret material, which is a
// different problem from the query string — and one that `sendDefaultPii:false`
// does not touch, because the URL is not PII, it is a credential.
//
// Two independent consumers need this list and MUST NOT drift apart:
//
//   1. next.config.ts — applies stricter privacy headers (Referrer-Policy:
//      no-referrer, X-Robots-Tag) so the credential is not handed to a third
//      party in a Referer header or indexed by a crawler.
//   2. lib/observability/sentry-scrub.ts — canonicalizes the credential out of
//      every telemetry string before an event leaves the process.
//
// A route protected by only one of those is still leaking. Rather than two
// lists and a comment promising they stay in step, both import THIS module, and
// tests/lib/security/token-route-parity.test.ts fails if a family is missing
// from either consumer.
//
// PURE and ISOMORPHIC by contract: no server-only imports, no environment
// reads, no framework runtime dependency, no I/O. next.config.ts (build), the
// browser bundle, the Node runtime, the edge runtime and tests all import it.

/** Path prefixes that precede a bearer credential segment. No trailing slash. */
export const TOKEN_ROUTE_PREFIXES = [
  "/portal/verify",
  "/cancel",
  "/reschedule",
  "/manage",
  "/intake",
  "/calendar-feed",
] as const;

export type TokenRoutePrefix = (typeof TOKEN_ROUTE_PREFIXES)[number];

/** Next.js header `source` patterns. `:token*` is a catch-all: it covers the
 *  credential AND any suffix segments after it, which matters because
 *  /intake/<token>/step/2 is just as replayable as /intake/<token>. */
export const TOKEN_ROUTE_PATTERNS: string[] = TOKEN_ROUTE_PREFIXES.map(
  (prefix) => `${prefix}/:token*`,
);

/** What replaces the credential. A FIXED string — deliberately not a hash, not
 *  a fingerprint, not a truncation. A stable hash of a bearer token is still a
 *  correlatable identifier for that token, and a prefix/suffix is a brute-force
 *  head start; neither is acceptable here. Matches the scrubber's placeholder
 *  so a canonicalized path is indistinguishable from any other redaction. */
export const TOKEN_PLACEHOLDER = "[Redacted]";

// Characters that terminate a URL inside free-form diagnostic text. Everything
// else is consumed as part of the credential, including `?` and `#`, so the
// query string and fragment of a token URL cannot survive.
//
// `]` and `}` are deliberately NOT terminators. The placeholder itself contains
// `]`; if it terminated a match, canonicalizing an already-canonical string
// would append a second placeholder and idempotence would break.
const URL_TERMINATORS = "\\s\"'`<>(),;";

// One alternation over the prefixes, longest first so /portal/verify is tried
// before any shorter prefix that could share a head. Each prefix must be
// followed by `/`, so sibling routes like /intake-forms/123 are untouched.
const TOKEN_PATH_RE = new RegExp(
  `(${[...TOKEN_ROUTE_PREFIXES]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})/[^${URL_TERMINATORS}]*`,
  "gi",
);

/**
 * Replace the credential in every token-bearing path found in `input`.
 *
 *   https://hone.care/intake/RAW?x=1#frag  ->  https://hone.care/intake/[Redacted]
 *   GET /portal/verify/RAW/step/2          ->  GET /portal/verify/[Redacted]
 *   /intake/[token]                        ->  /intake/[Redacted]
 *
 * Properties this function guarantees, all covered by tests:
 *   * IDEMPOTENT — sanitize(sanitize(x)) === sanitize(x).
 *   * CREDENTIAL-SHAPE INDEPENDENT — it keys off the ROUTE, never off JWT
 *     syntax, length, alphabet or prefix, so an opaque random string is caught
 *     exactly like a structured one. This is the whole point: the existing
 *     JWT/Bearer patterns cannot see an arbitrary opaque credential.
 *   * SUFFIX-COMPLETE — consumes trailing path segments, query and fragment,
 *     mirroring the `:token*` catch-all the header registry uses.
 *   * ROUTE-SCOPED — unrelated identifiers (/clients/<id>, /calendar/<id>) are
 *     left intact, so diagnostics stay useful.
 *   * NON-THROWING — pure regex replacement; it never parses a URL, so a
 *     malformed one cannot throw, and it never decodes percent-encoding, so it
 *     cannot re-emit a decoded secret.
 *
 * The route family and origin are intentionally PRESERVED. Knowing an error
 * happened on /intake is useful and is not a credential.
 */
export function canonicalizeTokenPaths(input: string): string {
  return input.replace(
    TOKEN_PATH_RE,
    (_match, prefix: string) => `${prefix}/${TOKEN_PLACEHOLDER}`,
  );
}
