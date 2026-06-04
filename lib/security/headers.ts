// Global HTTP security header baseline (PR #150).
//
// Pure functions that produce the header lists Next applies in
// next.config.ts. Kept in a separate file so the header builder is
// testable without importing the Next config (vitest can call it
// directly).
//
// What this baseline IS
// ---------------------
// First-pass enforced CSP plus the standard cross-cutting browser
// security headers. Designed to ship without breaking Stripe Elements,
// Supabase browser calls, Next hydration, or Vercel Analytics. The
// CSP intentionally keeps 'unsafe-inline' (Next inlines small RSC
// hydration scripts; Tailwind injects style attributes). The CSP
// intentionally keeps 'unsafe-eval' in development for Next HMR.
//
// What this baseline is NOT
// -------------------------
// * Not a nonce-based CSP. That is a deliberate follow-up PR.
// * Not a report-only path. A future PR may add
//   Content-Security-Policy-Report-Only with a report endpoint to
//   collect violations before tightening further.
// * Not a Sentry-aware policy. Sentry is NOT installed; do NOT add
//   *.ingest.sentry.io to any source list.

export type SecurityHeader = { key: string; value: string };

export type SecurityHeaderEnv = "production" | "development";

export type BuildSecurityHeadersArgs = {
  env: SecurityHeaderEnv;
  // The fully-qualified Supabase project URL the browser actually
  // calls (REST + realtime). Derived from NEXT_PUBLIC_SUPABASE_URL
  // at next.config.ts evaluation time so the CSP scopes the source
  // to one host rather than a wildcard.
  //
  // When the env is missing at build, callers pass null and the
  // builder falls back to https://*.supabase.co with a comment in
  // the resulting policy. That fallback is wider than ideal; the
  // operator should set NEXT_PUBLIC_SUPABASE_URL in every
  // environment.
  supabaseUrl: string | null;
};

// Stripe Elements + Stripe.js requirements. Documented at:
// https://stripe.com/docs/security/guide#content-security-policy
const STRIPE_SCRIPT_SOURCES = ["https://js.stripe.com"];
const STRIPE_FRAME_SOURCES = [
  "https://js.stripe.com",
  "https://hooks.stripe.com",
];
const STRIPE_CONNECT_SOURCES = [
  "https://api.stripe.com",
  "https://r.stripe.com",
  "https://q.stripe.com",
];

// Vercel Analytics + Speed Insights script + beacon hosts.
const VERCEL_SCRIPT_SOURCES = ["https://va.vercel-scripts.com"];
const VERCEL_CONNECT_SOURCES = [
  "https://va.vercel-scripts.com",
  "https://vitals.vercel-insights.com",
];

// Tight Permissions-Policy. Every named browser capability that
// Hone does not currently use is explicitly empty `()`. A future
// feature that needs camera (e.g. in-portal photo capture) must
// deliberately loosen this entry.
const PERMISSIONS_POLICY_VALUE = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "bluetooth=()",
  "accelerometer=()",
  "gyroscope=()",
  "magnetometer=()",
  "interest-cohort=()",
].join(", ");

// HSTS one year + includeSubDomains + preload. Browsers ignore the
// header on plain HTTP so local dev over http://localhost is
// unaffected.
const HSTS_VALUE = "max-age=31536000; includeSubDomains; preload";

// Strict same-origin/cross-origin Referrer-Policy as the global
// default. Token routes override this back to `no-referrer` via the
// separate token block in next.config.ts (Next merges header blocks
// by source; the later block's same key wins).
const REFERRER_POLICY_VALUE = "strict-origin-when-cross-origin";

