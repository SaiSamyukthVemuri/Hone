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

const PLANS: ReadonlyArray<Plan> = [
  {
    name: "Solo",
    price: "$25",
    cadence: "/ month",
    pitch: "For the single-practitioner studio.",
    features: [
      "Unlimited clients and sessions",
      "Full charting for electrolysis and laser",
      "Public booking page with your studio link",
      "Calendar with services, availability, and blockouts",
      "Automated booking confirmations and cancellations",
      "Per-client pricing and packages",
      "Export anytime",
    ],
    cta: { label: "Request access", href: "/#request-access" },
    emphasized: false,
  },
  {
    name: "Studio",
    price: "$49",
    cadence: "/ month",
    pitch: "For studios with up to five practitioners.",
    features: [
      "All Solo features, plus:",
      "Up to 5 practitioner seats",
      "Multi-practitioner studio management",
      "Multiple practitioners on the booking page (clients pick who they want)",
      "Audit-ready export for inspections",
      "Priority email support",
    ],
    cta: { label: "Request access", href: "/#request-access" },
    emphasized: true,
  },
  {
    name: "Clinic",
    price: "Contact us",
    cadence: null,
    pitch: "For larger studios and multi location clinics.",
    features: [
      "More than five practitioners",
      "Custom onboarding",
      "Custom data migration support",
      "Dedicated contact",
    ],
    cta: { label: "Request a demo", href: "/demo" },
    emphasized: false,
  },
];

const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "Is there a free trial?",
    a: "First month free for every plan. If it's not right for your clinic, cancel and you owe nothing.",
  },
  {
    q: "How does billing work?",
    a: "Monthly, charged on the day you start. Stripe handles payments. No setup fees, no contracts, cancel anytime.",
  },
  {
    q: "Does Hone include booking, or do I need a separate tool?",
    a: "Hone includes booking. Public booking page, calendar, services, availability management, automated confirmations, one-click cancellation. You don't need Calendly or Jane or Square Appointments on top.",
  },
  {
    q: "Can I import my existing client list?",
    a: "Yes. If your clients live in a spreadsheet or another tool that exports CSV, we'll help migrate them in.",
  },
  {
    q: "What if I have more than five practitioners?",
    a: "Contact us. We'll set up a plan that fits your studio.",
  },
  {
    q: "Is my data mine?",
    a: "Yes. Always. You can export the entire history of your studio at any time. If you cancel, your data goes with you.",
  },
  {
    q: "Is Hone HIPAA compliant?",
    a: "Hone stores client charting data in a Canadian cloud region with strong access controls. We are not currently a HIPAA covered entity. For US clinics that require HIPAA compliance, contact us before signing up.",
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
        <EyebrowCaption>Pricing</EyebrowCaption>
        <h1
          className="font-[var(--font-fraunces)] mt-10 max-w-[800px] text-[56px] font-bold leading-[0.92] md:text-[92px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          Honest pricing.
          <br />
          No seat creep.
        </h1>
        <p className="mt-10 max-w-[640px] text-[18px] leading-[1.55] md:text-[21px]">
          Three plans. Charged per studio, not per click. Cancel anytime. Your
          data is yours, always.
        </p>
      </div>
    </Reveal>
  );
}

function PricingCards() {
  return (
    <Reveal as="section" className="px-6 py-16 md:px-12 md:py-24 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
          calendar, and cancellation built in. Your data exportable any time.
          No setup fees. No contracts.
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
