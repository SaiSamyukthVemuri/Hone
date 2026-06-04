import type { NextConfig } from "next";

// PR #142. Privacy headers for the token-bearing public routes.
//
// Why these specific headers on these specific prefixes:
//
//   X-Robots-Tag: noindex, nofollow
//     Blocks crawlers from indexing the URL even if a referrer or a
//     misconfigured share link exposes the token. Pages also set the
//     equivalent <meta robots> via Metadata.robots in each token
//     page.tsx; this header covers the route-handler tree
//     (/calendar-feed/[token]/route.ts) which has no HTML head.
//
//   Referrer-Policy: no-referrer
//     The token is part of the URL path. If a logged-out user clicks
//     an outbound link from the token page (footer link to /terms or
//     /privacy, etc.), the browser would otherwise send the token URL
//     as the Referer header to the destination. no-referrer strips
//     that exposure for every outbound request initiated from this
//     subtree, including XHR/fetch and document navigations.
//
// The matching prefixes mirror the React tree token routes plus the
// /calendar-feed/[token]/route.ts route handler. Any future
// token-bearing public route MUST be added here AND must not opt
// into SafeAnalytics.
const TOKEN_ROUTE_PATTERNS = [
  "/portal/verify/:token*",
  "/cancel/:token*",
  "/reschedule/:token*",
  "/manage/:token*",
  "/intake/:token*",
  "/calendar-feed/:token*",
];

const nextConfig: NextConfig = {
  async headers() {
    return TOKEN_ROUTE_PATTERNS.map((source) => ({
      source,
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    }));
  },
};

export default nextConfig;
