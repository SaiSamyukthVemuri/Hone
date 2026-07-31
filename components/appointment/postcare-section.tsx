import { buildPostcareEmail } from "@/lib/email/templates/postcare";
import { PostcareSendButton } from "@/app/(app)/calendar/PostcareSendButton";

// THE postcare preview + send/status surface — one implementation, two mounts.
//
// Extracted from the calendar appointment page so the charting page's "Finish
// appointment" workflow renders the SAME thing rather than a lookalike. Every
// semantic is unchanged: the server-rendered preview from buildPostcareEmail,
// the first-send claim and stale-claim recovery inside
// sendPostcareEmailAction, the consultation attestation, the missing-client-
// email and missing-configuration states, the sending state, the failed state,
// the provider-confirmed sent timestamp and the attempt count.
//
// "Sent" means the provider accepted the handoff. It never means delivered,
// read or opened, and nothing here claims otherwise.
//
// This is a SERVER component: `sending` is computed server-side so the client
// render carries no Date.now() and cannot hydrate-mismatch.

export function PostcareSection(props: {
  appointmentId: string;
  studioName: string;
  studioEmail: string | null;
  studioTimezone: string;
  aftercareText: string | null;
  warningSignsText: string | null;
  productRecommendationsText: string | null;
  reviewUrl: string | null;
  reviewPromptText: string | null;
  clientName: string;
  serviceName: string | null;
  serviceModality: string | null;
  startsAt: string;
  practitionerName: string | null;
  postcareEmailSentAt: string | null;
  postcareEmailSendAttempts: number;
  // PR #311: postcare send-state correctness.
  postcareEmailClaimedAt: string | null;
  postcareEmailFailedAt: string | null;
  isOwner: boolean;
  // Both surfaces pass this. The calendar page used to simply NOT MOUNT the
  // section when the client had no email, which silently removed postcare from
  // the page with no explanation. The state is now explicit and shared, so
  // neither surface can quietly drop it.
  clientEmail?: string | null;
}) {
  const preview = buildPostcareEmail({
    clientName: props.clientName,
    studioName: props.studioName,
    studioEmail: props.studioEmail,
    practitionerName: props.practitionerName,
    serviceName: props.serviceName,
    startsAt: props.startsAt ? new Date(props.startsAt) : null,
    timezone: props.studioTimezone,
    aftercareText: props.aftercareText,
    warningSignsText: props.warningSignsText,
    productRecommendationsText: props.productRecommendationsText,
    reviewUrl: props.reviewUrl,
    reviewPromptText: props.reviewPromptText,
  });

  const aftercareConfigured =
    !!props.aftercareText && props.aftercareText.trim().length > 0;
  const hasClientEmail =
    props.clientEmail === undefined ||
    (!!props.clientEmail && props.clientEmail.trim().length > 0);
  const isConsultation = props.serviceModality === "consultation";

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Postcare email
      </h2>
      {isConsultation && (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          Consultations sometimes include a short electrolysis test
          treatment. Send postcare only if treatment was performed.
        </p>
      )}
      {!hasClientEmail ? (
        <p
          data-testid="postcare-no-client-email"
          className="text-sm text-neutral-700 dark:text-neutral-300"
        >
          Postcare unavailable — no client email
        </p>
      ) : aftercareConfigured ? (
        <>
          <p className="text-xs text-neutral-500">
            {isConsultation
              ? "Preview the email before sending. You'll confirm that treatment was performed in the next step."
              : "Send the client your studio's aftercare information. Preview the email before sending."}
          </p>
          <PostcareSendButton
            appointmentId={props.appointmentId}
            alreadySentAt={props.postcareEmailSentAt}
            failedAt={props.postcareEmailFailedAt}
            // PR #311: "sending" = a fresh claim with no outcome yet (server-
            // computed so the client render carries no Date.now → no hydration
            // mismatch). A stale claim (>5 min, sender died) is not "sending".
            sending={
              !!(
                props.postcareEmailClaimedAt &&
                !props.postcareEmailSentAt &&
                !props.postcareEmailFailedAt &&
                Date.now() - new Date(props.postcareEmailClaimedAt).getTime() <
                  5 * 60_000
              )
            }
            sendAttempts={props.postcareEmailSendAttempts}
            previewText={preview.preview}
            requiresConsultationConfirmation={isConsultation}
          />
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            Postcare email is not configured yet.
          </p>
          {props.isOwner ? (
            <a
              href="/settings/intake#postcare"
              className="self-start rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Configure postcare
            </a>
          ) : (
            <p className="text-xs text-neutral-500">
              Ask the studio owner to configure postcare instructions.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
