import type { Metadata } from "next";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PublicPolicyReminderCard } from "@/app/_components/PublicPolicyReminderCard";
import { hasAnyPolicy } from "@/lib/booking/policy-acknowledgement";
import {
  FREE_CONSULT_WAITLIST_ONLY_BODY,
  FREE_CONSULT_WAITLIST_ONLY_CODE,
  FREE_CONSULT_WAITLIST_ONLY_EYEBROW,
  FREE_CONSULT_WAITLIST_ONLY_HEADLINE,
} from "@/lib/booking/free-consult-reschedule-policy";
import { fetchAppointmentForRescheduleAction } from "./actions";
import { RescheduleForm } from "./RescheduleForm";

// PR #142. Token-bearing route. See
// app/portal/verify/[token]/page.tsx for the full rationale.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

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

  // EMERG-01. The one refusal that is NOT a collapse.
  //
  // The action attaches this code only after the token genuinely resolved to a
  // confirmed, future appointment whose server-resolved service and studio
  // prove the policy, so rendering a specific surface here discloses nothing a
  // token holder does not already hold. Every other refusal keeps the generic
  // "unavailable" render below, unchanged.
  //
  // WHAT THIS BRANCH MUST NOT DO, and does not: fetch slots, ask for the next
  // available date, or render RescheduleForm. Nothing on this page mutates —
  // the appointment stays confirmed, its reservation and its token untouched —
  // and the only way forward the visitor is offered is one they have to choose.
  const waitlistOnly =
    !result.ok && result.code === FREE_CONSULT_WAITLIST_ONLY_CODE;

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

              {/* Current appointment summary. No address: the
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

              {/* Studio policies shown before the reschedule slot
                  picker so the client sees the cancellation/no-show
                  rules before committing to a change. Reminder /
                  display only; the reschedule action is not gated on
                  policy presence and the card renders nothing when
                  both fields are empty. */}
              <PublicPolicyReminderCard
                cancellationPolicyText={result.summary.cancellationPolicyText}
                noShowPolicyText={result.summary.noShowPolicyText}
                studioName={result.summary.studioName}
              />

              {/* PR #133. The acknowledgement checkbox + the server-
                  side ack gate fire only when the studio has at
                  least one policy configured. A studio with no
                  policy text shows no policy card above, no
                  checkbox below, and the reschedule action accepts
                  the submit without acknowledgement and writes no
                  acknowledgement row. The server action re-checks
                  the same predicate against the resolved studio
                  row. */}
              <RescheduleForm
                token={token}
                durationMinutes={result.summary.durationMinutes}
                studioTimezone={result.summary.studioTimezone}
                studioPublicBookingHorizonMonths={
                  result.summary.studioPublicBookingHorizonMonths
                }
                requiresAcknowledgement={hasAnyPolicy({
                  cancellationPolicyText:
                    result.summary.cancellationPolicyText,
                  noShowPolicyText: result.summary.noShowPolicyText,
                })}
                // 0171. The hash of the policy text rendered by the
                // PublicPolicyReminderCard immediately above. Computed
                // server-side in fetchAppointmentForRescheduleAction from the
                // same studio row this page displays, so it is a genuine
                // proof of what the visitor saw.
                presentedPolicyHash={result.summary.presentedPolicyHash}
              />
            </>
          ) : waitlistOnly ? (
            // EMERG-01 policy surface. Deliberate, not apologetic: the
            // appointment is fine, it simply cannot be moved from here.
            <div>
              <EyebrowCaption>
                {FREE_CONSULT_WAITLIST_ONLY_EYEBROW}
              </EyebrowCaption>
              <h1
                className="font-[var(--font-fraunces)] mt-8 text-[28px] font-bold leading-tight md:text-[36px]"
                style={{ letterSpacing: "-0.02em" }}
              >
                {FREE_CONSULT_WAITLIST_ONLY_HEADLINE}
              </h1>
              <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">
                {FREE_CONSULT_WAITLIST_ONLY_BODY}
              </p>

              {/* Plain anchors, not <Link>. A token-bearing URL should not be
                  prefetched into a client-side router cache, and neither of
                  these navigations mutates anything: /cancel renders its own
                  read-only summary and still requires an explicit submit. The
                  SAME token is carried through, so the visitor never has to
                  find another link. */}
              <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
                <a
                  href={`/cancel/${encodeURIComponent(token)}`}
                  className="px-8 py-4 text-center text-[14px] font-medium uppercase"
                  style={{
                    backgroundColor: "#0A0A0A",
                    color: "#FAFAF7",
                    letterSpacing: "0.1em",
                  }}
                >
                  Cancel appointment
                </a>
                {/* The genuine no-op exit. /portal owns its own session check
                    and redirects to /portal/login when there is none, so this
                    promises the visitor nothing about being signed in — the
                    same stance the cancel and manage surfaces already take. */}
                <a
                  href="/portal"
                  className="px-8 py-4 text-center text-[14px] font-medium uppercase"
                  style={{
                    border: "1px solid #0A0A0A",
                    color: "#0A0A0A",
                    letterSpacing: "0.1em",
                  }}
                >
                  Keep my appointment
                </a>
              </div>
            </div>
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
