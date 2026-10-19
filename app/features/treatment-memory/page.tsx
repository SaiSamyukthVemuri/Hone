import type { Metadata } from "next";
import { SafeAnalytics } from "../../_components/SafeAnalytics";
import { SiteHeader } from "../../_components/marketing/SiteHeader";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
import { SiteFooter } from "../../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Section,
  Display,
  Title,
  Lede,
  CTAButton,
} from "../../_components/marketing/primitives";
import { Breadcrumbs } from "../../_components/marketing/JsonLd";
import { TreatmentMemoryPanel } from "../../_components/marketing/visuals/TreatmentMemoryPanel";
import { WalkthroughCTA, RelatedLinks, FeatureMatrix } from "../../_components/marketing/sections";
import { WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Feature: /features/treatment-memory. Intent: treatment memory / returning-
// client context for electrologists. The category-defining differentiator.
// Every capability here is LIVE (imported memory is guided-setup, labelled).

export const metadata: Metadata = marketingMetadata("/features/treatment-memory");

const CAPABILITIES: { title: string; body: string }[] = [
  {
    title: "The Before Today briefing",
    body: "Open a returning client and Hone builds a briefing from what you charted: the last treatment's areas and settings, the probe lot, how the client responded and what to record today.",
  },
  {
    title: "From last visit, for today",
    body: "Cautions you flag and the plan you leave for next time come back on their own, on the client's last-visit card and in the new-session panel.",
  },
  {
    title: "A for-next-visit note",
    body: "Leave a short plan at the end of a session and Hone puts it in front of you before the next appointment.",
  },
  {
    title: "Memory per treatment area",
    body: "Each treated area keeps its own findable history. Every visit shows the settings, probe, tolerance and response recorded for the settings block it was treated under, so a multi-area session stays readable.",
  },
  {
    title: "Record-gap reminders",
    body: "Hone points out incomplete records, such as a missing probe lot, aftercare not marked or a completed appointment not yet charted, on the client card and in a dashboard follow-up list. The checks follow fixed rules and use no AI.",
  },
  {
    title: "Imported history, clearly labelled",
    body: "During guided onboarding, bring history over from paper cards, a spreadsheet or another tool. It appears in the Before Today briefing marked as imported, kept apart from what you chart in Hone.",
  },
];

export default function TreatmentMemoryPage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Electrolysis software", path: "/electrolysis-software" },
          { name: "Treatment memory", path: "/features/treatment-memory" },
        ]}
      />
      <main id="main-content" className="scroll-mt-16">
        <Container className="grid items-start gap-x-[clamp(2.5rem,5vw,5rem)] gap-y-10 pb-[var(--mk-section-pad)] pt-[clamp(1rem,0.5rem+1.25vw,1.75rem)] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div>
            <Display className="max-w-[18ch]">
              See the last treatment before the client sits down
            </Display>
            <Lede className="mt-5 max-w-[38rem]">
              Hone carries the details that shape a returning client&apos;s session from one
              appointment to the next, built from what you have already charted.
            </Lede>
            <CTAButton
              href={WALKTHROUGH.href}
              event={ANALYTICS_EVENTS.primaryCtaClick}
              className="mt-7 max-sm:w-full"
            >
              {WALKTHROUGH.primaryLabel}
            </CTAButton>
          </div>
          <TreatmentMemoryPanel />
        </Container>

        <Section tone="warm">
          <Container>
            <Title className="max-w-2xl">What Hone brings forward</Title>
            <FeatureMatrix items={CAPABILITIES} />
          </Container>
        </Section>

        <Section tone="paper">
          <Container className="grid gap-x-[clamp(2rem,5vw,5rem)] gap-y-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.7fr)]">
            <div>
              <Title>Each appointment starts from the last one</Title>
            </div>
            <div className="max-w-[64ch]">
              <Lede>
                Electrolysis takes a course of treatments. When what worked lives on a paper card
                or in your memory, you rebuild it at every visit. Hone keeps it in the record and
                shows it before the next appointment.
              </Lede>
              <p className="mt-4 text-[0.9375rem] leading-[1.6] text-muted">
                Hone shows what you recorded. It does not diagnose, recommend settings or make
                clinical decisions; those stay with you.
              </p>
            </div>
          </Container>
        </Section>

        <RelatedLinks
          title="Related pages"
          links={[
            {
              href: "/features/charting-records",
              label: "Charting and records",
              blurb: "Treatment memory comes from your charting. See how a session is recorded.",
            },
            {
              href: "/features/booking-calendar",
              label: "Booking and calendar",
              blurb: "Each appointment adds to the record, and email reminders help clients keep their course on schedule.",
            },
            {
              href: "/electrolysis-software",
              label: "Electrolysis practice software",
              blurb: "See where treatment memory fits in the rest of the practice.",
            },
          ]}
        />

        <WalkthroughCTA
          title="See treatment memory on a returning client"
          body="We reply within one business day to set a time, then open a returning client and walk you through the Before Today briefing."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
