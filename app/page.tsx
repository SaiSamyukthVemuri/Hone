import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "./_components/SafeAnalytics";
import { SiteHeader } from "./_components/marketing/SiteHeader";
import { SiteFooter } from "./_components/marketing/SiteFooter";
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
  Chip,
  CTAButton,
} from "./_components/marketing/primitives";
import { Reveal } from "./_components/marketing/Reveal";
import { JsonLd } from "./_components/marketing/JsonLd";
import { organizationLd, webSiteLd, softwareApplicationLd } from "@/lib/marketing/jsonld";
import { TreatmentMemoryPanel } from "./_components/marketing/visuals/TreatmentMemoryPanel";
import {
  POSITIONING,
  WALKTHROUGH,
  CAPABILITY_GROUPS,
  PRICING_PLANS,
  ANALYTICS_EVENTS,
} from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Public marketing homepage — flagship rebuild. Category: electrolysis practice
// software. Differentiator: treatment memory. One primary conversion: the
// founder-led walkthrough (a lead-capture request — hence "Request", not
// "Book"). Every product surface is a coded, anonymized illustrative preview.
// Copy is grounded in docs/marketing/product-truth-register.md; nothing markets
// a not-public-ready capability (no Google Calendar, no unbuilt features).

export const metadata: Metadata = marketingMetadata("/");

const WORKFLOW_STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Get booked", body: "Clients book real open times on your own page, with double-booking protection." },
  { n: "02", title: "Collect intake and consent", body: "Send a secure health intake and your own consent forms before the visit." },
  { n: "03", title: "Prepare before the visit", body: "Open a client to a Before Today briefing — last treatment, settings, and how they responded." },
  { n: "04", title: "Chart the treatment", body: "Record areas, machine settings, probe lot, and observations at the point of care." },
  { n: "05", title: "Follow up professionally", body: "Send studio-branded postcare and keep private treatment photos and records." },
  { n: "06", title: "Remember it next time", body: "Cautions and the plan you leave resurface automatically at the next appointment." },
];

const TRUST_POINTS: { title: string; body: string }[] = [
  { title: "Studio data stays isolated", body: "Each studio's records are separated with database row-level security." },
  { title: "Private treatment photos", body: "Stored in a private bucket, shown only to your studio through short-lived signed links — never public URLs." },
  { title: "No advertising use of health records", body: "Client health information is never used for advertising." },
  { title: "No AI training on your records", body: "Hone does not train AI models on practitioner or client records." },
  { title: "Payments handled by Stripe", body: "Card details go straight to Stripe; Hone never stores full card numbers. Payments are enabled during guided onboarding." },
  { title: "Your data is exportable", body: "Export your full studio history any time; if you cancel, your data goes with you." },
];

