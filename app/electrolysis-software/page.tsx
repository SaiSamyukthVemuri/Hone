import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "../_components/SafeAnalytics";
import { SiteHeader } from "../_components/marketing/SiteHeader";
import { SiteFooter } from "../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Section,
  Eyebrow,
  Display,
  Title,
  Subtitle,
  Lede,
  Hairline,
  CTAButton,
} from "../_components/marketing/primitives";
import { Reveal } from "../_components/marketing/Reveal";
import { TreatmentMemoryPanel } from "../_components/marketing/visuals/TreatmentMemoryPanel";
import { WalkthroughCTA, RelatedLinks } from "../_components/marketing/sections";
import { WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Pillar: /electrolysis-software. Intent: commercial electrolysis-software
// research. Broad overview of what specialist electrolysis practice software
// manages, why specialist beats generic salon tools, and where treatment memory
// fits. Links out to the three feature pages, pricing, and the walkthrough.
// Distinct H1/copy from the homepage to avoid cannibalization.

export const metadata: Metadata = marketingMetadata("/electrolysis-software");

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
    body: "Point-of-care charting for electrolysis and laser — mode, energy, machine frequency, structured probe and lot, minutes, and observations.",
    href: "/features/charting-records",
    link: "Charting and records",
  },
  {
    title: "Treatment memory",
    body: "The details that shape a returning client's session — last settings, probe lot, how they responded, and the plan you left — surfaced before they sit down.",
    href: "/features/treatment-memory",
    link: "Treatment memory",
  },
  {
    title: "Photos and records",
    body: "Private treatment photos and per-client procedure records, with print-friendly views for inspections.",
  },
  {
    title: "Practice operations",
    body: "A daily dashboard, sterile-item and disinfectant logs with expiry tracking, and multi-practitioner support on one shared calendar.",
  },
];

export default function ElectrolysisSoftwarePage() {
  return (
    <MarketingSurface>
      <SiteHeader />
      <main className="overflow-x-hidden">
        {/* Hero */}
        <Container className="grid items-center gap-12 pb-16 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-20 lg:pt-20">
          <Reveal>
            <Eyebrow>Electrolysis practice software</Eyebrow>
            <Display className="mt-4">
              Software built for an electrolysis practice, not a generic salon.
            </Display>
            <Lede className="mt-6 max-w-xl">
              Hone runs the whole electrolysis workflow — booking, intake, consent, charting,
              treatment memory, photos, records, and follow-up — in one calm place, with the
              detail electrologists actually record.
            </Lede>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
              <CTAButton href="/pricing" variant="secondary" event={ANALYTICS_EVENTS.pricingPlanViewed}>
                See pricing
              </CTAButton>
            </div>
          </Reveal>
          <Reveal delay={80} className="lg:pl-4">
            <TreatmentMemoryPanel />
          </Reveal>
        </Container>

        {/* What specialist software manages */}
        <Section tone="warm">
          <Container>
            <Reveal>
              <Eyebrow>What it manages</Eyebrow>
              <Title className="mt-4 max-w-2xl">
                Everything an electrolysis practice runs on.
              </Title>
              <Lede className="mt-5 max-w-2xl">
                Generic scheduling tools stop at the appointment. Specialist software has to
                carry the treatment detail too — and connect it to the next visit.
              </Lede>
            </Reveal>
            <div className="mt-10">
              <Hairline strong />
              <div className="grid sm:grid-cols-2 lg:grid-cols-3">
                {MANAGES.map((m, i) => (
                  <Reveal
                    as="div"
                    key={m.title}
                    delay={(i % 3) * 60}
                    className="border-b border-[color:var(--color-hairline)] py-6 sm:pr-8"
                  >
                    <Subtitle as="h3" className="text-[1.125rem]">
                      {m.title}
                    </Subtitle>
                    <p className="mt-2 text-[0.9375rem] leading-[1.6] text-muted">{m.body}</p>
                    {m.href ? (
                      <Link
                        href={m.href}
                        className="mt-3 inline-block text-[0.875rem] font-medium text-mineral underline underline-offset-4"
                      >
                        {m.link} →
                      </Link>
                    ) : null}
                  </Reveal>
                ))}
              </div>
            </div>
          </Container>
        </Section>

        {/* Why specialist */}
        <Section tone="paper">
          <Container className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <Eyebrow>Why specialist</Eyebrow>
              <Title className="mt-4">Built around returning-client memory.</Title>
              <Lede className="mt-5">
                Electrolysis is a course of treatment, not a one-off. What made the difference
                last time — the settings that worked, the probe lot, how the skin reacted, the
                plan you left — is exactly what a generic booking tool throws away.
              </Lede>
              <p className="mt-4 text-[0.9375rem] leading-[1.6] text-muted">
                Hone keeps that record structured and puts it in front of you before the next
                appointment, so each session builds on the last.
              </p>
              <div className="mt-6">
                <Link
                  href="/features/treatment-memory"
                  className="text-[0.9375rem] font-medium text-mineral underline underline-offset-4"
                >
                  See how treatment memory works →
                </Link>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <div className="rounded-[12px] border border-[color:var(--color-hairline)] bg-white p-6">
                <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-mineral">
                  Records electrologists actually keep
                </p>
                <ul className="mt-4 space-y-2.5 text-[0.9375rem] text-ink">
                  <li>Thermolysis, blend, and galvanic readings</li>
                  <li>Structured probe with lot/batch number</li>
                  <li>Minutes and treatment areas with laterality</li>
                  <li>Tolerance, reaction, and next-visit plan</li>
                  <li>Sterile-item and disinfectant logs with expiry</li>
                </ul>
              </div>
            </Reveal>
          </Container>
        </Section>

        <RelatedLinks
          title="Explore the workflow in detail."
          links={[
            {
              href: "/features/treatment-memory",
              label: "Treatment memory",
              blurb: "The Before Today briefing that carries settings, probe lot, and response into the next visit.",
            },
            {
              href: "/features/booking-calendar",
              label: "Booking and calendar",
              blurb: "An online booking page and a calendar built for an electrolysis day, with double-booking protection.",
            },
            {
              href: "/features/charting-records",
              label: "Charting and records",
              blurb: "Point-of-care charting and clean procedure records with probe-lot traceability.",
            },
          ]}
        />

        <WalkthroughCTA
          title="See Hone on your own workflow."
          body="Bring one real treatment workflow. We'll walk through booking, charting, treatment memory, and records — and reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
