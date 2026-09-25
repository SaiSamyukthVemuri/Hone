import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "../_components/SafeAnalytics";
import { SiteHeader } from "../_components/marketing/SiteHeader";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
import { SiteFooter } from "../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Section,
  Eyebrow,
  Display,
  Title,
  Lede,
  CTAButton,
} from "../_components/marketing/primitives";
import { Reveal } from "../_components/marketing/Reveal";
import { Breadcrumbs } from "../_components/marketing/JsonLd";
import { TreatmentMemoryPanel } from "../_components/marketing/visuals/TreatmentMemoryPanel";
import { WalkthroughCTA, RelatedLinks, FeatureMatrix } from "../_components/marketing/sections";
import { WALKTHROUGH, ANALYTICS_EVENTS, POSITIONING } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Pillar: /electrolysis-software. Intent: commercial electrolysis-software
// research. Broad overview of what specialist electrolysis practice software
// manages, why specialist beats generic salon tools, and where treatment memory
// fits. Links out to the three feature pages, pricing, and the walkthrough.
// Distinct H1/copy from the homepage to avoid cannibalization.
//
// MKT-02E. Structure and copy follow marketing copy deck v2.2 section 7, which
// states the page's job: it "carries the mechanism, not just the vocabulary,
// because a landing page with the word 'electrologist' on it is copyable and the
// schema is not. It is allowed to be denser than the homepage."
//
// STILLS, NOT THE FILM — deck section 7, and an owner ruling on this lane. The
// page stays light and text-forward for search, so the product film is NOT
// embedded here; it lives on /demo. One still is used, the film's own setup
// frame, which is the only approved product still that exists. The deck
// references a larger screenshot set (S1–S4, S11) that has not been produced.
//
// The alt text was written after LOOKING at the frame, not from its filename: it
// is the treatment-memory "setup used" panel for two areas, and the frame
// carries its own baked-in provenance label, "DEMO DATA. ACTUAL HONE
// APPLICATION." Nothing on this page describes it as anything else.
//
// NO COMPETITOR NAMES. The truth register's stale-claim 4 retires the absolute
// "You do not need Calendly, Jane, or Square Appointments on top" in favour of a
// conditional. This page carries the conditional idea — specialist fit for how
// electrolysis is charted — and names nothing.

export const metadata: Metadata = marketingMetadata("/electrolysis-software");

const FILM_POSTER = "/film/hone-product-overview-v3-1-poster.png";

// SHAPE PRESERVED FROM PRODUCTION: flat `href` + `link` strings, mapped into the
// matrix at the call site below. An earlier pass here collapsed both into a
// `MatrixItem.link` object, which is tidier and identical at runtime — and broke
// tests/app/marketing-desktop.test.ts, which asserts that mapping expression by
// its source text. The guard is brittle, but rewriting a shipped guard is not
// this lane's job, so the original shape stays.
const MANAGES: { title: string; body: string; href?: string; link?: string }[] = [
  {
    title: "Booking and schedule",
    body: "A public booking page with real open times and double-booking protection, plus a calendar built for how an electrolysis day actually runs.",
    href: "/features/booking-calendar",
    link: "Booking and calendar",
  },
  {
    title: "Client preparation",
    body: "A secure health intake and your own consent forms, collected before the visit and reviewed in one place.",
  },
  {
    title: "Treatment charting",
    body: "Point-of-care charting for electrolysis and laser, mode, energy, machine frequency, structured probe and lot, minutes, and observations.",
    href: "/features/charting-records",
    link: "Charting and records",
  },
  {
    title: "Treatment memory",
    body: "The details that shape a returning client's session, last settings, probe lot, how they responded, and the plan you left, surfaced before they sit down.",
    href: "/features/treatment-memory",
    link: "Treatment memory",
  },
  {
    title: "Photos and records",
    body: "Private treatment photos and per-client procedure records, with print-friendly views for inspections.",
  },
  {
    title: "Practice operations",
    body: "Client tags, pinned notes, postcare emails from your own saved text, and a CSV data export you can download any time.",
  },
];

