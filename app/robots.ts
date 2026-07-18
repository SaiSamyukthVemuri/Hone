import type { MetadataRoute } from "next";
import { CANONICAL_HOST } from "@/lib/marketing/content";

// robots — production allows crawling of the public marketing site and points to
// the sitemap; non-production (preview/development) disallows everything so
// preview deployments are not indexed (reinforcing the per-page noindex in
// marketingMetadata). robots is a crawl directive, not a security control.
export default function robots(): MetadataRoute.Robots {
  const isProd = process.env.VERCEL_ENV === "production";

  if (!isProd) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/admin/",
          "/portal",
          "/settings/",
          "/dashboard",
          "/clients",
          "/calendar",
          "/calendar-feed/",
          "/records",
          "/intake/",
          "/cancel/",
          "/reschedule/",
          "/manage/",
          "/getting-started",
          "/notifications",
          "/login",
          "/no-access",
          "/auth/",
          // Sentry integration test page (temporary; removed before merge).
          // Belt-and-suspenders noindex for the window it exists.
          "/sentry-example-page",
        ],
      },
    ],
    sitemap: `${CANONICAL_HOST}/sitemap.xml`,
    host: CANONICAL_HOST,
  };
}
