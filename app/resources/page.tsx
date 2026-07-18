import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "../_components/SafeAnalytics";
import { SiteHeader } from "../_components/marketing/SiteHeader";
import { SiteFooter } from "../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Eyebrow,
  Display,
  Subtitle,
  Lede,
} from "../_components/marketing/primitives";
import { Reveal } from "../_components/marketing/Reveal";
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
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Resources", path: "/resources" },
        ]}
      />
      <main className="overflow-x-hidden">
        <Container className="pb-8 pt-8 lg:pt-10">
          <Reveal immediate>
            <Eyebrow>Resources</Eyebrow>
            <Display className="mt-4 max-w-3xl">
              Practical guides for running an electrolysis practice.
            </Display>
            <Lede className="mt-6 max-w-2xl">
              Operational guides from {RESOURCE_AUTHOR}, the people building Hone, on keeping
              good treatment records and moving a practice off paper. Practical, not
              promotional.
            </Lede>
          </Reveal>
        </Container>

        <Container className="pb-16">
          <ul className="grid gap-5 md:grid-cols-2">
            {RESOURCE_ARTICLES.map((a, i) => (
              <Reveal as="li" key={a.slug} delay={i * 70}>
                <Link
                  href={a.slug}
                  data-event={ANALYTICS_EVENTS.resourceCtaClick}
                  className="group flex h-full flex-col rounded-[12px] border border-[color:var(--color-hairline)] bg-white p-6 transition-colors hover:border-[color:var(--color-hairline-strong)]"
                >
                  <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-mineral">
                    Guide · {a.readingTime}
                  </p>
                  <Subtitle as="h2" className="mt-3 text-[1.25rem] group-hover:text-mineral">
                    {a.title}
                  </Subtitle>
                  <p className="mt-3 flex-1 text-[0.9375rem] leading-[1.6] text-muted">
                    {a.description}
                  </p>
                  <span className="mt-4 inline-block text-[0.875rem] font-medium text-mineral">
                    Read the guide →
                  </span>
                </Link>
              </Reveal>
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
