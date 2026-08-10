import type { Metadata } from "next";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PublicPolicyReminderCard } from "@/app/_components/PublicPolicyReminderCard";
import {
  buildPolicySnapshot,
  hasAnyPolicy,
} from "@/lib/booking/policy-acknowledgement";
import { fetchAppointmentForCancelAction } from "./actions";
import { CancelForm } from "./CancelForm";

// PR #142. Token-bearing route. See
// app/portal/verify/[token]/page.tsx for the full rationale.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

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

              {/* PR #133. The acknowledgement checkbox + the server-
                  side ack gate fire only when the studio has at
                  least one policy configured. A studio with no
                  policy text shows no policy card above, no
                  checkbox below, and the cancel action accepts the
                  submit without acknowledgement and writes no
                  acknowledgement row. The server action re-checks
                  the same predicate against the resolved studio
                  row; the prop here is the page hint that keeps the
                  UI honest. */}
              {/* B7 / 0176. Hash EXACTLY the policy this render is about
                  to display, and post it back as a server-generated
                  hidden field. The command re-derives the current hash
                  under a studio row lock and refuses on mismatch, so a
                  policy edited between render and submit can never be
                  acknowledged as though it had been read.

                  The hash is computed UNCONDITIONALLY — including when
                  the studio has no policy at all, where it is the hash
                  of the empty snapshot. That is what lets the command
                  catch a policy ADDED or REMOVED mid-flight; reschedule
                  only needed the has-policy case, cancellation needs
                  both directions. The browser never supplies policy
                  text and never computes the authoritative hash. */}
              <CancelForm
                token={token}
                presentedPolicyHash={
                  buildPolicySnapshot({
                    cancellationPolicyText:
                      result.summary.cancellationPolicyText,
                    noShowPolicyText: result.summary.noShowPolicyText,
                  }).policySnapshotHash
                }
                requiresAcknowledgement={hasAnyPolicy({
                  cancellationPolicyText:
                    result.summary.cancellationPolicyText,
                  noShowPolicyText: result.summary.noShowPolicyText,
                })}
              />
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
