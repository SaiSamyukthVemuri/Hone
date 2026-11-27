import { MARKETING_PAGES, PRICING_FAQ } from "./content";
import { RESOURCE_ARTICLES } from "./resources";

// The public site's search index, built from the same constants that render the
// pages: MARKETING_PAGES (titles and descriptions), RESOURCE_ARTICLES (guide
// headlines) and the pricing FAQ. Nothing here is fetched and nothing is a
// query: the index is a plain array in the page's own bundle and the matcher
// below is a pure function over it. Page bodies and the policy text are not
// indexed (a later slice).

export type SearchEntry = {
  href: string;
  title: string;
  kind: "Page" | "Guide" | "Pricing question";
  /** Lowercase-searchable text shown under the title. */
  text: string;
};

// The policy pages own their own <title>, so MARKETING_PAGES has none for them.
const POLICY_TITLES: Record<string, string> = {
  "/privacy": "Privacy policy",
  "/terms": "Terms of service",
};

const siteTitle = (t: string) => t.replace(/\s*\|\s*Hone$/, "");

export function buildSearchIndex(): SearchEntry[] {
  const articles = new Map(RESOURCE_ARTICLES.map((a) => [a.slug, a]));
  const pages: SearchEntry[] = MARKETING_PAGES.filter((p) => p.indexable).map((p) => {
    const article = articles.get(p.path);
    if (article) return { href: p.path, title: article.title, kind: "Guide", text: article.description };
    return {
      href: p.path,
      title: p.title ? siteTitle(p.title) : (POLICY_TITLES[p.path] ?? p.path),
      kind: "Page",
      text: p.description ?? "",
    };
  });
  const faq: SearchEntry[] = PRICING_FAQ.map((f) => ({
    href: "/pricing#faq",
    title: f.q,
    kind: "Pricing question",
    text: f.a,
  }));
  return [...pages, ...faq];
}

const tokens = (q: string) => q.toLowerCase().split(/[^a-z0-9$%]+/).filter(Boolean);

/** Every word of the query must appear in the entry; a word in the title counts three times one in the text. Ties keep index order. */
export function searchEntries(entries: ReadonlyArray<SearchEntry>, query: string, limit = 8): SearchEntry[] {
  const words = tokens(query);
  if (words.length === 0) return [];
  const scored: { e: SearchEntry; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const title = e.title.toLowerCase();
    const text = e.text.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += 3;
      else if (text.includes(w)) score += 1;
      else return;
    }
    scored.push({ e, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map((s) => s.e);
}
