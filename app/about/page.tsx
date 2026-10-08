import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "@/app/_components/SafeAnalytics";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
import { SiteHeader } from "@/app/_components/marketing/SiteHeader";
import { SiteFooter } from "@/app/_components/marketing/SiteFooter";
import {
  MarketingSurface, Container, Section, Eyebrow, Display,
} from "@/app/_components/marketing/primitives";
import { Breadcrumbs, JsonLd } from "@/app/_components/marketing/JsonLd";
import { ABOUT_PARAGRAPHS } from "@/lib/marketing/agent-content";
import { marketingMetadata } from "@/lib/marketing/metadata";
import { organizationLd } from "@/lib/marketing/jsonld";

export const metadata: Metadata = marketingMetadata("/about");

export default function AboutHonePage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs items={[{ name: "Home", path: "/" }, { name: "About", path: "/about" }]} />
      <main id="main-content" className="scroll-mt-16">
        <Section>
          <Container size="prose">
            <Eyebrow>Company</Eyebrow>
            <Display className="mt-4">About Hone</Display>
            <div className="mt-8 space-y-6 text-[1.0625rem] leading-[1.7] text-ink">
              {ABOUT_PARAGRAPHS.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <p>
                <Link className="text-mineral underline underline-offset-4" href="/demo">
                  Request a walkthrough
                </Link>
                {" · "}
                <Link className="text-mineral underline underline-offset-4" href="/contact">
                  Contact Hone
                </Link>
              </p>
            </div>
          </Container>
        </Section>
      </main>
      <JsonLd data={organizationLd()} />
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
