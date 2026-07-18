import type { Metadata } from "next";
import { SafeAnalytics } from "../../_components/SafeAnalytics";
import { SiteHeader } from "../../_components/marketing/SiteHeader";
import { SiteFooter } from "../../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Section,
  Eyebrow,
  Display,
  Title,
  Lede,
  CTAButton,
} from "../../_components/marketing/primitives";
import { Reveal } from "../../_components/marketing/Reveal";
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
    body: "Open a returning client and Hone assembles a briefing from what you already charted, the last treatment's areas and settings, the probe lot, how the client responded, and what to record today.",
  },
  {
    title: "From last visit, for today",
    body: "Cautions you flag and the plan you leave for next time resurface automatically, on the client's last-visit card and in the new-session panel, so nothing is lost between appointments.",
  },
  {
    title: "A for-next-visit note",
    body: "Leave a short plan at the end of a session and Hone puts it in front of you before the next appointment, without digging back through notes.",
  },
  {
    title: "Memory per treatment area",
    body: "Each treated area keeps its own history, last settings, probe, tolerance, and response, so multi-area sessions stay legible instead of collapsing to a single line.",
  },
  {
    title: "Record-gap reminders",
    body: "Hone points out incomplete records, a missing probe lot, aftercare not marked, a completed appointment not yet charted, on the client card and a dashboard follow-up list. Rules-based, not AI.",
  },
  {
    title: "Imported history, clearly labelled",
    body: "During guided onboarding, bring history over from paper cards, a spreadsheet, or another tool. It appears in the Before Today briefing marked as imported, never mixed with what you charted in Hone.",
  },
];

export default function TreatmentMemoryPage() {
  return (
    <MarketingSurface>
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Electrolysis software", path: "/electrolysis-software" },
          { name: "Treatment memory", path: "/features/treatment-memory" },
        ]}
      />
      <main className="overflow-x-hidden">
        <Container className="grid items-start gap-12 pb-16 pt-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-20 lg:pt-10">
          <Reveal immediate>
            <Eyebrow>Treatment memory</Eyebrow>
            <Display className="mt-4">
              Remember every treatment, before the client sits down.
            </Display>
            <Lede className="mt-6 max-w-xl">
              Treatment memory is the part generic booking tools forget. Hone carries the
              detail that shapes a returning client&apos;s session from one appointment into
              the next, assembled automatically from your own records.
            </Lede>
            <div className="mt-8">
              <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
            </div>
          </Reveal>
          <Reveal delay={80} className="lg:pl-4">
            <TreatmentMemoryPanel />
          </Reveal>
        </Container>

        <Section tone="warm">
          <Container size="wide">
            <Eyebrow>What it does</Eyebrow>
            <Title className="mt-4 max-w-2xl">
              Your charting, brought forward when it matters.
            </Title>
            <FeatureMatrix items={CAPABILITIES} />
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Why it matters</Eyebrow>
              <Title className="mt-4">Every session builds on the last.</Title>
              <Lede className="mt-5">
                Electrolysis is a course of treatment. When the record of what worked lives in
                your head or on a paper card, continuity depends on memory and luck. Hone keeps
                it structured and close to the next visit, so you can start each appointment
                already knowing where you left off, and record cleaner history as you go.
              </Lede>
              <p className="mt-4 text-[0.9375rem] leading-[1.6] text-muted">
                Hone surfaces what you recorded; it does not diagnose, recommend settings, or
                make clinical decisions. The judgement stays yours.
              </p>
            </Reveal>
          </Container>
        </Section>

        <RelatedLinks
          title="How treatment memory connects."
          links={[
            {
              href: "/features/charting-records",
              label: "Charting and records",
              blurb: "Treatment memory is only as good as the charting behind it, see how sessions are recorded.",
            },
            {
              href: "/features/booking-calendar",
              label: "Booking and calendar",
              blurb: "Every appointment feeds the record, and reminders help returning clients keep their course going.",
            },
            {
              href: "/electrolysis-software",
              label: "Electrolysis practice software",
              blurb: "See where treatment memory fits in the whole electrolysis workflow.",
            },
          ]}
        />

        <WalkthroughCTA
          title="See treatment memory on a real client history."
          body="We'll walk through the Before Today briefing and how your charting carries forward, and reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
