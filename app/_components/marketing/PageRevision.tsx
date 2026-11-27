import { Container } from "@/app/_components/marketing/primitives";
import { PAGE_REVISIONS, type RevisedPagePath } from "@/lib/marketing/page-revisions";

// "Last updated <date>" for a maintained marketing page. The date is the constant in lib/marketing/page-revisions.ts, never the build or request date.
function fmt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

export function PageRevision({ path }: { path: RevisedPagePath }) {
  const iso = PAGE_REVISIONS[path];
  return (
    <Container>
      <p className="pb-8 text-[0.875rem] text-muted" data-testid="page-revision">
        Last updated <time dateTime={iso}>{fmt(iso)}</time>
      </p>
    </Container>
  );
}
