// Central origin helper for all server-side link generation.
//
// Resolution order (callers MUST not duplicate this logic):
//
//   1. NEXT_PUBLIC_APP_ORIGIN, if set and non-empty. Production must
//      always set this (e.g. https://hone.care). Trailing slash is
//      normalized away so callers can string-concat with /path safely.
//   2. VERCEL_URL, on Preview deployments. Vercel populates this with
//      the unique per-deploy hostname (NOT the production hostname),
//      so emails sent from a Preview deploy point back to that
//      deploy's URL, never to production.
//   3. http://localhost:3000, only when NODE_ENV !== "production".
//   4. Throw: production with no NEXT_PUBLIC_APP_ORIGIN is a config
//      error. Failing closed (a 500 on the action that needs the
//      origin) is preferable to silently sending a wrong-domain link
//      to a real client.
//
// What this helper deliberately does NOT do:
//   * No fallback to https://hone.care in production. Hardcoding the
//     canonical hostname here would mask a missing env in a misconfigured
//     deploy (which is exactly the situation the helper exists to catch).
//   * No URL validity check beyond normalization. The env var is set by
//     the operator; if it is garbage, the resulting links will be
//     visibly wrong and the operator will notice on the first send.
//   * No async/awaitable shape. Callers can use this from server
//     actions, route handlers, and React server components without
//     plumbing.
//
// Companion: lib/stripe/server.ts exports getAppOrigin() as a thin
// wrapper around this function so existing Stripe imports keep
// working. New callers should import getRequiredAppOrigin directly
// from here.

function normalizeOrigin(raw: string): string {
  return raw.replace(/\/+$/, "");
}

export function getRequiredAppOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_ORIGIN;
  if (explicit && explicit.length > 0) {
    return normalizeOrigin(explicit);
  }

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.length > 0) {
    return normalizeOrigin(`https://${vercelUrl}`);
  }

  if (process.env.NODE_ENV !== "production") {
    return "http://localhost:3000";
  }

  throw new Error(
    "NEXT_PUBLIC_APP_ORIGIN is required in production. " +
      "Set it to https://hone.care (or the appropriate canonical hostname).",
  );
}
