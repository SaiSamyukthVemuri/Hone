import type { Metadata } from "next";
import Link from "next/link";
import { Reveal } from "../_components/Reveal";
import { MarketingHeader } from "../_components/MarketingHeader";
import { MarketingFooter } from "../_components/MarketingFooter";
import { SafeAnalytics } from "../_components/SafeAnalytics";
import { EyebrowCaption } from "../_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "../_components/marketingNav";

// Page-specific metadata for /pricing. "absolute" skips the
// "%s · Hone" template since the title already contains the brand.
export const metadata: Metadata = {
  title: {
    absolute: "Hone Pricing | Electrolysis Practice Software",
  },
  description:
    "Founding pilot pricing for Hone. One plan covers booking, intake, treatment plans, session charting, postcare, and client history for electrolysis and permanent hair removal studios.",
  openGraph: {
    title: "Hone Pricing | Electrolysis Practice Software",
    description:
      "Founding pilot pricing for Hone. One plan covers booking, intake, treatment plans, session charting, postcare, and client history for electrolysis and permanent hair removal studios.",
  },
  twitter: {
    title: "Hone Pricing | Electrolysis Practice Software",
    description:
      "Founding pilot pricing for Hone. One plan covers booking, intake, treatment plans, session charting, postcare, and client history for electrolysis and permanent hair removal studios.",
  },
};

type Plan = {
  name: string;
  price: string;
  cadence: string | null;
  pitch: string;
  bestFor: string;
  features: ReadonlyArray<string>;
  cta: { label: string; href: string };
  emphasized: boolean;
};

// Single founding-pilot plan. The previous Early Access framing is
// kept honest by naming the plan "Founding Pilot" and telling people
// the price may go up after early access. Founder-led setup is the
// first feature bullet so it cannot be missed.
const PLAN: Plan = {
  name: "Founding Pilot",
  price: "$19",
  cadence: "/month",
  pitch:
    "One price for booking, intake, treatment plans, charting, postcare, and client history. Founder-led setup and onboarding. Regular pricing may increase after early access. Cancel anytime.",
  bestFor:
    "Best for solo electrologists and small permanent hair removal studios that want to move beyond paper notes or generic booking tools.",
  features: [
    "Founder-led setup and onboarding",
    "Unlimited clients and sessions",
    "One-page electrolysis charting with structured probe picker",
    "Thermolysis, blend, and galvanic readings, plus laser charting",
    "Treatment plans with clearing, control, and maintenance stages",
    "Client history with practitioner-only private warnings",
    "Public booking page, calendar, services, availability, and blockouts",
    "Health intake link, intake review, and manual postcare email",
    "Self-serve cancel and reschedule with email confirmations",
    "Full data export any time",
  ],
  cta: { label: "Book a walkthrough", href: "/demo" },
  emphasized: true,
};

const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "What does the Founding Pilot cost?",
    a: "$19 per month while we onboard the first wave of studios. Regular pricing may increase after early access. No setup fees, no contracts, and you can cancel anytime.",
  },
  {
    q: "Is there a founding annual option?",
    a: "Yes. A founding annual option of $149 per year is available for the first 25 studios. We confirm billing details during onboarding.",
  },
  {
    q: "How does billing work?",
    a: "Monthly by default. The founding annual option bills once for the year. No setup fees, no contracts, cancel anytime.",
  },
  {
    q: "Does Hone include booking, or do I need a separate tool?",
    a: "Hone includes booking. Public booking page, calendar, services, availability management, automated confirmations, one-click cancellation. You do not need Calendly, Jane, or Square Appointments on top.",
  },
  {
    q: "Does Hone include intake and postcare?",
    a: "Yes. Hone sends a health intake link with each booking, lets you review the response, and supports a manual postcare email you write once and send per appointment.",
  },
  {
    q: "Do I get help setting up?",
    a: "Yes. Every Founding Pilot studio gets founder-led setup and onboarding. We walk you through configuring your booking link, services, availability, intake, and postcare so you can run your first real session on Hone without guesswork.",
  },
  {
    q: "Can I import my existing client list?",
    a: "Yes. If your clients live in a spreadsheet or another tool that exports CSV, we will help migrate them in.",
  },
  {
    q: "What if I have more than five practitioners?",
    a: "Contact us at hello@hone.care. We will set up a plan that fits a larger studio or multi location clinic.",
  },
  {
    q: "Is my data mine?",
    a: "Yes. Always. You can export the entire history of your studio at any time. If you cancel, your data goes with you.",
  },
  {
    q: "What about US healthcare compliance?",
    a: "Hone is operated from Canada with infrastructure in AWS US-East-1, as described in the Privacy Policy. If your clinic has specific US healthcare compliance requirements, contact us before onboarding so we can confirm fit.",
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
      <PricingCard />
      <PricingTrust />
      <PricingFAQ />
      <MarketingFooter />
      {/* PR #142. Safe marketing page (no token in URL). */}
      <SafeAnalytics />
    </main>
  );
}

