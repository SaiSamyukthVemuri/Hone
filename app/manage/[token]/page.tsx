import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PublicPolicyReminderCard } from "@/app/_components/PublicPolicyReminderCard";
import { fetchAppointmentForManageAction } from "./actions";

// PR #142. Token-bearing route. See
// app/portal/verify/[token]/page.tsx for the full rationale.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Public manage-appointment page. Single neutral entry point for the
// "Manage appointment" link that confirmation and reminder SMS now
// carry. Resolves the same token used by /cancel and /reschedule
// (column-based with HMAC fallback so older in-flight links keep
// working), shows the appointment summary and the studio's policies,
// and offers the two follow-on actions as buttons that route into the
// existing /reschedule/[token] and /cancel/[token] flows. The page
// itself never mutates anything; reschedule and cancel keep their
// existing actions and rate limits.
//
// Token state is never leaked. Invalid, expired, cancelled,
// completed, no_show, or past-start tokens all collapse to the same
// generic "unavailable" surface (matching the same stance used by
// /cancel and /reschedule).

export default async function ManageAppointmentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await fetchAppointmentForManageAction(token);

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
            <>
              <div>
                <EyebrowCaption>Manage appointment</EyebrowCaption>
                <h1
                  className="font-[var(--font-fraunces)] mt-8 text-[36px] font-bold leading-tight md:text-[48px]"
                  style={{ letterSpacing: "-0.025em" }}
                >
                  Manage appointment
                </h1>
                <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">
                  Review your appointment below. You can reschedule or
                  cancel from here.
                </p>
              </div>

              {/* Appointment summary card. Same shape as the cancel
                  and reschedule pages so the visitor sees a
                  consistent surface across all three public links.
                  No address (same minimal-leak stance as cancel). */}
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

              {/* Policy reminder. Renders neither header when both
                  policy fields are empty so the page does not show
                  blank "Cancellation policy" / "No-show policy"
                  labels for studios that have not authored either. */}
              <PublicPolicyReminderCard
                cancellationPolicyText={result.summary.cancellationPolicyText}
                noShowPolicyText={result.summary.noShowPolicyText}
                studioName={result.summary.studioName}
              />

              {/* Two follow-on actions. Plain anchor links into the
                  existing flows; this page does not mutate anything.
                  Reschedule is the soft primary because it is the
                  intent that does not lose the slot; cancel is the
                  secondary outlined button so a misclick stands out
                  visually. */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link
                  href={`/reschedule/${token}`}
                  className="px-8 py-4 text-center text-[14px] font-medium uppercase"
                  style={{
                    backgroundColor: "#0A0A0A",
                    color: "#FAFAF7",
                    letterSpacing: "0.1em",
                  }}
                >
                  Reschedule appointment
                </Link>
                <Link
                  href={`/cancel/${token}`}
                  className="px-8 py-4 text-center text-[14px] font-medium uppercase"
                  style={{
                    border: "1px solid #0A0A0A",
                    color: "#0A0A0A",
                    letterSpacing: "0.1em",
                  }}
                >
                  Cancel appointment
                </Link>
              </div>

              {/* Back-to-portal escape hatch (PR #127). When the
                  client arrives here from the secure client portal
                  (the "Manage appointment" CTA on /portal), there
                  was no obvious way back. The link goes to /portal;
                  middleware/portal-shell handle the auth case (if a
                  valid portal session cookie is present /portal
                  renders, otherwise /portal redirects to
                  /portal/login). We deliberately do not promise the
                  client is already signed in. The manage token is
                  not touched by this link, so cancel/reschedule
                  behaviour is unchanged. */}
              <div className="pt-2">
                <Link
                  href="/portal"
                  className="inline-flex items-center gap-2 text-[13px] font-medium uppercase"
                  style={{
                    letterSpacing: "0.12em",
                    color: "#0A0A0A",
                    borderBottom: "1px solid #0A0A0A",
                    paddingBottom: "2px",
                  }}
                >
                  &larr; Back to client portal
                </Link>
              </div>
            </>
          ) : (
            // Generic collapsed surface for every non-manageable
            // case: unknown token, expired token, already-used
            // reschedule, already-cancelled appointment, completed or
            // no-show appointment, past start time. Same shape and
            // tone as the cancel/reschedule unavailable surfaces.
            <UnavailableMessage
              eyebrow="Manage appointment"
              headline="This manage link can't be used right now."
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
