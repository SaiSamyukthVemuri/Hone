import { Reveal } from "../_components/Reveal";
import { MarketingHeader } from "../_components/MarketingHeader";
import { MarketingFooter } from "../_components/MarketingFooter";
import { EyebrowCaption } from "../_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "../_components/marketingNav";
import { DemoForm } from "../_components/DemoForm";

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
        <EyebrowCaption>Request a demo</EyebrowCaption>
        <h1
          className="font-[var(--font-fraunces)] mt-10 max-w-[800px] text-[56px] font-bold leading-[0.92] md:text-[92px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          Show me how
          <br />
          this works.
        </h1>
        <p className="mt-10 max-w-[640px] text-[18px] leading-[1.55] md:text-[21px]">
          Fifteen minutes on Zoom. Real app, no slides. We&rsquo;ll show you
          how Hone remembers what you did last session and what settings
          worked, runs your booking and calendar, tracks treatment plans and
          progress, and charts a full session on one screen.
        </p>

        <div className="mt-16 max-w-[560px]">
          <DemoForm />
        </div>
      </div>
    </Reveal>
  );
}
