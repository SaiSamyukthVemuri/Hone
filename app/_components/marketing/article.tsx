import Link from "next/link";
import type { ResourceArticle } from "@/lib/marketing/resources";
import { RESOURCE_DISCLAIMER } from "@/lib/marketing/resources";
import { CONTACT_EMAIL } from "@/lib/marketing/content";

function fmt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

/** Byline: real organizational author (linked), published + last-reviewed dates. */
export function ArticleByline({ article }: { article: ResourceArticle }) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.875rem] text-muted">
      <span>
        By{" "}
        <Link
          href={article.authorHref}
          rel="author"
          className="font-medium text-ink underline underline-offset-4 hover:text-mineral"
        >
          {article.author}
        </Link>
      </span>
      <span aria-hidden="true">·</span>
      <span>
        Published{" "}
        <time dateTime={article.datePublished}>{fmt(article.datePublished)}</time>
      </span>
      <span aria-hidden="true">·</span>
      <span>
        Last reviewed{" "}
        <time dateTime={article.dateModified}>{fmt(article.dateModified)}</time>
      </span>
      <span aria-hidden="true">·</span>
      <span>{article.readingTime}</span>
    </div>
  );
}

/** Operational-information disclaimer (not medical/legal advice). */
export function ArticleDisclaimer() {
  return (
    <aside
      className="mt-10 rounded-[10px] border border-[color:var(--color-hairline)] bg-warm p-5 text-[0.875rem] leading-[1.6] text-muted"
      role="note"
    >
      <p className="font-semibold text-ink">About this guide</p>
      <p className="mt-2">{RESOURCE_DISCLAIMER}</p>
    </aside>
  );
}

/** Corrections / contact mechanism. */
export function ArticleCorrections() {
  return (
    <p className="mt-6 text-[0.875rem] leading-[1.6] text-muted">
      Spotted something that needs a correction, or have a question? Email{" "}
      <Link
        href={`mailto:${CONTACT_EMAIL}`}
        className="font-medium text-mineral underline underline-offset-4"
      >
        {CONTACT_EMAIL}
      </Link>{" "}
      and we&apos;ll review it.
    </p>
  );
}
