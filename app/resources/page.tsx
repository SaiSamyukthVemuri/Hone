import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "../_components/SafeAnalytics";
import { SiteHeader } from "../_components/marketing/SiteHeader";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
import { SiteFooter } from "../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Display,
  Subtitle,
  Lede,
} from "../_components/marketing/primitives";
import { Breadcrumbs } from "../_components/marketing/JsonLd";
import { WalkthroughCTA } from "../_components/marketing/sections";
import { RESOURCE_ARTICLES, RESOURCE_AUTHOR } from "@/lib/marketing/resources";
import { ANALYTICS_EVENTS } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Resource hub: /resources. Lists the shipped guides only (no "coming soon"
// filler). Authored by the real organization; each guide carries dates and an
// operational-information disclaimer.

export const metadata: Metadata = marketingMetadata("/resources");

export default function ResourcesPage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Resources", path: "/resources" },
        ]}
      />
      <main id="main-content" className="scroll-mt-16">
        <Container className="pt-[clamp(1.25rem,0.75rem+2vw,2.75rem)]">
          <Display className="max-w-[20ch]">
            Practical guides for running an electrolysis practice.
          </Display>
          <Lede className="mt-5 max-w-[38rem]">
            Operational guides from {RESOURCE_AUTHOR}, the people building Hone, on keeping
            good treatment records and moving a practice off paper. Practical, not
            promotional.
          </Lede>
        </Container>

        {/* A ruled list of guides, not a pair of white cards. Each entry is one
            link named by its title; nothing is appended to the label. */}
        <Container className="pb-[var(--mk-section-pad)] pt-[clamp(1.75rem,1rem+2vw,3rem)]">
          <ul className="grid gap-x-[clamp(2rem,4vw,4rem)] md:grid-cols-2">
            {RESOURCE_ARTICLES.map((a) => (
              <li key={a.slug} className="border-t border-[color:var(--color-hairline-strong)]">
                <Link
                  href={a.slug}
                  data-event={ANALYTICS_EVENTS.resourceCtaClick}
                  className="group flex h-full flex-col py-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]"
                >
                  <p className="text-[0.875rem] font-medium text-mineral">{a.readingTime}</p>
                  <Subtitle
                    as="h2"
                    className="mt-2 text-ink underline decoration-[color:var(--color-hairline-strong)] underline-offset-[6px] transition-colors duration-[var(--hone-duration-ui)] group-hover:text-mineral group-hover:decoration-[color:var(--color-mineral)]"
                  >
                    {a.title}
                  </Subtitle>
                  <p className="mt-3 max-w-[52ch] text-[1rem] leading-[1.6] text-muted">
                    {a.description}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </Container>

        <WalkthroughCTA
          title="Prefer to see it in the product?"
          body="We'll walk through how Hone handles booking, charting, treatment memory, and records on your real workflow, and reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
