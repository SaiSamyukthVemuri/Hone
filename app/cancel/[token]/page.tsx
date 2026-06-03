import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PublicPolicyReminderCard } from "@/app/_components/PublicPolicyReminderCard";
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
      <section className="px-6 py-20 md:px-12 lg:px-16">
        <div className="mx-auto max-w-[640px] flex flex-col gap-10">
          {result.ok ? (
            // Valid future-confirmed appointment. Show heading +
            // summary card + reassuring copy + the cancel form.
            <>
              <div>
                <EyebrowCaption>Cancel appointment</EyebrowCaption>
                <h1
                  className="font-[var(--font-fraunces)] mt-8 text-[36px] font-bold leading-tight md:text-[48px]"
                  style={{ letterSpacing: "-0.025em" }}
                >
                  Cancel appointment
                </h1>
                <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">
                  If you cancel, the studio will be notified.
                </p>
              </div>

              {/* Appointment summary card. Same fields the action
                  already returns; no address (security collapse
                  intentionally omits address). */}
              <dl
                className="flex flex-col gap-3 p-6"
                style={{
                  backgroundColor: "#FAFAF7",
                  border: "1px solid #E5E2D9",
                }}
              >
                <SummaryRow label="Service">
                  {result.summary.serviceName}
                </SummaryRow>
                <SummaryRow label="When">
                  <FormattedDateTime iso={result.summary.startsAt} />
                </SummaryRow>
                <SummaryRow label="Where">
                  {result.summary.studioName}
                </SummaryRow>
              </dl>

              {/* Studio policies shown before the cancel action so
                  the client sees the cancellation/no-show rules
                  before committing. Reminder/display only; the
                  cancel action is not gated on policy presence and
                  the card renders nothing when both fields are
                  empty so we never show a blank heading. */}
              <PublicPolicyReminderCard
                cancellationPolicyText={result.summary.cancellationPolicyText}
                noShowPolicyText={result.summary.noShowPolicyText}
                studioName={result.summary.studioName}
              />

              <CancelForm token={token} />
            </>
          ) : (
            // Public collapse surface: a single generic message is
            // shown for unknown / expired / cancelled / completed /
            // no_show / past-start tokens. The fetch action collapses
            // all of these to PUBLIC_CANCEL_GENERIC_ERROR before this
            // page renders; we additionally restate that as warmer
            // human copy so the visitor isn't left with a cold
            // "unavailable" message.
            <UnavailableMessage
              eyebrow="Cancel appointment"
              headline="This cancellation link can't be used right now."
              body="If you already cancelled, rescheduled, or the appointment has passed, no action is needed. You can contact the studio if you still need help."
            />
          )}
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}

function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
      <dt
        className="flex-none text-[11px] font-medium uppercase sm:w-20"
        style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
      >
        {label}
      </dt>
      <dd className="text-[15px] text-[#0A0A0A]">{children}</dd>
    </div>
  );
}

function UnavailableMessage({
  eyebrow,
  headline,
  body,
}: {
  eyebrow: string;
  headline: string;
  body: string;
}) {
  return (
    <div>
      <EyebrowCaption>{eyebrow}</EyebrowCaption>
      <h1
        className="font-[var(--font-fraunces)] mt-8 text-[28px] font-bold leading-tight md:text-[36px]"
        style={{ letterSpacing: "-0.02em" }}
      >
        {headline}
      </h1>
      <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">{body}</p>
    </div>
  );
}
