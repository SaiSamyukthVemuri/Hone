// Pure JSON-LD builders (no React) so structured data is unit-testable and can
// never drift from the visible content it is derived from. Rendered by the
// <JsonLd> component. No aggregateRating, no review, no fabricated data
// (addendum §7). Visible prices must equal the offer prices, both come from the
// same PRICING_PLANS source of truth.

import { CANONICAL_HOST, CONTACT_EMAIL, CURRENCY, MARKETING_PAGES, PRICING_PLANS } from "./content";
import type { ResourceArticle } from "./resources";

const abs = (path: string): string =>
  path === "/" ? CANONICAL_HOST : `${CANONICAL_HOST}${path}`;

/** Parse the numeric monthly price from a "CAD $29" label. */
export function priceValue(label: string): number {
  return Number(label.replace(/[^0-9.]/g, ""));
}

export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Hone",
    url: CANONICAL_HOST,
    description: "Electrolysis practice software with treatment memory, built for electrologists.",
    email: CONTACT_EMAIL,
    logo: `${CANONICAL_HOST}/icon`,
  };
}

export function webSiteLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Hone",
    url: CANONICAL_HOST,
  };
}

/** SoftwareApplication with an OfferCatalog of the published plans (CAD). */
/**
 * The homepage's own declared description, or a hard failure.
 *
 * THROWS RATHER THAN FALLING BACK. A silent `?? ""` would emit structured data
 * with an empty description if the route were ever renamed — invisible to every
 * test that only checks the shape, and read by search engines. The route is
 * declared in the same module, so its absence is a programming error and should
 * read like one.
 */
function homeDescription(): string {
  const home = MARKETING_PAGES.find((p) => p.path === "/");
  if (!home?.description) {
    throw new Error('jsonld: the "/" route has no declared description');
  }
  return home.description;
}

export function softwareApplicationLd() {
  const offers = PRICING_PLANS.filter((p) => p.priceLabel).map((p) => ({
    "@type": "Offer",
    name: p.name,
    price: priceValue(p.priceLabel as string),
    priceCurrency: CURRENCY,
    url: abs("/pricing"),
    category: "SubscriptionService",
  }));
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Hone",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: CANONICAL_HOST,
    // REUSES THE ROUTE'S OWN DESCRIPTION — deck §2: "OG description and JSON-LD
    // description reuse the description".
    //
    // THIS FILE'S HEADER ALREADY PROMISED THIS AND THE CODE DID NOT KEEP IT.
    // It says structured data "can never drift from the visible content it is
    // derived from", while this field held a SECOND, independently written
    // homepage description. That is exactly how it came to still emit retired
    // copy after the route metadata was updated: nothing compared the two. One
    // source now, so the drift is not merely fixed but unrepresentable.
    description: homeDescription(),
    offers: {
      "@type": "OfferCatalog",
      name: "Hone plans",
      itemListElement: offers,
    },
  };
}

export function breadcrumbLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: abs(it.path),
    })),
  };
}

export function articleLd(a: ResourceArticle) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: a.title,
    description: a.description,
    datePublished: a.datePublished,
    dateModified: a.dateModified,
    author: { "@type": "Organization", name: a.author, url: abs(a.authorHref) },
    publisher: {
      "@type": "Organization",
      name: "Hone",
      logo: { "@type": "ImageObject", url: `${CANONICAL_HOST}/icon` },
    },
    mainEntityOfPage: abs(a.slug),
  };
}

/** FAQPage, must be built from the SAME questions shown visibly on the page. */
export function faqPageLd(faq: { q: string; a: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}
