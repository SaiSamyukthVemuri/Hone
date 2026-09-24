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
  Subtitle,
  Lede,
  Hairline,
  CTAButton,
} from "../_components/marketing/primitives";
import { Reveal } from "../_components/marketing/Reveal";
import { JsonLd, Breadcrumbs } from "../_components/marketing/JsonLd";
import { faqPageLd } from "@/lib/marketing/jsonld";
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

// Pricing page, CAD, three plans, no artificial feature restrictions, no
// caps/quotas, no unsupported annual, no self-service checkout, no Google
// Calendar or multi-location claims. Core features are identical across plans;
// tiers differ only by who they're for and how many practitioners they cover.
// Grounded in docs/marketing/product-truth-register.md (Studio $99 decision).

export const metadata: Metadata = marketingMetadata("/pricing");

// Every plan includes the full workflow, plans are NOT feature-gated.
// Deck v2.2 enumerates nine inclusions. Each is rendered only because the truth
// register classifies it as marketable, and the register section is named so a
// reviewer can check the claim rather than the sentence:
//
//   treatment memory (§3) · charting (§2) · intake (§4) · consent (§4) ·
//   photos (§5) · follow-up (§5) · payments (§6) · client portal (§5) ·
//   CSV export (§8, narrowed by TRUTH-01A)
//
// PAYMENTS CARRIES ITS QUALIFIER IN THE BULLET, not only in the paragraph
// below the list. Standing rule §4 permits the claim exclusively WITH "Payments
// are enabled during guided onboarding", and a bullet is the unit that gets
// screenshotted, excerpted and read alone. Relying on adjacency would make the
// rule hold by layout.
const INCLUDED: string[] = [
  "Treatment memory, the Before Today briefing on every returning client",
  "Treatment charting for electrolysis and laser",
  "Client health intake",
  "Your own consent forms",
  "Private treatment photos and procedure records",
  "Client follow-up and postcare",
  `Owner-run card payments — ${PAYMENT_QUALIFIER}`,
  "The client portal",
  // TRUTH-01A: "Full data export" overstated a named-subset export. See
  // lib/export/resource-registry.ts for the authoritative contents.
  "CSV data export, any time, listing exactly what it includes",
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "How much does Hone cost?",
    a: "Founding Solo is CAD $29/month for your first 12 months, then CAD $39/month while you stay continuously subscribed. Solo is CAD $49/month. Studio is CAD $99/month for up to three practitioners. All prices are in Canadian dollars.",
  },
  {
    // NARROWED WITH ITS ANSWER. This asked "...or a contract?" and, once the
    // contract half of the answer went, the page put a question to the visitor
    // that it then declined to answer — and published that pairing as
    // FAQPage structured data. A question is a promise to answer it.
    q: "Is there a setup fee?",
    a: "No setup fee. Setup is founder-led during onboarding, and you can cancel anytime.",
  },
  {
    q: "What's included on each plan?",
    a: "Every plan includes the full Hone workflow, booking, intake and consent, charting, treatment memory, photos and records, and client follow-up. Plans differ by who they're for and how many practitioners they cover, not by locking features behind a higher tier.",
  },
  {
    q: "Can I bring my existing client history into Hone?",
    a: "Yes. Standard client import is free and part of guided onboarding, we help bring history over from paper cards, spreadsheets, or another tool.",
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
  // EVERY CARD IS RENDERED IDENTICALLY. The emphasised border and shadow were
  // driven by the badge, so one tier appeared recommended by styling alone.
  return (
    <div className="flex flex-col rounded-[12px] border border-[color:var(--color-hairline)] bg-white p-6 sm:p-7">
      <Subtitle as="h2" className="text-[1.375rem]">
        {plan.name}
      </Subtitle>

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

      <div className="mt-auto pt-6">
        {/* One variant for every plan: a primary button on a single card is a
            recommendation too, so the CTA no longer varies by tier. */}
        <CTAButton
          href={WALKTHROUGH.href}
          variant="outline"
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
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Pricing", path: "/pricing" },
        ]}
      />
      <main id="main-content" className="scroll-mt-16 overflow-x-hidden">
        <Container className="pb-4 pt-8 lg:pt-10">
          <Reveal immediate>
            <Eyebrow>Pricing</Eyebrow>
            <Display className="mt-4 max-w-3xl">
              Simple plans, in Canadian dollars.
            </Display>
            {/* DECK v2.2 ALSO SPECIFIED "No client caps. No appointment caps."
                THOSE TWO SENTENCES ARE DELIBERATELY NOT RENDERED.

                They are true of the product today — no tier/plan cap mechanism
                exists anywhere in the codebase; the only quota code is per-IP
                request limiting and the Google API's own limits. But this lane
                renders only claims the truth register verifies, and the
                register makes no caps statement of any kind. A claim that is
                true and unsourced is still unsourced, and "no caps" is a
                forward promise about packaging, not just a fact about today.

                `tests/app/marketing-pricing.test.ts` independently forbids the
                wording. Narrowing that guard so the sentence fits would be
                patching the rule at the spelling to admit the copy, which is
                the move this repository keeps finding in its own history.

                To publish it: record the claim in the truth register, then
                narrow the guard to forbid affirmative cap claims rather than
                the noun. Both are decisions for whoever owns the register. */}
            <Lede className="mt-6 max-w-2xl">
              Every plan includes the full treatment workflow.
            </Lede>
          </Reveal>
        </Container>

        {/* Plans */}
        <Container className="pb-8 pt-8">
          <div className="grid items-stretch gap-5 md:grid-cols-3">
            {PRICING_PLANS.map((plan) => (
              <PlanCard key={plan.id} plan={plan} />
            ))}
          </div>
          {/* A LIST, not a styled sentence. The separator is decorative and
              hidden, so a screen reader hears four assurances rather than one
              run-on line punctuated by middots. */}
          <ul className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-[0.9375rem] text-ink">
            {PRICING_ASSURANCES.map((a, i) => (
              <li key={a} className="flex items-center gap-3">
                {i > 0 ? (
                  <span aria-hidden="true" className="text-mineral">
                    ·
                  </span>
                ) : null}
                <span>{a}</span>
              </li>
            ))}
          </ul>
          <p className="mt-5 text-[0.8125rem] text-muted">
            Prices in Canadian dollars (CAD). Setup and payment activation happen during a
            guided onboarding, there is no self-service checkout.
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
      <JsonLd data={faqPageLd(FAQ)} />
    </MarketingSurface>
  );
}
