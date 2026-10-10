import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "@/app/_components/SafeAnalytics";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
import { SiteHeader } from "@/app/_components/marketing/SiteHeader";
import { SiteFooter } from "@/app/_components/marketing/SiteFooter";
import {
  MarketingSurface, Container, Section, Eyebrow, Display,
} from "@/app/_components/marketing/primitives";
import { Breadcrumbs } from "@/app/_components/marketing/JsonLd";
import { CONTACT_PARAGRAPHS } from "@/lib/marketing/agent-content";
import { marketingMetadata } from "@/lib/marketing/metadata";
import { CONTACT_EMAIL } from "@/lib/marketing/content";

export const metadata: Metadata = marketingMetadata("/contact");

export default function ContactHonePage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs items={[{ name: "Home", path: "/" }, { name: "Contact", path: "/contact" }]} />
      <main id="main-content" className="scroll-mt-16">
        <Section>
          <Container size="prose">
            <Eyebrow>Company</Eyebrow>
            <Display className="mt-4">Contact Hone</Display>
            <div className="mt-8 space-y-6 text-[1.0625rem] leading-[1.7] text-ink">
              {CONTACT_PARAGRAPHS.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <p>
                General questions: <a className="text-mineral underline underline-offset-4" href={"mailto:" + CONTACT_EMAIL}>{CONTACT_EMAIL}</a>
              </p>
              <p>
                Privacy questions: <a className="text-mineral underline underline-offset-4" href="mailto:privacy@hone.care">privacy@hone.care</a>
              </p>
              <p>
                <Link className="text-mineral underline underline-offset-4" href="/demo">Request a walkthrough</Link>
                {" · "}
                <Link className="text-mineral underline underline-offset-4" href="/privacy">Privacy policy</Link>
              </p>
            </div>
          </Container>
        </Section>
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
