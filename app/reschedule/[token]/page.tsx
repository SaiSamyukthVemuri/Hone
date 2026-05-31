import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { fetchAppointmentForRescheduleAction } from "./actions";
import { RescheduleForm } from "./RescheduleForm";

export default async function ReschedulePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchAppointmentForRescheduleAction(token);

  // Public collapse: ALL of (invalid token, expired token, already-used
  // token, cancelled appointment, completed appointment, no-show
  // appointment, past-start appointment) render the same generic
  // message. Previously a cancelled/past appointment was rendered with
  // its real service + studio + time and a distinct "can no longer be
  // rescheduled" paragraph, which let a token-probing visitor confirm
  // the token was valid even when the appointment was no longer
  // eligible. The cancel page already enforces this collapse inside
  // its fetch action (PUBLIC_CANCEL_GENERIC_ERROR); this page enforces
  // the equivalent collapse at the render layer because the
  // reschedule fetch action returns the appointment status field so
  // the form can display range/duration. We deliberately do NOT show
  // serviceName / studioName / startsAt when the appointment is not
  // currently reschedulable.
  const isReschedulable =
    result.ok &&
    result.summary.status === "confirmed" &&
    new Date(result.summary.startsAt).getTime() > Date.now();

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
        <div className="mx-auto max-w-[760px] flex flex-col gap-10">
          {isReschedulable && result.ok ? (
            // Valid future-confirmed appointment. Show heading +
            // summary card + helper copy + the slot picker.
            <>
              <div>
                <EyebrowCaption>Reschedule appointment</EyebrowCaption>
                <h1
                  className="font-[var(--font-fraunces)] mt-8 text-[36px] font-bold leading-tight md:text-[48px]"
                  style={{ letterSpacing: "-0.025em" }}
                >
                  Reschedule appointment
                </h1>
                <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">
                  Choose a new time that works better for you.
                </p>
              </div>

              {/* Current appointment summary. No address — the
                  reschedule fetch action intentionally does not
                  return that field, same security stance as cancel. */}
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
                <SummaryRow label="Currently">
                  <FormattedDateTime iso={result.summary.startsAt} />
                </SummaryRow>
                <SummaryRow label="Where">
                  {result.summary.studioName}
                </SummaryRow>
              </dl>

              <RescheduleForm
                token={token}
                durationMinutes={result.summary.durationMinutes}
                studioTimezone={result.summary.studioTimezone}
                studioPublicBookingHorizonMonths={
                  result.summary.studioPublicBookingHorizonMonths
                }
              />
            </>
          ) : (
            // Collapsed unavailable surface. Identical render for
            // every non-reschedulable case. Does NOT expose whether
            // the token resolved, what status the appointment is in,
            // or whether the start time has passed.
            <UnavailableMessage
              eyebrow="Reschedule appointment"
              headline="This reschedule link can't be used right now."
              body="If you already changed this appointment, cancelled it, or the appointment has passed, no action is needed. You can contact the studio if you still need help."
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
        className="flex-none text-[11px] font-medium uppercase sm:w-24"
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
