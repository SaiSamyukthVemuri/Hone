import Link from "next/link";
import { breadcrumbLd } from "@/lib/marketing/jsonld";
import { Container } from "./primitives";

/** Renders a JSON-LD <script>. `<` is escaped so it can't break out of the tag. */
export function JsonLd({ data }: { data: object }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

/**
 * Visible breadcrumb trail + matching BreadcrumbList JSON-LD (built from the
 * same items, so the two never diverge). The last item is the current page.
 */
export function Breadcrumbs({ items }: { items: { name: string; path: string }[] }) {
  return (
    // Links are 44px rows on touch and compact for a fine pointer (DESIGN LAWS 3
    // and 5); the row's own padding is trimmed to match, so the trail sits where
    // it did.
    <Container className="pt-2 pointer-fine:pt-4">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-muted">
          {items.map((it, i) => {
            const last = i === items.length - 1;
            return (
              <li key={it.path} className="flex items-center gap-2">
                {last ? (
                  <span aria-current="page" className="text-ink">
                    {it.name}
                  </span>
                ) : (
                  <Link
                    href={it.path}
                    className="-mx-1.5 inline-flex min-h-11 min-w-11 items-center justify-center px-1.5 hover:text-mineral pointer-fine:min-h-6 pointer-fine:min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]"
                  >
                    {it.name}
                  </Link>
                )}
                {last ? null : (
                  <span aria-hidden="true" className="text-[color:var(--color-hairline-strong)]">
                    /
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <JsonLd data={breadcrumbLd(items)} />
    </Container>
  );
}
