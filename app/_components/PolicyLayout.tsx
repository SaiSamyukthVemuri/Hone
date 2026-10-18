import type { ReactNode } from "react";
import { SiteHeader } from "@/app/_components/marketing/SiteHeader";
import { SiteFooter } from "@/app/_components/marketing/SiteFooter";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
import { SafeAnalytics } from "@/app/_components/SafeAnalytics";
import { MarketingSurface, Container, Display } from "@/app/_components/marketing/primitives";

// Shared shell for /privacy and /terms, and ONLY for them.
//
// THE SAME SHELL AS EVERY OTHER MARKETING PAGE (MKT-03 revision 2). These two
// pages rendered the older public header and footer, with a different nav (a
// "Records" link the rest of the site does not have), different type (Fraunces
// headings, Inter body) and a mobile menu whose closed dialog stayed focusable
// behind aria-hidden. A visitor reaching the policy from the marketing footer
// arrived on what looked like another site. They now use the marketing header,
// footer and type scale. THE POLICY TEXT IS NOT CHANGED: this file owns layout
// only, and every word a policy says lives in its own page.
//
// The older MarketingHeader/MarketingFooter are left exactly as they were: the
// booking, intake, portal and token routes still render them, and those are not
// marketing pages.
//
// LANDMARKS. The outer element was <main>, which put the header's <nav> and
// the footer's contentinfo INSIDE the main landmark — so "main" was the entire
// page, and a landmark jump or a skip link led nowhere useful. The shell is a
// plain wrapper; only the policy <article> sits in <main id="main-content">,
// which is the same shape every other marketing page uses.
export function PolicyLayout({
  title,
  effectiveDate,
  lastUpdated,
  children,
}: {
  title: string;
  effectiveDate: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <main id="main-content">
        <article className="pb-[var(--mk-section-pad)] pt-[clamp(1.25rem,0.75rem+1.25vw,2rem)]">
          <Container size="prose">
            <header>
              <Display>{title}</Display>
              <p className="mt-4 text-[0.9375rem] text-muted">
                <strong className="font-medium text-ink">Effective date:</strong>{" "}
                {effectiveDate}
                <span aria-hidden="true" className="mx-2 text-[color:var(--color-hairline-strong)]">
                  ·
                </span>
                <strong className="font-medium text-ink">Last updated:</strong> {lastUpdated}
              </p>
            </header>
            <div className="policy-body mt-8 flex flex-col gap-5 text-[1.0625rem] leading-[1.7] text-ink">
              {children}
            </div>
          </Container>
        </article>
      </main>
      <SiteFooter />
      {/* PR #142. PolicyLayout wraps the privacy + terms pages.
          Both are safe marketing routes (no bearer token in URL),
          so SafeAnalytics mounts here. Token routes never use
          PolicyLayout. */}
      <SafeAnalytics />
    </MarketingSurface>
  );
}

// Section headings carry a link to themselves, so a clause can be cited by URL.
// The link is a 44px row on touch (DESIGN LAW 5) with a visible outline focus.
const HEADING_LINK =
  "inline-flex min-h-11 items-center no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)] pointer-fine:min-h-0";

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-8 text-[clamp(1.375rem,1.25rem+0.6vw,1.75rem)] font-semibold leading-[1.25] tracking-[-0.015em] text-ink"
    >
      <a href={`#${id}`} className={HEADING_LINK}>
        {children}
      </a>
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="mt-3 text-[1.1875rem] font-semibold leading-[1.3] text-ink">
      <a href={`#${id}`} className={HEADING_LINK}>
        {children}
      </a>
    </h3>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="whitespace-pre-line">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="ml-6 flex list-disc flex-col gap-1.5">{children}</ul>;
}
