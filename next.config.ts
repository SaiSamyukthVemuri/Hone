import type { NextConfig } from "next";
import {
  buildGlobalSecurityHeaders,
  buildTokenRoutePrivacyHeaders,
} from "./lib/security/headers";

// PR #142. Token route privacy header prefixes. Listed once here
// because two header blocks in next.config.ts reference the same
// list:
//
//   1. The implicit global block (source: "/:path*") applies the
//      PR #150 enforced CSP, HSTS, X-Frame-Options, etc.
//   2. The explicit token-route block (sources in
//      TOKEN_ROUTE_PATTERNS) layers on top with stricter
//      Referrer-Policy: no-referrer and X-Robots-Tag.
//
// Next merges header blocks by `source` and the LATER block's same
// key overrides the earlier one. The token-route block must stay
// declared AFTER the global block in the returned array.
//
// Any new token-bearing public route MUST be added to this list
// AND must not opt into SafeAnalytics (PR #142).
const TOKEN_ROUTE_PATTERNS = [
  "/portal/verify/:token*",
  "/cancel/:token*",
  "/reschedule/:token*",
  "/manage/:token*",
  "/intake/:token*",
  "/calendar-feed/:token*",
];

// PR #150. Resolve the Supabase URL from build-time env so the CSP
// connect-src can scope to the specific project host rather than a
// wildcard. NEXT_PUBLIC_SUPABASE_URL is required in every Hone
// environment (the app's browser Supabase client also reads it), so
// a missing value here also indicates a misconfigured deploy. We
// still emit a working CSP by falling back to a wildcard in the
// builder; the operator should set the env.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;

const SECURITY_ENV =
  process.env.NODE_ENV === "production" ? "production" : "development";

const GLOBAL_SECURITY_HEADERS = buildGlobalSecurityHeaders({
  env: SECURITY_ENV,
  supabaseUrl: SUPABASE_URL,
});

const TOKEN_ROUTE_PRIVACY_HEADERS = buildTokenRoutePrivacyHeaders();

const nextConfig: NextConfig = {
  // PR #271: treatment image uploads (a server action) can be up to 15 MB
  // (TREATMENT_IMAGE_MAX_BYTES in lib/images/treatment-images.ts). The Next.js
  // default server-action body limit (~1 MB) would reject typical phone photos,
  // so raise the framework ceiling just above the validated cap. The action
  // still validates MIME + size server-side; this only lifts the limit.
  experimental: {
    serverActions: {
      bodySizeLimit: "16mb",
    },
  },
  // PostHog reverse proxy. Routes /ingest/* to the PostHog ingestion endpoint so
  // browser-side analytics calls stay on the same origin (avoids ad-blockers) and
  // the CSP connect-src 'self' entry covers all PostHog traffic without changes.
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
  async headers() {
    return [
      // Global block. Order: this MUST come first so the token-route
      // block below can override Referrer-Policy back to
      // no-referrer for token URLs.
      {
        source: "/:path*",
        headers: GLOBAL_SECURITY_HEADERS,
      },
      // Token-route block. Layered on top of the global block.
      // The Referrer-Policy: no-referrer entry here overrides the
      // global strict-origin-when-cross-origin for these subtrees.
      ...TOKEN_ROUTE_PATTERNS.map((source) => ({
        source,
        headers: TOKEN_ROUTE_PRIVACY_HEADERS,
      })),
    ];
  },
};

export default nextConfig;
