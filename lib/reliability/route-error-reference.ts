// REL-014. Safe, user-visible reference for a contained route failure.
//
// This module is deliberately CLIENT-SAFE (no `server-only`): it is imported by
// the authenticated route error boundary, which Next.js requires to be a client
// component. It therefore contains no secrets, no environment reads and no data
// access, only pure decisions about what a boundary may show and report.
//
// What Next.js actually hands an error boundary
// ---------------------------------------------
// `error.tsx` receives exactly `{ error, reset }`. Nothing else. For an error
// thrown on the SERVER (a loader, a Server Component render, a Server Action),
// React replaces the real error before it crosses to the browser:
//
//   resolveErrorProd() -> Error("An error occurred in the Server Components
//   render. The specific message is omitted in production builds to avoid
//   leaking sensitive details. ..."), stack = "Error: " + that message
//
// and then assigns `digest` from the server payload. The server-side digest is
// `stringHash(err.message + err.stack)` (djb2, >>> 0, base 10), optionally
// suffixed `@E<code>` when the thrown value carries Next's `__NEXT_ERROR_CODE`.
// It is a one-way hash of text we never show, so it is safe to display and it
// correlates to the server log / Sentry event for the same failure.
//
// Why the digest is still validated before display
// ------------------------------------------------
// `digest` is a plain property, not a guaranteed-shaped value:
//
//   * for a CLIENT-side error it is whatever (if anything) set it;
//   * Next respects a pre-existing `err.digest` rather than regenerating one,
//     so application code could put arbitrary text there;
//   * Next's own well-known digests are human-readable strings that carry
//     routing information, e.g. "NEXT_REDIRECT;replace;/login;307;" and
//     "NEXT_HTTP_ERROR_FALLBACK;404".
//
// Rendering `digest` unchecked would therefore be rendering untrusted text. So
// the boundary shows a reference ONLY when the value matches the shape Next
// actually produces for an unexpected error. Anything else (a URL, an address,
// a sentence, a redirect digest, an empty string) yields no reference at all,
// and the UI reads correctly without one. Fail closed: a missing reference is a
// small support inconvenience, a leaked one is a disclosure.

/**
 * The exact shape Next.js generates for an unexpected server error digest:
 * decimal digits, optionally followed by "@E" plus an internal error code.
 */
export const NEXT_ERROR_DIGEST_PATTERN = /^([0-9]{1,10})(@E[A-Za-z0-9]{1,16})?$/;

/**
 * Largest value Next can produce for the numeric part. The digest is
 * `stringHash(...)` which ends in `>>> 0`, so it is a uint32: 0 to 4294967295,
 * never more than ten digits and never zero-padded.
 *
 * The bound is load-bearing, not cosmetic. Because Next respects a
 * pre-existing `err.digest` instead of regenerating one, a numeric value that
 * Next could never have produced can arrive here. A wider digit allowance would
 * let, say, a 16-digit internal identifier or card-shaped number render into the
 * page as a "support reference". Anything outside the range Next can actually
 * emit is therefore not a digest, and is refused.
 */
export const MAX_NEXT_ERROR_DIGEST = 4294967295;

/**
 * The digest, if and only if it is safe to render to a user. `null` otherwise,
 * which callers must treat as "show no reference" (never "undefined", never a
 * manufactured substitute).
 */
export function safeErrorReference(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const trimmed = digest.trim();
  const match = NEXT_ERROR_DIGEST_PATTERN.exec(trimmed);
  if (!match) return null;
  const numeric = match[1];
  // Number.prototype.toString never zero-pads, so a padded value did not come
  // from Next and is refused rather than displayed.
  if (numeric.length > 1 && numeric.startsWith("0")) return null;
  if (Number(numeric) > MAX_NEXT_ERROR_DIGEST) return null;
  return trimmed;
}

/**
 * The `digest` property of a thrown value, read WITHOUT assuming the value is
 * an object.
 *
 * Next types an error boundary's prop as `Error & { digest?: string }`, but
 * that is a compile-time convenience, not a runtime guarantee: React hands the
 * boundary whatever was actually thrown, and `throw null` / `throw undefined` /
 * `throw "text"` are all legal. A bare `error.digest` would then raise a
 * TypeError inside the boundary's own render. That failure escapes to
 * global-error.tsx, and if it dereferences the same way it fails too, leaving
 * the user with a blank document: the boundary breaking exactly when it is
 * needed most.
 */
export function errorDigest(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  // The READ itself is guarded, not just the type. `digest` may be an accessor
  // that throws, or the value may be a revoked Proxy (`typeof` does not trap,
  // so it still reports "object" and the property access is what raises). Any
  // such throw would happen inside the boundary's own render, escalating a
  // contained failure into the global fallback, or breaking the global fallback
  // outright. There is no digest worth that, so an unreadable one is simply
  // absent.
  try {
    return (error as { digest?: unknown }).digest;
  } catch {
    return undefined;
  }
}

/**
 * Whether the CLIENT boundary should report this error to Sentry itself.
 *
 * Server-originated errors are already captured, with the real message and the
 * real stack, by `onRequestError = Sentry.captureRequestError` in
 * instrumentation.ts. Capturing them again from the browser would both
 * duplicate the event and degrade it: in production every server failure
 * arrives in the browser as the SAME elided placeholder message with a
 * synthetic one-line stack, so all of them would collapse into a single
 * meaningless Sentry issue. A retry that fails again would add another copy.
 *
 * A string `digest` is the marker that the server produced (and therefore
 * already reported) this error. Its absence means the error was raised in the
 * browser after hydration, which `onRequestError` never sees and which the
 * Sentry browser SDK does not auto-capture either: React hands a render error
 * to the nearest error boundary rather than to window.onerror, and no
 * console/react integration is configured. Those must still be reported, or
 * adding a boundary would silently delete client-side error reporting for the
 * whole authenticated app.
 */
export function shouldReportRouteErrorFromClient(error: unknown): boolean {
  // Reuses errorDigest rather than repeating the read, so the guarded
  // extraction cannot drift away from this decision path. An unreadable digest
  // is treated as absent, which errs toward REPORTING: a duplicate event is
  // recoverable, a silently dropped one is not.
  const digest = errorDigest(error);
  if (typeof digest !== "string") return true;
  return digest.trim().length === 0;
}