// Helper that emits the supabase connect-src token, falling back to
// the wildcard only when the env is missing.
function supabaseConnectSrcToken(supabaseUrl: string | null): string {
  if (!supabaseUrl || supabaseUrl.length === 0) {
    return "https://*.supabase.co";
  }
  // Pull just the origin so we never include a path component in
  // the CSP value. URL constructor would throw on a malformed
  // string; we accept the throw at build time so a misconfigured
  // env fails loudly rather than producing a broken policy.
  try {
    const u = new URL(supabaseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "https://*.supabase.co";
  }
}

export function buildContentSecurityPolicy(
  args: BuildSecurityHeadersArgs,
): string {
  const isDev = args.env === "development";

  // script-src: keep 'unsafe-inline' for Next's inline RSC hydration
  // payload. Add 'unsafe-eval' only in dev for HMR; production
  // builds do not need it. Never include data: in script-src.
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    ...(isDev ? ["'unsafe-eval'"] : []),
    ...STRIPE_SCRIPT_SOURCES,
    ...VERCEL_SCRIPT_SOURCES,
  ];

  // style-src: 'unsafe-inline' kept for Tailwind's inline style
  // attributes and Stripe Elements' inline styling. Not tightened
  // in this baseline.
  const styleSrc = ["'self'", "'unsafe-inline'"];

  // img-src: pragmatic on https + data + blob. Tightening to
  // specific hosts is a follow-up if a future PR sets up an
  // image proxy.
  const imgSrc = ["'self'", "data:", "blob:", "https:"];

  // font-src: next/font/google self-hosts the font assets at
  // /_next/static/media/ at build time, so the browser never
  // fetches from fonts.gstatic.com at runtime. Confirmed by the
  // PR #150 audit. data: allows fonts inlined into stylesheets.
  const fontSrc = ["'self'", "data:"];

  // connect-src: same-origin server actions, Supabase REST +
  // realtime websocket, Stripe API + analytics, Vercel
  // Analytics/Speed Insights beacons.
  const connectSrc = [
    "'self'",
    supabaseConnectSrcToken(args.supabaseUrl),
    ...STRIPE_CONNECT_SOURCES,
    ...VERCEL_CONNECT_SOURCES,
  ];

  // frame-src: Stripe Elements + 3DS challenge frames.
  const frameSrc = [...STRIPE_FRAME_SOURCES];

  // worker-src: Next sometimes spawns a blob URL worker.
  const workerSrc = ["'self'", "blob:"];

  // manifest-src: PWA manifest if added later.
  const manifestSrc = ["'self'"];

  // media-src: audio/video (none today; future-proofed).
  const mediaSrc = ["'self'", "blob:", "data:"];

  const directives: Array<[string, string[] | null]> = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    ["script-src", scriptSrc],
    ["style-src", styleSrc],
    ["img-src", imgSrc],
    ["font-src", fontSrc],
    ["connect-src", connectSrc],
    ["frame-src", frameSrc],
    ["worker-src", workerSrc],
    ["manifest-src", manifestSrc],
    ["media-src", mediaSrc],
    // upgrade-insecure-requests is a directive with no value.
    ["upgrade-insecure-requests", null],
  ];

  return directives
    .map(([name, sources]) =>
      sources === null ? name : `${name} ${sources.join(" ")}`,
    )
    .join("; ");
}

// Headers applied to every route (/:path*). Token routes get an
// additional block layered AFTER this one in next.config.ts; Next
// merges header blocks by `source` and the later same-key wins, so
// Referrer-Policy on token routes can override the global default
// to `no-referrer`.
export function buildGlobalSecurityHeaders(
  args: BuildSecurityHeadersArgs,
): SecurityHeader[] {
  return [
    { key: "Strict-Transport-Security", value: HSTS_VALUE },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: REFERRER_POLICY_VALUE },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY_VALUE },
    {
      key: "Content-Security-Policy",
      value: buildContentSecurityPolicy(args),
    },
  ];
}

// Headers applied to token-bearing public routes only. Preserves the
// PR #142 token-route privacy headers and ensures the global
// Referrer-Policy is overridden back to no-referrer for these
// subtrees.
export function buildTokenRoutePrivacyHeaders(): SecurityHeader[] {
  return [
    { key: "X-Robots-Tag", value: "noindex, nofollow" },
    { key: "Referrer-Policy", value: "no-referrer" },
  ];
}
