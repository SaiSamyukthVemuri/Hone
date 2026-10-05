// SENTRY-FETCH-01. What it means when a Server Action invocation REJECTS because
// the browser could not complete the request.
//
// This module is deliberately CLIENT-SAFE: client components import it. It holds
// one pure decision and no data access.
//
// Where the rejection comes from
// ------------------------------
// A Server Action is a POST issued by Next's client router (`fetchServerAction`:
// `fetch(state.canonicalUrl, { method: "POST", ... })`). When that request
// cannot complete (the connection drops, the device changes network, a proxy or
// an extension refuses it) the browser rejects `fetch` with its OWN TypeError,
// and Next hands that rejection, unchanged, to whichever component invoked the
// action. The server never answered, so nothing server-side recorded or reported
// it. Each engine words it differently:
//
//   Chromium   "Failed to fetch"
//   WebKit     "Load failed"
//   Gecko      "NetworkError when attempting to fetch resource."
//
// Sentry's fetch instrumentation appends " (<host>)" to exactly these messages
// when the request URL is absolute (@sentry/core `enhanceFetchErrorMessages`,
// default "always"). A Server Action posts to a relative URL, so today the
// message arrives bare, but the decision below must not depend on that.
//
// Why this needs a decision at all
// --------------------------------
// The outcome of such a request is UNKNOWN, not failed: the server may have run
// the action and the response was lost. A caller that discards the promise turns
// that into an unhandled rejection, which Sentry reports as an unhandled crash
// (`TypeError: Failed to fetch`, mechanism onunhandledrejection) with no Hone
// frame in its stack. A caller that awaits it inside a transition without a
// catch hands it to the route error boundary, which replaces the whole page and
// tells the practitioner the PAGE failed to load.
//
// What this does NOT decide
// -------------------------
// Whether a lost request is acceptable. That belongs to each caller, and depends
// on what the write is. A best-effort UI pointer may absorb it, because the next
// server render is authoritative. A payment, a settlement or a sign-out must not:
// its outcome is the thing the person needs to know.
//
// Everything that is NOT the browser's transport failure stays loud: a Server
// Component error (an Error carrying a digest), Next's UnrecognizedActionError
// (a tab left open across a deploy), a response that could not be decoded, or a
// bug. Those are re-thrown untouched.

const TRANSPORT_FAILURE_MESSAGE =
  /^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.)(?: \([^()]*\))?$/;

/**
 * True only for the browser's own "the request could not complete" rejection
 * of a fetch-based call: a TypeError with one engine's exact network-failure
 * message (optionally carrying Sentry's appended host).
 */
export function isServerActionTransportFailure(error: unknown): boolean {
  return (
    error instanceof TypeError && TRANSPORT_FAILURE_MESSAGE.test(error.message)
  );
}

/**
 * Rejection handler for a BEST-EFFORT Server Action write: absorbs the
 * transport failure, re-throws anything else unchanged.
 *
 * Use it only where losing the write is harmless because the server stays the
 * authority on the next render. Re-throwing from a `.catch` handler rejects the
 * derived promise with the same value, so a genuine failure is reported exactly
 * as it was before this handler existed.
 */
export function absorbTransportFailure(error: unknown): void {
  if (!isServerActionTransportFailure(error)) throw error;
}
