import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { clientPortalDisabledMessage } from "@/lib/booking/client-self-service-policy";

// HON-47. The one surface every portal entry point renders when the studio has
// turned client portal access off: the portal page itself, magic-link verify,
// and the studio-scoped sign-in page. It offers no sign-in or "request a new
// link" step, because none would work; it says how to reach the studio instead.
export function PortalAccessDisabled({
  studioName,
}: {
  studioName: string | null;
}) {
  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <section className="px-6 py-20 md:px-12 lg:px-16">
        <div className="mx-auto max-w-[520px] flex flex-col gap-8">
          <div>
            <EyebrowCaption>Client portal</EyebrowCaption>
            <h1
              className="font-[var(--font-fraunces)] mt-8 text-[28px] font-bold leading-tight md:text-[36px]"
              style={{ letterSpacing: "-0.02em" }}
            >
              Online client access isn&rsquo;t available.
            </h1>
            <p
              className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]"
              data-testid="portal-access-disabled"
            >
              {clientPortalDisabledMessage(studioName)}
            </p>
          </div>
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
