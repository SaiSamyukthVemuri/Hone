// Resource-article metadata — the single source of truth for authorship, dates,
// and the operational-information disclaimer (addendum §5). Consumed by the
// resource pages, the sitemap (truthful lastModified), and Article JSON-LD.
//
// Authorship is the real organization ("The Hone team"). No individual
// practitioner reviewer or credential is invented. Dates are the real
// publication/last-reviewed dates; update dateModified only on a real revision.

export type ResourceArticle = {
  slug: string; // canonical path
  title: string; // article H1 / headline (distinct from the SEO <title>)
  description: string;
  author: string;
  authorHref: string; // "about" link for the author
  datePublished: string; // ISO 8601
  dateModified: string; // ISO 8601 (last reviewed)
  readingTime: string;
};

export const RESOURCE_AUTHOR = "The Hone team" as const;
export const RESOURCE_AUTHOR_HREF = "/electrolysis-software" as const;

export const RESOURCE_ARTICLES: ReadonlyArray<ResourceArticle> = [
  {
    slug: "/resources/electrolysis-treatment-record-checklist",
    title: "What to record in an electrolysis treatment record",
    description:
      "A practical checklist of what to capture in an electrolysis treatment record, from client details and machine settings to probe lot and aftercare.",
    author: RESOURCE_AUTHOR,
    authorHref: RESOURCE_AUTHOR_HREF,
    datePublished: "2026-07-18",
    dateModified: "2026-07-18",
    readingTime: "6 min read",
  },
  {
    slug: "/resources/moving-an-electrolysis-practice-from-paper-records",
    title: "Moving an electrolysis practice from paper records",
    description:
      "How to move an electrolysis practice from paper treatment cards to structured digital records without losing client history.",
    author: RESOURCE_AUTHOR,
    authorHref: RESOURCE_AUTHOR_HREF,
    datePublished: "2026-07-18",
    dateModified: "2026-07-18",
    readingTime: "7 min read",
  },
] as const;

export function getResourceArticle(slug: string): ResourceArticle | undefined {
  return RESOURCE_ARTICLES.find((a) => a.slug === slug);
}

// Shown on every resource article. Operational information, not medical/legal
// advice; requirements vary by jurisdiction.
export const RESOURCE_DISCLAIMER =
  "This guide is operational information from the team building Hone — not medical or legal advice. Record-keeping and public-health requirements vary by jurisdiction, so always confirm what applies to your practice with your local regulatory or public-health authority." as const;
