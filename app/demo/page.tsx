import type { Metadata } from "next";
import { Reveal } from "../_components/Reveal";
import { MarketingHeader } from "../_components/MarketingHeader";
import { MarketingFooter } from "../_components/MarketingFooter";
import { SafeAnalytics } from "../_components/SafeAnalytics";
import { EyebrowCaption } from "../_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "../_components/marketingNav";
import { DemoForm } from "../_components/DemoForm";

// Page-specific metadata so /demo does not inherit the generic root
// title via the "%s · Hone" template. The route stays /demo for
// inbound link stability but every label on the page reads as a
// founder-led walkthrough, not a recorded demo.
export const metadata: Metadata = {
  title: {
    absolute: "Hone Walkthrough | Electrolysis Booking, Intake, and Charting",
  },
  description:
    "Book a 15-minute founder-led walkthrough of Hone. We walk through booking, intake, treatment plans, session charting, postcare, and the calendar for electrologists.",
  openGraph: {
    title: "Hone Walkthrough | Electrolysis Booking, Intake, and Charting",
    description:
      "Book a 15-minute founder-led walkthrough of Hone. We walk through booking, intake, treatment plans, session charting, postcare, and the calendar for electrologists.",
  },
  twitter: {
    title: "Hone Walkthrough | Electrolysis Booking, Intake, and Charting",
    description:
      "Book a 15-minute founder-led walkthrough of Hone. We walk through booking, intake, treatment plans, session charting, postcare, and the calendar for electrologists.",
  },
};

export default function DemoPage() {
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
      <WalkthroughHero />
      <MarketingFooter />
      {/* PR #142. Safe marketing page (no token in URL). */}
      <SafeAnalytics />
    </main>
  );
}

const WHAT_HAPPENS: ReadonlyArray<{ step: string; body: string }> = [
  {
    step: "1",
    body: "We learn how your studio currently handles booking and charting.",
  },
  {
    step: "2",
    body: "We walk through the client, appointment, treatment plan, and session workflow in the real app.",
  },
  {
    step: "3",
    body: "We decide together whether Hone is a good fit for your pilot.",
  },
];

function WalkthroughHero() {
  return (
    <Reveal
      as="section"
      className="px-6 pb-24 pt-24 md:px-12 md:pb-32 md:pt-32 lg:px-16"
    >
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-16 gap-y-16 md:grid-cols-12">
        <div className="md:col-span-6">
          <EyebrowCaption>Walkthrough</EyebrowCaption>
          <h1
            className="font-[var(--font-fraunces)] mt-10 max-w-[640px] text-[44px] font-bold leading-[0.98] md:text-[68px]"
            style={{ letterSpacing: "-0.04em" }}
          >
            Book a 15-minute Hone walkthrough.
          </h1>
          <p className="mt-10 max-w-[560px] text-[18px] leading-[1.55] md:text-[21px]">
            Fifteen minutes on Zoom with a founder. The real app, no slides
            and no recorded demo. Bring one or two of your typical client
            scenarios so we can walk through them together.
          </p>

          <div className="mt-12">
            <p
              className="text-[11px] font-medium uppercase"
              style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
            >
              What happens next
            </p>
            <ol className="mt-5 flex flex-col gap-5">
              {WHAT_HAPPENS.map((s) => (
                <li
                  key={s.step}
                  className="flex items-start gap-4 text-[16px] leading-[1.55]"
                >
                  <span
                    className="font-[var(--font-fraunces)] text-[20px] font-bold"
                    aria-hidden
                    style={{ color: PALETTE.muted, letterSpacing: "-0.02em" }}
                  >
                    {s.step}.
                  </span>
                  <span>{s.body}</span>
                </li>
              ))}
            </ol>
          </div>

          <p
            className="mt-10 max-w-[560px] text-[14px] leading-[1.6]"
            style={{ color: PALETTE.muted }}
          >
            No sales pressure. The goal is to see whether Hone actually
            fits your practice. If it does not, we will say so.
          </p>
        </div>

        <div className="md:col-span-6">
          <div
            className="p-6 md:p-8"
            style={{
              backgroundColor: PALETTE.card,
              border: `1px solid ${PALETTE.rule}`,
            }}
          >
            <p
              className="text-[11px] font-medium uppercase"
              style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
            >
              Tell us a little about your practice
            </p>
            <p
              className="mt-2 text-[14px] leading-[1.55]"
              style={{ color: PALETTE.muted }}
            >
              We use this to tailor the walkthrough to your studio. We
              reply within one business day to book a time.
            </p>
            <div className="mt-8">
              <DemoForm />
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}
