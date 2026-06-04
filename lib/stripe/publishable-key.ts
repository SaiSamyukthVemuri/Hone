// PR #135. Publishable-key gate that mirrors the secret-key gate in
// lib/stripe/server.ts. Both server-side calls (for safe-render hints)
// and the portal client component import the resolver below; never
// log the key itself.
//
// Acceptance matrix:
//
//   VERCEL_ENV         | key prefix | STRIPE_ALLOW_LIVE_MODE | result
//   ----------------   | ---------- | --------------------- | -------------
//   production         | pk_test_   | (any)                 | accepted
//   production         | pk_live_   | "true"                | accepted
//   production         | pk_live_   | (anything else)       | unavailable
//   preview/development| pk_test_   | (any)                 | accepted
//   preview/development| pk_live_   | (any)                 | unavailable
//   (no vercel env)    | pk_test_   | (any)                 | accepted
//   (no vercel env)    | pk_live_   | "true"                | accepted
//   (no vercel env)    | pk_live_   | (anything else)       | unavailable
//   any                | (other prefix or empty)             | unavailable
//
// "unavailable" means the portal Add card UI shows a calm
// "Card-on-file is not configured yet" message instead of mounting
// Stripe Elements. The portal NEVER crashes when the env var is
// missing or invalid.

export type PublishableKeyResolution =
  | { ok: true; key: string }
  | { ok: false; reason: "missing" | "live_mode_blocked" | "invalid_prefix" };

function isPreviewOrDev(): boolean {
  const env = process.env.VERCEL_ENV;
  return env === "preview" || env === "development";
}

function liveModeExplicitlyEnabled(): boolean {
  return process.env.STRIPE_ALLOW_LIVE_MODE === "true";
}

// Resolve the publishable key. Returns a discriminated union so the
// caller can choose between "show Elements" and "show the calm
// unavailable message" without ever exposing a misconfigured key to
// the browser bundle. The "ok:true" path returns the key string for
// loadStripe(); the "ok:false" path keeps the key off the wire.
export function resolveStripePublishableKey(): PublishableKeyResolution {
  const raw = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!raw || raw.length === 0) {
    return { ok: false, reason: "missing" };
  }
  const isTest = raw.startsWith("pk_test_");
  const isLive = raw.startsWith("pk_live_");
  if (!isTest && !isLive) {
    return { ok: false, reason: "invalid_prefix" };
  }
  if (isLive && !liveModeExplicitlyEnabled()) {
    return { ok: false, reason: "live_mode_blocked" };
  }
  if (isLive && isPreviewOrDev()) {
    return { ok: false, reason: "live_mode_blocked" };
  }
  return { ok: true, key: raw };
}

// Convenience boolean. Useful for portal Server Components that
// want to branch on availability without surfacing the key itself.
export function isStripePublishableKeyAvailable(): boolean {
  return resolveStripePublishableKey().ok;
}
