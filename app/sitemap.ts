import type { MetadataRoute } from "next";
import { CANONICAL_HOST, MARKETING_PAGES } from "@/lib/marketing/content";
import { RESOURCE_ARTICLES } from "@/lib/marketing/resources";

// Public sitemap — indexable marketing/policy pages only. Authenticated, portal,
// admin, API, and token routes are never listed. lastModified is set only where
// a real modification date exists (the resource articles); it is omitted
// elsewhere rather than fabricating a build-time freshness date (§21).
export default function sitemap(): MetadataRoute.Sitemap {
  const modified = new Map(RESOURCE_ARTICLES.map((a) => [a.slug, a.dateModified]));

  return MARKETING_PAGES.filter((p) => p.indexable).map((p) => {
    const url = p.path === "/" ? CANONICAL_HOST : `${CANONICAL_HOST}${p.path}`;
    const lastModified = modified.get(p.path);
    return lastModified ? { url, lastModified } : { url };
  });
}
