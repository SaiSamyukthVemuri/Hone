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
import { SessionRecordPreview } from "../../_components/marketing/visuals/SessionRecordPreview";
import { WalkthroughCTA, RelatedLinks, FeatureGrid } from "../../_components/marketing/sections";
import { WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Feature: /features/charting-records. Intent: electrolysis charting / treatment
// records. All LIVE. "Print/export" = print-friendly views + full studio data
// export (there is no CSV/PDF file export of charting, do not imply one).

export const metadata: Metadata = marketingMetadata("/features/charting-records");

const CAPABILITIES: { title: string; body: string }[] = [
  {
    title: "Point-of-care charting",
    body: "Chart electrolysis and laser sessions on one page, mode (thermolysis, blend, galvanic), Apilus modality, energy, machine frequency, and per-pass readings.",
  },
  {
    title: "Structured probe and lot",
    body: "Select a validated probe by brand, material, and size, and record the probe lot number from a searchable active-lot picker drawn from your sterile-item records. Manual entry is always available.",
  },
  {
    title: "Areas, laterality, and minutes",
    body: "Record several treatment areas under one machine-settings block, each with its own laterality, plus minutes performed per area for treatment-time tracking.",
  },
  {
    title: "Observations and response",
    body: "Tag what you saw with quick observation chips, and capture how each area was tolerated and any reaction, as structured, factual records alongside free-text notes.",
  },
  {
    title: "Procedure records and print views",
    body: "Generate per-client procedure records from charted sessions, filterable by client and date, and open clean, print-friendly views for inspections.",
  },
  {
    title: "Traceability and logs",
    body: "Trace a probe lot to the areas that recorded it, and keep sterile-item and disinfectant logs with lot numbers, expiry, and replace-by dates, with an append-only edit history.",
  },
];

export default function ChartingRecordsPage() {
  return (
    <MarketingSurface>
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Electrolysis software", path: "/electrolysis-software" },
          { name: "Charting and records", path: "/features/charting-records" },
        ]}
      />
      <main className="overflow-x-hidden">
        <Container className="grid items-start gap-12 pb-16 pt-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-20 lg:pt-10">
          <Reveal immediate>
            <Eyebrow>Charting and records</Eyebrow>
            <Display className="mt-4">
              Chart the treatment while it&apos;s fresh, keep clean records.
            </Display>
            <Lede className="mt-6 max-w-xl">
              Record electrolysis and laser sessions at the point of care, machine settings,
              structured probe and lot, treatment areas, and observations, and keep
              print-ready procedure records for your files and inspections.
            </Lede>
            <div className="mt-8">
              <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
            </div>
          </Reveal>
          <Reveal delay={80} className="lg:pl-4">
            <SessionRecordPreview />
          </Reveal>
        </Container>

        <Section tone="warm">
          <Container size="wide">
            <Eyebrow>What it captures</Eyebrow>
            <Title className="mt-4 max-w-2xl">The detail an electrolysis record needs.</Title>
            <FeatureGrid items={CAPABILITIES} />
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Records you can stand behind</Eyebrow>
              <Title className="mt-4">Structured now, useful later.</Title>
              <Lede className="mt-5">
                Because charting is structured, not a free-text blob, the record you make
                today becomes the treatment memory you rely on next time, the procedure record
                you print for an inspection, and part of the full studio history you can export
                any time.
              </Lede>
              <p className="mt-4 text-[0.9375rem] leading-[1.6] text-muted">
                Hone supports record-keeping workflows; studios remain responsible for meeting
                their local public-health requirements.
              </p>
            </Reveal>
          </Container>
        </Section>

        <RelatedLinks
          title="Where the record goes."
          links={[
            {
              href: "/features/treatment-memory",
              label: "Treatment memory",
              blurb: "Structured charting is what makes the Before Today briefing possible next visit.",
            },
            {
              href: "/features/booking-calendar",
              label: "Booking and calendar",
              blurb: "Each appointment links to the session you chart against it.",
            },
            {
              href: "/electrolysis-software",
              label: "Electrolysis practice software",
              blurb: "See how charting and records fit the whole workflow.",
            },
          ]}
        />

        <WalkthroughCTA
          title="See charting on a real session."
          body="We'll walk through charting a session and pulling a procedure record, and reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
