import type { Metadata } from "next";
import { Reveal } from "../_components/Reveal";
import { MarketingHeader } from "../_components/MarketingHeader";
import { MarketingFooter } from "../_components/MarketingFooter";
import { EyebrowCaption } from "../_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "../_components/marketingNav";
import { DemoForm } from "../_components/DemoForm";

// Page-specific metadata so the /demo route does not inherit the
// generic root title via the "%s · Hone" template. "absolute" opts
// out of the template entirely. The route is /demo for inbound link
// stability, but everything else on the page reads as a founder-led
// walkthrough request: no demo video, no recorded screencast.
export const metadata: Metadata = {
  title: {
    absolute: "Hone Walkthrough | Electrolysis Booking, Intake, and Charting",
  },
  description:
    "Request a founder-led walkthrough of Hone's booking, intake, treatment plans, session notes, postcare, and calendar workflow for electrologists.",
  openGraph: {
    title: "Hone Walkthrough | Electrolysis Booking, Intake, and Charting",
    description:
      "Request a founder-led walkthrough of Hone's booking, intake, treatment plans, session notes, postcare, and calendar workflow for electrologists.",
  },
  twitter: {
    title: "Hone Walkthrough | Electrolysis Booking, Intake, and Charting",
    description:
      "Request a founder-led walkthrough of Hone's booking, intake, treatment plans, session notes, postcare, and calendar workflow for electrologists.",
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
      <DemoHero />
      <MarketingFooter />
    </main>
  );
}

function DemoHero() {
  return (
    <Reveal
      as="section"
      className="px-6 pb-32 pt-24 md:px-12 md:pb-40 md:pt-32 lg:px-16"
    >
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Request a walkthrough</EyebrowCaption>
        <h1
          className="font-[var(--font-fraunces)] mt-10 max-w-[820px] text-[56px] font-bold leading-[0.92] md:text-[92px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          Walk me through
          <br />
          Hone, please.
        </h1>
        {/* No demo video exists today. The page is honest about that:
            it offers a live, founder-led walkthrough rather than a
            recorded demo, so "Request a walkthrough" matches what the
            form actually does. Copy emphasises real app, no slides. */}
        <p className="mt-10 max-w-[640px] text-[18px] leading-[1.55] md:text-[21px]">
          Fifteen minutes on Zoom with a founder. The real app, no slides
          and no recorded demo. We&rsquo;ll walk through how Hone handles
          booking, intake, treatment plans, charting, postcare, and the
          calendar, and answer anything specific to your studio.
        </p>

        <div className="mt-16 max-w-[560px]">
          <DemoForm />
        </div>
      </div>
    </Reveal>
  );
}