export default function ElectrolysisSoftwarePage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Electrolysis software", path: "/electrolysis-software" },
        ]}
      />
      <main id="main-content" className="scroll-mt-16 overflow-x-hidden">
        <Container className="pb-16 pt-8 lg:pb-20 lg:pt-10">
          <Reveal immediate>
            <Eyebrow>Electrolysis software</Eyebrow>
            <Display className="mt-4 max-w-4xl">
              Electrolysis software built around how electrolysis is charted
            </Display>
            <Lede className="mt-6 max-w-2xl">
              Hone is practice software for electrologists. It keeps a separate history for
              every treated area and brings last time&rsquo;s settings forward before the next
              appointment.
            </Lede>
            <div className="mt-8 flex flex-wrap gap-3">
              <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
              {/* Label AND destination from the constants, deliberately together:
                  #762 pairs `secondaryLabel` with `secondaryHref` because a
                  control may only promise what its destination delivers. Spelled
                  by hand here, the two could drift apart in a later edit. */}
              <CTAButton
                href={WALKTHROUGH.secondaryHref}
                variant="secondary"
                event={ANALYTICS_EVENTS.secondaryCtaClick}
              >
                {WALKTHROUGH.secondaryLabel}
              </CTAButton>
            </div>
          </Reveal>
        </Container>

        <Section tone="warm">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Who it&rsquo;s for</Eyebrow>
              <Title className="mt-4">Solo electrologists and small studios.</Title>
              <Lede className="mt-5">
                Solo electrologists and small studios of up to three practitioners. Plans in
                Canadian dollars.
              </Lede>
            </Reveal>
          </Container>
        </Section>

        <Section tone="paper">
          <Container className="grid items-center gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:gap-14">
            <Reveal>
              <Eyebrow>Before the client sits down</Eyebrow>
              <Title className="mt-4">The briefing is already assembled.</Title>
              <Lede className="mt-5">
                Open a returning client and the briefing is already assembled from their
                previous treatments: areas, settings, probe and lot, skin response, and what
                you flagged for next time.
              </Lede>
            </Reveal>
            <Reveal delay={80}>
              <figure className="m-0 overflow-hidden rounded-[14px] border border-hairline bg-warm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={FILM_POSTER}
                  alt="Hone's treatment-memory panel, headed &ldquo;The exact setup you used&rdquo;, listing what was recorded for two treated areas &mdash; midline upper lip and bilateral chin &mdash; each with machine frequency, probe and lot number, mode, energy, timing and minutes."
                  width={1920}
                  height={1080}
                  loading="lazy"
                  decoding="async"
                  className="block aspect-video w-full object-cover"
                />
              </figure>
            </Reveal>
          </Container>
        </Section>

        <Section tone="warm">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Every area keeps its own history</Eyebrow>
              <Title className="mt-4">The history of the chin is the history of the chin.</Title>
              <Lede className="mt-5">
                A four-area appointment is recorded as four treatments, each attached to its
                area.
              </Lede>
            </Reveal>
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>More than a note</Eyebrow>
              <Title className="mt-4">Fields, not sentences.</Title>
              <Lede className="mt-5">
                Area and side, mode and modality, energy, frequency and pulse count, probe type
                and lot, tolerance, skin response and the note for next time. Fields, not
                sentences, so Hone can keep each area separate, bring the right one forward,
                and flag what&rsquo;s missing.
              </Lede>
            </Reveal>
          </Container>
        </Section>

        <Section tone="warm">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Know what was used, and when</Eyebrow>
              <Title className="mt-4">Traceable to the day.</Title>
              <Lede className="mt-5">
                Probe lots linked to inventory. Sterile-item and disinfectant expiry logged.
                Edit history kept. A print-friendly view of the record. Gaps flagged: a missing
                lot, aftercare not marked, a completed appointment not yet charted.
              </Lede>
            </Reveal>
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="wide">
            <Eyebrow>Everything else stays connected</Eyebrow>
            <Title className="mt-4 max-w-2xl">
              Booking, intake, consent, treatment, follow-up and the client portal share one
              record.
            </Title>
            <FeatureMatrix
              items={MANAGES.map((m) => ({
                title: m.title,
                body: m.body,
                link: m.href && m.link ? { href: m.href, label: m.link } : undefined,
              }))}
            />
          </Container>
        </Section>

        <Section tone="warm">
          <Container className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
            <Reveal>
              <Eyebrow>Why specialist</Eyebrow>
              <Title className="mt-4">Built around returning-client memory.</Title>
              <Lede className="mt-5">
                Generic scheduling tools record that an appointment happened. Electrolysis is a
                course of treatment, so what matters next time is what was done to each area
                and how it responded. Hone keeps that, per area, and brings it forward.
              </Lede>
            </Reveal>
            <Reveal delay={80}>
              <TreatmentMemoryPanel />
            </Reveal>
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Plans</Eyebrow>
              <Title className="mt-4">{POSITIONING.pricingHeading}</Title>
              <Lede className="mt-5">{POSITIONING.noCapsLine}</Lede>
              <p className="mt-6">
                <Link
                  href="/pricing"
                  className="text-[0.9375rem] font-medium text-mineral underline underline-offset-4"
                >
                  See pricing
                </Link>
              </p>
            </Reveal>
          </Container>
        </Section>

        <RelatedLinks
          title="Go deeper."
          links={[
            {
              href: "/features/treatment-memory",
              label: "Treatment memory",
              blurb: "How last time's settings reach the next appointment.",
            },
            {
              href: "/features/charting-records",
              label: "Charting and records",
              blurb: "The fields an electrolysis record is made of.",
            },
            {
              href: "/features/booking-calendar",
              label: "Booking and calendar",
              blurb: "Booking connected to the treatment record.",
            },
          ]}
        />

        <WalkthroughCTA
          title={POSITIONING.walkthroughHeading}
          body="A short, founder-led walkthrough of the real app. We reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