function PricingHero() {
  return (
    <Reveal as="section" className="px-6 pb-12 pt-24 md:px-12 md:pb-16 md:pt-32 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Founding pilot pricing</EyebrowCaption>
        <h1
          className="font-[var(--font-fraunces)] mt-10 max-w-[900px] text-[52px] font-bold leading-[0.96] md:text-[88px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          One plan for the whole electrolysis workflow.
        </h1>
        <p className="mt-10 max-w-[680px] text-[18px] leading-[1.55] md:text-[21px]">
          Hone is in early pilot for solo electrologists and small studios.
          One price covers booking, intake, treatment plans, session
          charting, postcare, and client history. Founder-led setup.
          Cancel anytime.
        </p>
      </div>
    </Reveal>
  );
}

// Single, centred card. Layout left-stacks price and best-for; right
// shows the feature list. Cleaner read than a 3-column grid for a
// one-plan page.
function PricingCard() {
  const plan = PLAN;
  return (
    <Reveal as="section" className="px-6 py-16 md:px-12 md:py-24 lg:px-16">
      <div className="mx-auto max-w-[1100px]">
        <div
          className="grid grid-cols-1 gap-10 p-8 md:grid-cols-12 md:p-10"
          style={{ border: `2px solid ${PALETTE.ink}` }}
        >
          <div className="flex flex-col gap-6 md:col-span-5">
            <p
              className="text-[12px] font-medium uppercase"
              style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
            >
              {plan.name}
            </p>
            <p
              className="font-[var(--font-fraunces)] text-[56px] font-bold leading-none"
              style={{ letterSpacing: "-0.03em" }}
            >
              {plan.price}
              {plan.cadence && (
                <span
                  className="ml-2 align-baseline text-[18px] font-normal"
                  style={{ color: PALETTE.muted, letterSpacing: 0 }}
                >
                  {plan.cadence}
                </span>
              )}
            </p>
            <p
              className="text-[15px] leading-[1.6]"
              style={{ color: PALETTE.muted }}
            >
              {plan.pitch}
            </p>
            <p
              className="rounded-md p-4 text-[14px] leading-[1.55]"
              style={{
                backgroundColor: PALETTE.card,
                border: `1px solid ${PALETTE.rule}`,
              }}
            >
              <span
                className="block text-[11px] font-medium uppercase"
                style={{ letterSpacing: "0.18em", color: PALETTE.muted }}
              >
                Best for
              </span>
              <span className="mt-2 block">{plan.bestFor}</span>
            </p>
            <div className="pt-2">
              <Link
                href={plan.cta.href}
                className="inline-flex items-center justify-center px-7 py-3.5 text-[14px] font-medium uppercase transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                style={{
                  backgroundColor: PALETTE.ink,
                  color: PALETTE.bg,
                  letterSpacing: "0.18em",
                }}
              >
                {plan.cta.label}
              </Link>
            </div>
          </div>

          <div className="md:col-span-7">
            <p
              className="text-[11px] font-medium uppercase"
              style={{ letterSpacing: "0.18em", color: PALETTE.muted }}
            >
              What is included
            </p>
            <ul className="mt-4 flex flex-col gap-3 text-[15px] leading-[1.55]">
              {plan.features.map((f) => (
                <li
                  key={f}
                  className="flex items-baseline gap-3 border-b pb-3"
                  style={{ borderColor: PALETTE.rule }}
                >
                  <span aria-hidden style={{ color: PALETTE.muted }}>
                    ·
                  </span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

function PricingTrust() {
  return (
    <Reveal as="section" className="px-6 py-16 md:px-12 md:py-24 lg:px-16">
      <div className="mx-auto max-w-[1100px]">
        <EyebrowCaption>How your data is handled</EyebrowCaption>
        <div className="mt-8 grid grid-cols-1 gap-8 md:grid-cols-2">
          <div>
            <h3 className="text-[17px] font-medium">Your data, your studio.</h3>
            <p className="mt-2 text-[15px] leading-[1.6]" style={{ color: PALETTE.muted }}>
              Export the full history of your studio any time. If you
              cancel, your data goes with you.
            </p>
          </div>
          <div>
            <h3 className="text-[17px] font-medium">No selling, no ads, no AI training.</h3>
            <p className="mt-2 text-[15px] leading-[1.6]" style={{ color: PALETTE.muted }}>
              Hone does not sell client data, use health records for
              advertising, or train AI models on practitioner or client
              records. Spelled out in the{" "}
              <Link href="/privacy" className="underline">
                privacy policy
              </Link>
              .
            </p>
          </div>
        </div>
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
