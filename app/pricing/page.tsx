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
  CTAButton,
} from "../_components/marketing/primitives";
import { JsonLd, Breadcrumbs } from "../_components/marketing/JsonLd";
import { faqPageLd } from "@/lib/marketing/jsonld";
import {
  POSITIONING,
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

function PlanColumn({ plan }: { plan: (typeof PRICING_PLANS)[number] }) {
  // EVERY PLAN IS RENDERED IDENTICALLY. The emphasised border and shadow were
  // driven by the badge, so one tier appeared recommended by styling alone.
  //
  // A PRICE LIST, NOT THREE CARDS — the same ruled columns the homepage uses,
  // sharing one top rule. Each plan used to carry its own identical "Request a
  // walkthrough" button: three copies of one action, side by side, with nothing
  // to choose between. The single request below the list is the same action.
  return (
    <div className="flex flex-col border-b border-[color:var(--color-hairline)] py-6 sm:px-7 sm:[&:first-child]:pl-0 sm:[&:last-child]:pr-0 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:border-[color:var(--color-hairline)]">
      <Subtitle as="h2">{plan.name}</Subtitle>

      <p className="mt-3">
        <span className="text-[2rem] font-semibold leading-[1.15] text-ink">
          {plan.priceLabel ?? "Talk to us"}
        </span>
        {plan.cadence ? (
          <span className="text-[0.9375rem] text-muted"> {plan.cadence}</span>
        ) : null}
      </p>
      {plan.seats ? (
        <p className="mt-1 text-[0.9375rem] text-muted">For {plan.seats}</p>
      ) : null}

      <p className="mt-4 text-[1rem] leading-[1.55] text-ink">{plan.bestFor}</p>

      {plan.transition ? (
        <p className="mt-3 text-[0.9375rem] leading-[1.55] text-[color:var(--color-mineral-deep)]">
          {plan.transition}
        </p>
      ) : null}
      {plan.id === "studio" ? (
        <p className="mt-3 text-[0.9375rem] leading-[1.55] text-muted">
          Studio setup is completed through guided onboarding.
        </p>
      ) : null}
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
      <main id="main-content" className="scroll-mt-16">
        <Container className="pt-[clamp(1.25rem,0.75rem+2vw,2.75rem)]">
          <div>
            <Display className="max-w-[18ch]">
              Simple plans, in Canadian dollars.
            </Display>
            {/* THE SHARED CONSTANT, VERBATIM — never a local retyping of it.
                #762 established this sentence as verified product truth (a
                VERIFIED ABSENCE row in the truth register, checked against
                production `a5f3aa27`) and already publishes it in page
                metadata. Rendering the constant is what keeps the page, the
                metadata and the register saying one thing; a copy here would be
                a second string to drift, which is the failure this PR spent
                five rounds on.

                THE CLAIM IS EXACTLY THE ABSENCE THAT WAS VERIFIED: no cap on
                clients, no cap on appointments. It is not a storage claim, a
                usage quota, an SMS allowance, or the word "unlimited" — the
                register is explicit that absence of a plan cap is not a promise
                of infinite capacity, and the guard below holds that line. */}
            <Lede className="mt-5 max-w-[38rem]">{POSITIONING.noCapsLine}</Lede>
          </div>
        </Container>

        {/* Plans */}
        <Container className="pb-[var(--mk-section-pad)] pt-[clamp(1.75rem,1rem+2vw,3rem)]">
          <div className="grid grid-cols-1 border-t border-[color:var(--color-hairline-strong)] sm:grid-cols-3">
            {PRICING_PLANS.map((plan) => (
              <PlanColumn key={plan.id} plan={plan} />
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
          <p className="mt-3 text-[0.875rem] text-muted">
            Prices in Canadian dollars (CAD). Setup and payment activation happen during a
            guided onboarding, there is no self-service checkout.
          </p>
          <CTAButton
            href={WALKTHROUGH.href}
            event={ANALYTICS_EVENTS.primaryCtaClick}
            className="mt-7 max-sm:w-full"
          >
            {WALKTHROUGH.primaryLabel}
          </CTAButton>
        </Container>

        {/* Every plan includes */}
        <Section tone="warm">
          <Container className="grid gap-x-[clamp(2.5rem,5vw,5rem)] gap-y-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div>
              <Eyebrow>Every plan includes</Eyebrow>
              <Title className="mt-3">The whole workflow, not a stripped-down tier.</Title>
              <Lede className="mt-4">
                Treatment memory, charting, intake, consent, and records are never held
                back to build a higher tier.
              </Lede>
            </div>
            <div>
              <ul className="grid gap-x-8 border-t border-[color:var(--color-hairline-strong)] sm:grid-cols-2">
                {INCLUDED.map((item) => (
                  <li
                    key={item}
                    className="border-b border-[color:var(--color-hairline)] py-3 text-[1rem] leading-[1.5] text-ink"
                  >
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-[0.9375rem] leading-[1.6] text-muted">
                {PAYMENT_QUALIFIER} {REPLACES_STATEMENT}
              </p>
            </div>
          </Container>
        </Section>

        {/* FAQ */}
        <Section tone="paper">
          <Container className="grid gap-x-[clamp(2.5rem,5vw,5rem)] gap-y-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.7fr)]">
            <Title className="max-w-[14ch]">Pricing questions, answered.</Title>
            <div className="max-w-[64ch]">
              <dl className="border-t border-[color:var(--color-hairline-strong)]">
                {FAQ.map((item) => (
                  <div key={item.q} className="border-b border-[color:var(--color-hairline)] py-5">
                    <dt>
                      <Subtitle as="h3">{item.q}</Subtitle>
                    </dt>
                    <dd className="mt-2 text-[1rem] leading-[1.6] text-muted">{item.a}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-6 text-[0.9375rem] text-muted">
                Still deciding?{" "}
                <Link
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="font-medium text-mineral underline underline-offset-4"
                >
                  Email us
                </Link>{" "}
                or request a walkthrough.
              </p>
            </div>
          </Container>
        </Section>

        {/* Closing CTA */}
        <Section tone="band">
          <Container className="text-center">
            <Title className="mx-auto max-w-2xl text-paper">See Hone before you decide.</Title>
            <Lede onBand className="mx-auto mt-4 max-w-xl">
              We&apos;ll walk through your real workflow, set up guided onboarding, and reply
              within one business day.
            </Lede>
            <div className="mt-7 flex justify-center">
              <CTAButton
                href={WALKTHROUGH.href}
                onBand
                event={ANALYTICS_EVENTS.primaryCtaClick}
                className="max-sm:w-full"
              >
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
            </div>
          </Container>
        </Section>
      </main>
      <SiteFooter />
      <SafeAnalytics />
      <JsonLd data={faqPageLd(FAQ)} />
    </MarketingSurface>
  );
}
