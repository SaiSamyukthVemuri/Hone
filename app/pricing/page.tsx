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
  Chip,
  CTAButton,
} from "../_components/marketing/primitives";
import { Reveal } from "../_components/marketing/Reveal";
import {
  PRICING_PLANS,
  PRICING_ASSURANCES,
  PAYMENT_QUALIFIER,
  REPLACES_STATEMENT,
  WALKTHROUGH,
  CONTACT_EMAIL,
  ANALYTICS_EVENTS,
} from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Pricing page — CAD, three plans, no artificial feature restrictions, no
// caps/quotas, no unsupported annual, no self-service checkout, no Google
// Calendar or multi-location claims. Core features are identical across plans;
// tiers differ only by who they're for and how many practitioners they cover.
// Grounded in docs/marketing/product-truth-register.md (Studio $99 decision).

export const metadata: Metadata = marketingMetadata("/pricing");

// Every plan includes the full workflow — plans are NOT feature-gated.
const INCLUDED: string[] = [
  "Online booking page, calendar, services, and availability",
  "Client health intake and your own consent forms",
  "Treatment charting for electrolysis and laser",
  "Treatment memory — the Before Today briefing on every returning client",
  "Private treatment photos and procedure records",
  "Client follow-up, postcare, and the client portal",
  "Full data export, any time",
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "How much does Hone cost?",
    a: "Founding Solo is CAD $29/month for your first 12 months, then CAD $39/month while you stay continuously subscribed. Solo is CAD $49/month. Studio is CAD $99/month for up to three practitioners. All prices are in Canadian dollars.",
  },
  {
    q: "Is there a setup fee or a contract?",
    a: "No setup fee and no contract. Setup is founder-led during onboarding, and you can cancel anytime.",
  },
  {
    q: "What's included on each plan?",
    a: "Every plan includes the full Hone workflow — booking, intake and consent, charting, treatment memory, photos and records, and client follow-up. Plans differ by who they're for and how many practitioners they cover, not by locking features behind a higher tier.",
  },
  {
    q: "Can I bring my existing client history into Hone?",
    a: "Yes. Standard client import is free and part of guided onboarding — we help bring history over from paper cards, spreadsheets, or another tool.",
  },
  {
    q: "How do payments work?",
    a: "Hone connects to your own Stripe account, so payments and payouts go directly to you and card details never touch Hone's servers. Payments are enabled during guided onboarding.",
  },
  {
    q: "How does the Studio plan work?",
    a: "Studio covers up to three practitioners at CAD $99/month, and Studio setup is completed through guided onboarding. If your studio has more than three practitioners, get in touch and we'll set up a plan that fits.",
  },
  {
    q: "Does Hone replace my other tools?",
    a: REPLACES_STATEMENT,
  },
];

