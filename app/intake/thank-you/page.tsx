import { MarketingHeader } from "@/app/_components/MarketingHeader";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";

export default function IntakeThankYouPage() {
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
      <section className="px-6 py-20 md:px-12 lg:px-16">
        <div className="mx-auto flex max-w-[640px] flex-col gap-6">
          <EyebrowCaption>Thank you</EyebrowCaption>
          <h1
            className="font-[var(--font-fraunces)] text-[36px] font-bold leading-tight md:text-[48px]"
            style={{ letterSpacing: "-0.025em" }}
          >
            Your intake is submitted.
          </h1>
          <p className="text-[16px] leading-relaxed text-[#0A0A0A]">
            Your electrologist will review your intake before your appointment.
            If they have questions, they will reach out.
          </p>
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
