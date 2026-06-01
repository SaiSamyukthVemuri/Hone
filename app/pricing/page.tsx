import Link from "next/link";
import { Reveal } from "../_components/Reveal";
import { MarketingHeader } from "../_components/MarketingHeader";
import { MarketingFooter } from "../_components/MarketingFooter";
import { EyebrowCaption } from "../_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "../_components/marketingNav";

type Plan = {
  name: string;
  price: string;
  cadence: string | null;
  pitch: string;
  features: ReadonlyArray<string>;
  cta: { label: string; href: string };
  emphasized: boolean;
};

// One simple early-access card. Previously we showed three hedged
// "Early access" tiles (Solo / Studio / Clinic) with no number on
// any of them; that made the pricing page read as a placeholder
// instead of a decision. The single card states a concrete monthly
// price and a founding-annual option for the first 25 studios, and
// the larger-studio path moves into the FAQ rather than a card.
const PLANS: ReadonlyArray<Plan> = [
  {
    name: "Early Access",
    price: "$19",
    cadence: "/month",
    pitch:
      "Founding annual option: $149/year for the first 25 studios. No setup fees, no contracts, cancel anytime.",
    features: [
      "Founder-led setup and onboarding",
      "Unlimited clients and sessions",
      "One-page electrolysis charting with structured probe picker",
      "Thermolysis, blend, and galvanic readings, plus laser charting",
      "Treatment plans, schedules, and progress tracking",
      "Client memory with practitioner-only private warnings",
      "Public booking page, calendar, services, availability, and blockouts",
      "Health intake link, intake review, and postcare email",
      "Self-serve cancel and reschedule with email confirmations",
      "Full data export any time",
    ],
    cta: { label: "Request access", href: "/#request-access" },
    emphasized: true,
  },
];

const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "What does Early Access cost?",
    a: "$19/month. A founding annual option of $149/year is available for the first 25 studios. No setup fees, no contracts, and you can cancel anytime.",
  },
  {
    q: "How does billing work?",
    a: "Monthly by default. The founding annual option bills once for the year. We confirm billing details with you during onboarding, and you can cancel anytime.",
  },
  {
    q: "Do I get help setting up?",
    a: "Yes. Every Early Access studio gets founder-led setup and onboarding. We walk you through configuring your booking link, services, availability, intake, and postcare so you can run your first session on Hone without guesswork.",
  },
  {
    q: "Does Hone include booking, or do I need a separate tool?",
    a: "Hone includes booking. Public booking page, calendar, services, availability management, automated confirmations, one-click cancellation. You don't need Calendly or Jane or Square Appointments on top.",
  },
  {
    q: "Does Hone include intake and postcare?",
    a: "Yes. Hone sends a health intake link with each booking, lets you review the response, and supports a manual postcare email you write once and send per appointment.",
  },
  {
    q: "Can I import my existing client list?",
    a: "Yes. If your clients live in a spreadsheet or another tool that exports CSV, we'll help migrate them in.",
  },
  {
    q: "What if I have more than five practitioners?",
    a: "Contact us at hello@hone.care. We'll set up a plan that fits a larger studio or multi location clinic.",
  },
  {
    q: "Is my data mine?",
    a: "Yes. Always. You can export the entire history of your studio at any time. If you cancel, your data goes with you.",
  },
  {
    q: "Does Hone meet US health-record requirements?",
    a: "Hone is operated from Canada. Data is stored on infrastructure in AWS US-East-1, as described in the Privacy Policy. Hone is not currently a US covered entity for health-record purposes. For US clinics with stricter health-record requirements, contact us before signing up.",
  },
];

export default function PricingPage() {
  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <MarketingHeader />
      <PricingHero />
      <PricingCards />
      <AllPlansInclude />
      <PricingFAQ />
      <MarketingFooter />
    </main>
  );
}

function PricingHero() {
  return (
    <Reveal as="section" className="px-6 pb-12 pt-24 md:px-12 md:pb-16 md:pt-32 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Early access pricing</EyebrowCaption>
        <h1
          className="font-[var(--font-fraunces)] mt-10 max-w-[800px] text-[56px] font-bold leading-[0.92] md:text-[92px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          One plan,
          <br />
          one number.
        </h1>
        <p className="mt-10 max-w-[640px] text-[18px] leading-[1.55] md:text-[21px]">
          Hone is in early access for solo electrologists and small studios.
          One plan with a clear monthly price, plus a founding annual option
          for the first 25 studios. No setup fees, no contracts, and your
          data is always yours.
        </p>
      </div>
    </Reveal>
  );
}

// Single card layout: the grid would visually advertise multiple
// options when only one exists. A centered, capped-width card reads
// as a clear pricing decision and stays balanced beside the wider
// hero and FAQ sections.
function PricingCards() {
  return (
    <Reveal as="section" className="px-6 py-16 md:px-12 md:py-24 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <div className="mx-auto max-w-[520px]">
          {PLANS.map((plan) => (
            <PlanCard key={plan.name} plan={plan} />
          ))}
        </div>
      </div>
    </Reveal>
  );
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div
      className="flex flex-col gap-6 p-8 md:p-10"
      style={
        plan.emphasized
          ? {
              border: `2px solid ${PALETTE.ink}`,
              // Pull the heavier border above the shared hairlines so it isn't clipped
              // by the neighbouring cards' 1px borders.
              position: "relative",
              zIndex: 1,
            }
          : {
              border: `1px solid ${PALETTE.rule}`,
            }
      }
    >
      <p
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
      >
        {plan.name}
      </p>
      <div>
        <p
          className="font-[var(--font-fraunces)] text-[48px] font-bold leading-none"
          style={{ letterSpacing: "-0.03em" }}
        >
          {plan.price}
          {plan.cadence && (
            <span
              className="ml-2 align-baseline text-[16px] font-normal"
              style={{ color: PALETTE.muted, letterSpacing: 0 }}
            >
              {plan.cadence}
            </span>
          )}
        </p>
        <p
          className="mt-3 text-[15px] leading-[1.55]"
          style={{ color: PALETTE.muted }}
        >
          {plan.pitch}
        </p>
      </div>

      <ul className="flex flex-1 flex-col gap-2 text-[15px] leading-[1.6]">
        {plan.features.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>

      <div className="pt-2">
        <Link
          href={plan.cta.href}
          className="text-[13px] font-medium uppercase hover:opacity-60"
          style={{ letterSpacing: "0.2em" }}
        >
          {plan.cta.label} →
        </Link>
      </div>
    </div>
  );
}

function AllPlansInclude() {
  return (
    <Reveal as="section" className="px-6 py-16 md:px-12 md:py-24 lg:px-16">
      <div className="mx-auto max-w-[700px] text-center">
        <p
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
        >
          All plans include
        </p>
        <p className="mt-5 text-[18px] leading-[1.65] md:text-[21px]">
          Magic link sign in. iPad, laptop, and phone support. Booking,
          calendar, charting, treatment plans, and self-serve cancel and
          reschedule built in. Your data exportable any time. No setup fees.
          No contracts.
        </p>
      </div>
    </Reveal>
  );
}

function PricingFAQ() {
  return (
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto max-w-[680px]">
        <EyebrowCaption>Questions</EyebrowCaption>
        <div className="mt-12 flex flex-col gap-12">
          {FAQ.map((item) => (
            <div key={item.q}>
              <h3 className="font-[var(--font-fraunces)] text-[22px] font-normal leading-[1.3]">
                {item.q}
              </h3>
              <p className="mt-3 text-[17px] leading-[1.6]">{item.a}</p>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}