function PlanCard({ plan }: { plan: (typeof PRICING_PLANS)[number] }) {
  const featured = Boolean(plan.badge);
  return (
    <div
      className={`flex flex-col rounded-[12px] border bg-white p-6 sm:p-7 ${
        featured
          ? "border-[color:var(--color-mineral)] shadow-[var(--mk-shadow-frame)]"
          : "border-[color:var(--color-hairline)]"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <Subtitle as="h2" className="text-[1.375rem]">
          {plan.name}
        </Subtitle>
        {plan.badge ? <Chip>{plan.badge}</Chip> : null}
      </div>

      <p className="mt-4">
        <span className="text-[2rem] font-semibold text-ink">
          {plan.priceLabel ?? "Talk to us"}
        </span>
        {plan.cadence ? (
          <span className="text-[0.9375rem] text-muted"> {plan.cadence}</span>
        ) : null}
      </p>
      {plan.seats ? (
        <p className="mt-1 text-[0.875rem] text-muted">For {plan.seats}</p>
      ) : null}

      <p className="mt-4 text-[0.9375rem] leading-[1.55] text-muted">{plan.bestFor}</p>

      {plan.transition ? (
        <p className="mt-3 text-[0.875rem] leading-[1.5] text-[color:var(--color-mineral-deep)]">
          {plan.transition}
        </p>
      ) : null}
      {plan.id === "studio" ? (
        <p className="mt-3 text-[0.875rem] leading-[1.5] text-muted">
          Studio setup is completed through guided onboarding.
        </p>
      ) : null}

      <div className="mt-6">
        <CTAButton
          href={WALKTHROUGH.href}
          variant={featured ? "primary" : "outline"}
          event={ANALYTICS_EVENTS.foundingCtaClick}
          className="w-full"
        >
          {WALKTHROUGH.primaryLabelShort}
        </CTAButton>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <MarketingSurface>
      <SiteHeader />
      <main className="overflow-x-hidden">
        <Container className="pb-4 pt-14 lg:pt-20">
          <Reveal>
            <Eyebrow>Pricing</Eyebrow>
            <Display className="mt-4 max-w-3xl">
              Straightforward pricing, in Canadian dollars.
            </Display>
            <Lede className="mt-6 max-w-2xl">
              Founder-led setup and free standard client import on every plan. No setup
              fee, no contract, cancel anytime.
            </Lede>
          </Reveal>
        </Container>

        {/* Plans */}
        <Container className="pb-8 pt-8">
          <div className="grid gap-5 md:grid-cols-3">
            {PRICING_PLANS.map((plan, i) => (
              <Reveal as="div" key={plan.id} delay={i * 70}>
                <PlanCard plan={plan} />
              </Reveal>
            ))}
          </div>
          <p className="mt-5 text-[0.8125rem] text-muted">
            Prices in Canadian dollars (CAD). Setup and payment activation happen during a
            guided onboarding — there is no self-service checkout.
          </p>
        </Container>

        {/* Every plan includes */}
        <Section tone="warm">
          <Container className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
            <Reveal>
              <Eyebrow>Every plan includes</Eyebrow>
              <Title className="mt-4">The whole workflow, not a stripped-down tier.</Title>
              <Lede className="mt-5">
                Treatment memory, charting, intake, consent, and records are never held
                back to build a higher tier.
              </Lede>
              <div className="mt-6 flex flex-wrap gap-2">
                {PRICING_ASSURANCES.map((a) => (
                  <Chip key={a}>{a}</Chip>
                ))}
              </div>
            </Reveal>
            <Reveal delay={80}>
              <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                {INCLUDED.map((item) => (
                  <li key={item} className="flex gap-3 text-[0.9375rem] text-ink">
                    <span aria-hidden="true" className="mt-1 text-mineral">
                      •
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-6 text-[0.9375rem] leading-[1.6] text-muted">
                {PAYMENT_QUALIFIER} {REPLACES_STATEMENT}
              </p>
            </Reveal>
          </Container>
        </Section>

        {/* FAQ */}
        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Questions</Eyebrow>
              <Title className="mt-4">Pricing questions, answered.</Title>
            </Reveal>
            <dl className="mt-10">
              {FAQ.map((item, i) => (
                <Reveal as="div" key={item.q} delay={(i % 3) * 50}>
                  {i > 0 ? <Hairline className="my-6" /> : null}
                  <dt>
                    <Subtitle as="h3" className="text-[1.125rem]">
                      {item.q}
                    </Subtitle>
                  </dt>
                  <dd className="mt-2 text-[0.9375rem] leading-[1.6] text-muted">{item.a}</dd>
                </Reveal>
              ))}
            </dl>
            <p className="mt-8 text-[0.9375rem] text-muted">
              Still deciding?{" "}
              <Link
                href={`mailto:${CONTACT_EMAIL}`}
                className="font-medium text-mineral underline underline-offset-4"
              >
                Email us
              </Link>{" "}
              or request a walkthrough.
            </p>
          </Container>
        </Section>

        {/* Closing CTA */}
        <Section tone="band">
          <Container className="text-center">
            <Reveal>
              <Title className="mx-auto max-w-2xl text-paper">
                See Hone before you decide.
              </Title>
              <Lede onBand className="mx-auto mt-5 max-w-xl">
                We&apos;ll walk through your real workflow, set up guided onboarding, and
                reply within one business day.
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
    </MarketingSurface>
  );
}