export default function HomePage() {
  return (
    <MarketingSurface>
      <SiteHeader />
      <main className="overflow-x-hidden">
        {/* Hero */}
        <Container className="grid items-center gap-12 pb-16 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-24 lg:pt-20">
          <div>
            <Eyebrow>{POSITIONING.heroEyebrow}</Eyebrow>
            <Display className="mt-4">{POSITIONING.heroH1}</Display>
            <Lede className="mt-6 max-w-xl">{POSITIONING.heroSupporting}</Lede>
            <p className="mt-5 max-w-xl text-[1.0625rem] font-medium text-ink">
              {POSITIONING.differentiationLine}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
              <CTAButton
                href="#how-hone-works"
                variant="secondary"
                event={ANALYTICS_EVENTS.secondaryCtaClick}
              >
                {WALKTHROUGH.secondaryLabel}
              </CTAButton>
            </div>
            <p className="mt-8 text-[0.8125rem] text-muted">{POSITIONING.proofLine}</p>
          </div>

          <Reveal className="lg:pl-4">
            <p className="mb-3 text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-mineral">
              {POSITIONING.keepPhrase}
            </p>
            <TreatmentMemoryPanel />
          </Reveal>
        </Container>

        {/* Narrative contrast — the one dark band */}
        <Section tone="band">
          <Container>
            <Reveal>
              <Eyebrow onBand>Calendar vs Hone</Eyebrow>
              <Title className="mt-4 max-w-3xl text-paper">
                Most tools stop at the appointment.
              </Title>
              <Lede onBand className="mt-5 max-w-2xl">
                A calendar tells you who is coming. When a returning client sits down, the
                details that shape the treatment live somewhere else — or nowhere. Hone
                carries them from one appointment into the next.
              </Lede>
            </Reveal>

            <div className="mt-12 grid gap-6 md:grid-cols-2">
              <Reveal
                className="rounded-[12px] border border-white/10 p-6"
                delay={40}
              >
                <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-[color:var(--color-onband-muted)]">
                  A calendar shows
                </p>
                <ul className="mt-4 space-y-2.5 text-[0.9375rem] text-paper">
                  <li>Client name</li>
                  <li>Date and time</li>
                  <li>Service booked</li>
                </ul>
              </Reveal>
              <Reveal
                className="rounded-[12px] border border-[color:var(--color-mineral)] bg-white/[0.04] p-6"
                delay={120}
              >
                <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-[color:var(--color-wash)]">
                  Hone also carries
                </p>
                <ul className="mt-4 space-y-2.5 text-[0.9375rem] text-paper">
                  <li>The last treatment and its settings</li>
                  <li>How the client responded</li>
                  <li>Cautions to watch this time</li>
                  <li>The plan you left for next visit</li>
                </ul>
              </Reveal>
            </div>
          </Container>
        </Section>

        {/* Workflow progression */}
        <Section id="how-hone-works" tone="paper">
          <Container>
            <Reveal>
              <Eyebrow>How Hone works</Eyebrow>
              <Title className="mt-4 max-w-2xl">One calm workflow, start to finish.</Title>
              <Lede className="mt-5 max-w-2xl">
                From the booking page to the next visit, each step feeds the one after it —
                so nothing is re-entered and nothing is lost.
              </Lede>
            </Reveal>
            <div className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
              {WORKFLOW_STEPS.map((step, i) => (
                <Reveal as="div" key={step.n} delay={i * 60}>
                  <div className="flex items-baseline gap-3">
                    <span className="text-[0.8125rem] font-semibold text-mineral">{step.n}</span>
                    <Subtitle as="h3">{step.title}</Subtitle>
                  </div>
                  <Hairline className="my-3" />
                  <p className="text-[0.9375rem] leading-[1.6] text-muted">{step.body}</p>
                </Reveal>
              ))}
            </div>
          </Container>
        </Section>

        {/* Treatment memory differentiator */}
        <Section tone="warm">
          <Container className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <Eyebrow>Treatment memory</Eyebrow>
              <Title className="mt-4">The part other tools forget.</Title>
              <Lede className="mt-5">
                Before a returning client sits down, Hone assembles a briefing from what you
                already charted — the last treatment&apos;s areas and settings, the probe lot, how
                the client responded, and the plan you left for today.
              </Lede>
              <ul className="mt-6 space-y-3">
                {[
                  "Last treatment, settings, and probe lot at a glance",
                  "How each area was tolerated, and any reaction",
                  "Cautions and the next-visit plan, surfaced automatically",
                ].map((line) => (
                  <li key={line} className="flex gap-3 text-[0.9375rem] text-ink">
                    <span aria-hidden="true" className="mt-1 text-mineral">•</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <CTAButton
                  href="/features/treatment-memory"
                  variant="secondary"
                  event={ANALYTICS_EVENTS.featureCtaClick}
                >
                  See how treatment memory works
                </CTAButton>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <TreatmentMemoryPanel />
            </Reveal>
          </Container>
        </Section>

        {/* Capability groups */}
        <Section tone="paper">
          <Container>
            <Reveal>
              <Eyebrow>What Hone covers</Eyebrow>
              <Title className="mt-4 max-w-2xl">
                Everything a treatment room runs on, in one place.
              </Title>
            </Reveal>
            <div className="mt-10">
              <Hairline strong />
              <dl className="grid sm:grid-cols-2 lg:grid-cols-3">
                {CAPABILITY_GROUPS.map((group, i) => (
                  <Reveal
                    as="div"
                    key={group.label}
                    delay={(i % 3) * 60}
                    className="border-b border-[color:var(--color-hairline)] py-6 sm:[&:nth-last-child(-n+1)]:border-b-0 sm:pr-8"
                  >
                    <dt className="text-[0.75rem] font-semibold uppercase tracking-[0.12em] text-mineral">
                      {group.outcome}
                    </dt>
                    <dd
                      className="mt-2 text-[1.0625rem] text-ink"
                      style={{ fontFamily: "var(--font-marketing-display)" }}
                    >
                      {group.label}
                    </dd>
                  </Reveal>
                ))}
              </dl>
            </div>
            <p className="mt-8 text-[0.9375rem] text-muted">
              {POSITIONING.corePromise}{" "}
              <Link href="/electrolysis-software" className="font-medium text-mineral underline underline-offset-4">
                See the full picture
              </Link>
              .
            </p>
          </Container>
        </Section>

        {/* Pricing teaser */}
        <Section tone="warm" id="pricing">
          <Container>
            <Reveal>
              <Eyebrow>Pricing</Eyebrow>
              <Title className="mt-4 max-w-2xl">Simple plans, in Canadian dollars.</Title>
              <Lede className="mt-5 max-w-2xl">
                Founder-led setup and free standard import on every plan. No setup fee, no
                contract, cancel anytime.
              </Lede>
            </Reveal>
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {PRICING_PLANS.map((plan, i) => (
                <Reveal
                  as="div"
                  key={plan.id}
                  delay={i * 70}
                  className={`flex flex-col rounded-[12px] border bg-white p-6 ${
                    plan.badge ? "border-[color:var(--color-mineral)]" : "border-[color:var(--color-hairline)]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <Subtitle as="h3">{plan.name}</Subtitle>
                    {plan.badge ? <Chip>{plan.badge}</Chip> : null}
                  </div>
                  <p className="mt-3">
                    <span className="text-[1.75rem] font-semibold text-ink">
                      {plan.priceLabel ?? "Talk to us"}
                    </span>
                    {plan.cadence ? (
                      <span className="text-[0.9375rem] text-muted">{plan.cadence}</span>
                    ) : null}
                  </p>
                  {plan.seats ? (
                    <p className="mt-1 text-[0.8125rem] text-muted">For {plan.seats}</p>
                  ) : null}
                  <p className="mt-3 text-[0.9375rem] leading-[1.55] text-muted">{plan.bestFor}</p>
                </Reveal>
              ))}
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <CTAButton href="/pricing" event={ANALYTICS_EVENTS.pricingPlanViewed}>
                See full pricing
              </CTAButton>
              <CTAButton
                href={WALKTHROUGH.href}
                variant="secondary"
                event={ANALYTICS_EVENTS.primaryCtaClick}
              >
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
            </div>
          </Container>
        </Section>

        {/* Trust */}
        <Section tone="paper">
          <Container>
            <Reveal>
              <Eyebrow>Privacy and trust</Eyebrow>
              <Title className="mt-4 max-w-2xl">Your client records should stay yours.</Title>
            </Reveal>
            <div className="mt-10 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
              {TRUST_POINTS.map((point, i) => (
                <Reveal as="div" key={point.title} delay={(i % 3) * 60}>
                  <Subtitle as="h3" className="text-[1.125rem]">
                    {point.title}
                  </Subtitle>
                  <p className="mt-2 text-[0.9375rem] leading-[1.6] text-muted">{point.body}</p>
                </Reveal>
              ))}
            </div>
            <p className="mt-8 text-[0.9375rem] text-muted">
              Read the{" "}
              <Link href="/privacy" className="font-medium text-mineral underline underline-offset-4">
                privacy policy
              </Link>{" "}
              for the full detail.
            </p>
          </Container>
        </Section>

        {/* Closing CTA */}
        <Section tone="band">
          <Container className="text-center">
            <Reveal>
              <Title className="mx-auto max-w-2xl text-paper">
                See if Hone fits your studio.
              </Title>
              <Lede onBand className="mx-auto mt-5 max-w-xl">
                Bring one real treatment workflow. We&apos;ll walk through how Hone handles
                the appointment, charting, treatment memory, and records — and reply within
                one business day.
              </Lede>
              <div className="mt-8 flex justify-center">
                <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
                  {WALKTHROUGH.primaryLabel}
                </CTAButton>
              </div>
            </Reveal>
          </Container>
        </Section>
      </main>
      <SiteFooter />
      <SafeAnalytics />
      <JsonLd data={organizationLd()} />
      <JsonLd data={webSiteLd()} />
      <JsonLd data={softwareApplicationLd()} />
    </MarketingSurface>
  );
}
