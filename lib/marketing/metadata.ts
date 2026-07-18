import type { Metadata } from "next";
import { MARKETING_PAGES } from "./content";

// Builds per-page Next.js metadata from the single source of truth
// (MARKETING_PAGES). One helper so titles, descriptions, canonicals, and OG all
// stay in sync across every marketing page (prompt §21/§22).
//
// Preview safety (§21 + addendum §9): non-production deployments are noindex /
// nofollow. Only VERCEL_ENV==="production" is allowed to be indexable. The
// production canonical/metadataBase come from app/layout.tsx (https://hone.care).
export function marketingMetadata(path: string): Metadata {
  const page = MARKETING_PAGES.find((p) => p.path === path);
  const isProd = process.env.VERCEL_ENV === "production";

  const indexable = page?.indexable ?? false;
  const robots = isProd
    ? { index: indexable, follow: true }
    : { index: false, follow: false };

  // Policy pages (privacy/terms) own their own title/description; give them a
  // canonical + preview-safe robots only.
  if (!page || !page.title || !page.description) {
    return { alternates: { canonical: path }, robots };
  }

  return {
    title: { absolute: page.title },
    description: page.description,
    alternates: { canonical: path },
    robots,
    openGraph: {
      type: "website",
      url: path,
      siteName: "Hone",
      locale: "en_CA",
      title: page.title,
      description: page.description,
    },
    twitter: {
      card: "summary_large_image",
      title: page.title,
      description: page.description,
    },
  };
}
