import { MarketingHeader } from "@/app/_components/MarketingHeader";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { fetchAppointmentForCancelAction } from "./actions";
import { CancelForm } from "./CancelForm";

export default async function CancelAppointmentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchAppointmentForCancelAction(token);

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
        <div className="mx-auto max-w-[640px] flex flex-col gap-10">
          <div>
            <EyebrowCaption>Cancel appointment</EyebrowCaption>
            {result.ok ? (
              <>
                <h1
                  className="font-[var(--font-fraunces)] mt-8 text-[36px] font-bold leading-tight md:text-[48px]"
                  style={{ letterSpacing: "-0.025em" }}
                >
                  {result.summary.serviceName}
                </h1>
                <p className="mt-4 text-[15px] text-[#6B6B6B]">
                  At {result.summary.studioName} ·{" "}
                  <FormattedDateTime iso={result.summary.startsAt} />
                </p>
              </>
            ) : (
              <h1
                className="font-[var(--font-fraunces)] mt-8 text-[36px] font-bold leading-tight md:text-[40px]"
                style={{ letterSpacing: "-0.025em" }}
              >
                Cancellation link unavailable.
              </h1>
            )}
          </div>
          {result.ok ? (
            <CancelForm token={token} />
          ) : (
            // Public collapse surface: a single generic message is
            // shown for unknown / expired / cancelled / completed /
            // no_show / past-start tokens. The fetch action collapses
            // all of these to PUBLIC_CANCEL_GENERIC_ERROR before this
            // page renders.
            <p className="text-[16px] text-[#0A0A0A]">{result.error}</p>
          )}
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
