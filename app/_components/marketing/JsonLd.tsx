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
    <Container className="pt-5">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-muted">
          {items.map((it, i) => {
            const last = i === items.length - 1;
            return (
              <li key={it.path} className="flex items-center gap-2">
                {last ? (
                  <span aria-current="page" className="text-ink">
                    {it.name}
                  </span>
                ) : (
                  <Link href={it.path} className="hover:text-mineral">
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
