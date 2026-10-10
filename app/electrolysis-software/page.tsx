import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import posterFrame from "@/app/_media/treatment-memory-setup-frame.png";
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
import { Breadcrumbs } from "../_components/marketing/JsonLd";
import { TreatmentMemoryPanel } from "../_components/marketing/visuals/TreatmentMemoryPanel";
import {
  WalkthroughCTA,
  RelatedLinks,
  FeatureMatrix,
  SpecRows,
  SpecRow,
  SpecRowHead,
  SpecRowBody,
} from "../_components/marketing/sections";
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
// THE FOUR-AREA CLAIM WAS WRONG AND IS CORRECTED. This section said "A four-area
// appointment is recorded as four treatments, each attached to its area." It is
// one record: `create_block_with_entry` (0166:390) writes ONE `session_blocks`
// row with its area set and at most ONE entry, and every treatment field is a
// block column that 0019 calls "Treatment-level params that apply to every entry
// in this block". `session_block_areas` (0128:26) holds only area, laterality and
// order. The heading stays, because per-area history IS real:
// `lib/sessions/treatment-intelligence.ts:41-45` has a multi-area block contribute
// to EVERY area's intelligence, and `lib/search/treatment-memory-merge.ts` makes a
// secondary area findable by name. Full reasoning in the charting-records page.
//
// NO COMPETITOR NAMES. The truth register's stale-claim 4 retires the absolute
// "You do not need Calendly, Jane, or Square Appointments on top" in favour of a
// conditional. This page carries the conditional idea — specialist fit for how
// electrolysis is charted — and names nothing.

export const metadata: Metadata = marketingMetadata("/electrolysis-software");

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
      <main id="main-content" className="scroll-mt-16">
        <Container className="grid items-center gap-x-[clamp(2.5rem,5vw,5rem)] gap-y-10 pb-[var(--mk-section-pad)] pt-[clamp(1.25rem,0.75rem+2vw,2.75rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <Display className="max-w-[18ch]">
              Electrolysis software built around how electrolysis is charted
            </Display>
            <Lede className="mt-5 max-w-[38rem]">
              Hone is practice software for electrologists. It keeps a separate history for
              every treated area and brings last time&rsquo;s settings forward before the next
              appointment.
            </Lede>
            <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
              <CTAButton
                href={WALKTHROUGH.href}
                event={ANALYTICS_EVENTS.primaryCtaClick}
                className="max-sm:w-full"
              >
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
          </div>
          {/* THE EVIDENCE OPENS THE PAGE. This still sat four sections down;
              it is the real treatment-memory panel, so it now stands beside
              the headline it proves.

              THE SAME FRAME THE CANONICAL PLAYER USES, imported rather than
              fetched from a path of this lane's own. It was a second copy of
              that PNG under public/film with an identical sha256; #764 put it
              in app/_media so next/image can serve AVIF/WebP at the rendered
              width, and types/static-images.d.ts is what makes the import
              typecheck on a fresh CI checkout.

              alt IS DESCRIPTIVE HERE, unlike on the homepage. There the same
              frame is the visual layer of a play button that already names
              itself, so alt="" is correct. Here it is a still with no control
              over it and nothing else describing it, and it was written after
              LOOKING at the frame: two areas, and the frame carries its own
              baked-in provenance label. */}
          <figure className="m-0 overflow-hidden rounded-[var(--mk-radius-frame)] border border-[color:var(--color-hairline)] bg-warm">
            <Image
              src={posterFrame}
              alt="Hone&rsquo;s treatment-memory panel, headed &ldquo;The exact setup you used&rdquo;, listing what was recorded for two treated areas &mdash; midline upper lip and bilateral chin &mdash; each with machine frequency, probe and lot number, mode, energy, timing and minutes."
              priority
              sizes="(min-width: 1640px) 680px, (min-width: 1024px) 43vw, 92vw"
              className="block aspect-video w-full object-cover"
            />
          </figure>
        </Container>

        {/* ONE SPEC SHEET, NOT SIX BANDS (see sections.tsx SpecRows). Each row
            was a section of its own, alternating backgrounds, a label, a
            heading and two lines. Where a body restated its own heading, the
            repeat is trimmed; nothing is added. */}
        <Section tone="warm">
          <Container>
            <Title className="max-w-2xl">Built around the treatment record</Title>
            <SpecRows>
              <SpecRow>
                <SpecRowHead>Who it&rsquo;s for</SpecRowHead>
                <SpecRowBody>
                  <p>Solo electrologists and small studios of up to three practitioners.</p>
                  <p>Plans in Canadian dollars.</p>
                </SpecRowBody>
              </SpecRow>
              <SpecRow>
                <SpecRowHead>Before the client sits down</SpecRowHead>
                <SpecRowBody>
                  <p>The briefing is already assembled.</p>
                  <p>
                    Open a returning client and it is there, built from their previous
                    treatments: areas, settings, probe and lot, skin response, and what you
                    flagged for next time.
                  </p>
                </SpecRowBody>
              </SpecRow>
              <SpecRow>
                <SpecRowHead>Every area keeps its own history</SpecRowHead>
                <SpecRowBody>
                  <p>The history of the chin is the history of the chin.</p>
                  <p>
                    Treat four areas at the same settings and those settings are recorded once,
                    for those four areas. Each one carries the treatment into its own history,
                    and each one is searchable by name.
                  </p>
                </SpecRowBody>
              </SpecRow>
              <SpecRow>
                <SpecRowHead>More than a note</SpecRowHead>
                <SpecRowBody>
                  <p>Fields, not sentences.</p>
                  <p>
                    Area and side, mode and modality, energy, frequency and pulse count, probe
                    type and lot, tolerance, skin response and the note for next time, recorded
                    as fields so Hone can keep each area separate, bring the right one forward,
                    and flag what&rsquo;s missing.
                  </p>
                </SpecRowBody>
              </SpecRow>
              <SpecRow>
                <SpecRowHead>Know what was used, and when</SpecRowHead>
                <SpecRowBody>
                  <p>Traceable to the day.</p>
                  <p>
                    Probe lots linked to inventory. Sterile-item and disinfectant expiry logged,
                    and that log is append-only. A print-friendly view of the record. Gaps
                    flagged: a missing lot, aftercare not marked, a completed appointment not
                    yet charted.
                  </p>
                </SpecRowBody>
              </SpecRow>
              <SpecRow>
                <SpecRowHead>Plans</SpecRowHead>
                <SpecRowBody>
                  <p>{POSITIONING.pricingHeading}</p>
                  <p>{POSITIONING.noCapsLine}</p>
                  <p>
                    <Link
                      href="/pricing"
                      className="inline-flex min-h-11 items-center font-medium text-mineral underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]"
                    >
                      See pricing
                    </Link>
                  </p>
                </SpecRowBody>
              </SpecRow>
            </SpecRows>
          </Container>
        </Section>

        <Section tone="paper">
          <Container>
            <Eyebrow>Everything else stays connected</Eyebrow>
            <Title className="mt-3 max-w-2xl">
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
          <Container className="grid items-center gap-x-[clamp(2.5rem,5vw,5rem)] gap-y-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <div>
              <Eyebrow>Why specialist</Eyebrow>
              <Title className="mt-3">Built around returning-client memory.</Title>
              <Lede className="mt-4">
                Generic scheduling tools record that an appointment happened. Electrolysis is a
                course of treatment, so what matters next time is what was done to each area
                and how it responded. Hone keeps that, per area, and brings it forward.
              </Lede>
            </div>
            <TreatmentMemoryPanel />
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
