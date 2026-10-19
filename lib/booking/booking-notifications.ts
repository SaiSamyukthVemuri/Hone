import { generateCancellationToken } from "@/lib/booking/tokens";
import { clientSelfServiceLinks } from "@/lib/booking/client-self-service-policy";
import { ensureIntakeForClient } from "@/lib/intake/queries";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";
import {
  logEmailFailure,
  recordEmailAttempt,
  sendBookingConfirmationToClient,
  sendBookingNotificationToPractitioner,
} from "@/lib/email/send-appointment";
import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";
import { getRequiredAppOrigin } from "@/lib/app-origin";

// The post-commit notifications for an INTERNAL booking: the client's
// confirmation email and SMS, and the treating practitioner's new-booking
// notice. Moved VERBATIM out of app/(app)/calendar/actions.ts
// (STUDIO-READY-02c, #824) so the practitioner calendar and the front desk run
// the same dispatch rather than two copies. It is not a server action (this
// module has no "use server"), so it is never a client-callable endpoint.
// Callers invoke it only AFTER the booking command has committed, and wrap it:
// it must never turn a committed booking into a failure.

export type DispatchParams = {
  appointment: import("@/lib/types/database").Appointment;
  service: import("@/lib/types/database").Service;
  studio: import("@/lib/types/database").Studio;
  practitionerName: string;
  practitionerEmail: string;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  // PR Twilio v1: optional SMS consent fields. Defaulted to null in
  // older callers; the SMS attempt fails the consent gate cleanly
  // when missing or null.
  clientSmsConsentAt?: string | null;
  clientSmsOptedOutAt?: string | null;
  notes: string | null;
};

export async function dispatchBookingNotifications(p: DispatchParams) {
  // Single helper call up front; downstream lines share the same origin.
  const appOrigin = getRequiredAppOrigin();
  // PR #260/#264: appointment tokens are hash-only at rest (the raw
  // cancellation_token column was dropped in PR #264, migration 0091).
  // Surfaces that rebuild a link after creation cannot read a raw token,
  // so we mint the stateless HMAC token (expires at the appointment start)
  // for every link. /cancel, /manage, and /reschedule all accept the HMAC
  // token (they hash the URL token against cancellation_token_hash and
  // fall back to verifyCancellationToken), so all three links resolve.
  const token = generateCancellationToken(
    p.appointment.id,
    new Date(p.appointment.starts_at),
  );
  // HON-47. The three links come from one policy-aware helper: a studio that
  // has switched an action off must not have the link SENT, in any channel,
  // because the link is itself a promise. `cancelUrl` and `rescheduleUrl` are
  // null when suppressed and every renderer below must omit them rather than
  // render an empty href.
  //
  // SMS uses the single neutral /manage/<token> entry point, which is never
  // suppressed: it is the honest fallback, naming only the actions it can
  // offer and pointing at the studio when it can offer none.
  //
  // The flags come from `p.studio`, the row the caller already read
  // server-side. Nothing here trusts the browser.
  const { cancelUrl, rescheduleUrl, manageUrl } = clientSelfServiceLinks({
    origin: appOrigin,
    token,
    studio: p.studio,
  });
  const appointmentUrl = `${appOrigin}/calendar`;

  let intakeUrl: string | null = null;
  if (p.clientEmail && p.studio.send_confirmation_emails) {
    let treatmentTimeLine: ReturnType<typeof buildTreatmentTimeLine> = null;
    let emailPrepared = false;
    try {
      const intake = await ensureIntakeForClient({
        studioId: p.studio.id,
        clientId: p.appointment.client_id,
        appOrigin,
      });
      intakeUrl = intake?.url ?? null;
      treatmentTimeLine = p.studio.show_treatment_time_to_clients
        ? buildTreatmentTimeLine({
            enabled: true,
            clientFirstName: p.clientName.split(/\s+/)[0] || p.clientName,
            context: await getTreatmentTimeContextForEmail(
              p.studio.id,
              p.appointment.client_id,
            ),
          })
        : null;
      emailPrepared = true;
    } catch {
      // A preparation failure is not a provider refusal. Never log the raw
      // exception: context/intake failures can contain patient information.
      logEmailFailure({
        appointmentId: p.appointment.id,
        emailType: "confirmation",
        error: "confirmation_preparation_failed",
        retryable: true,
        attemptNumber: 1,
      });
      try {
        const { createAdminClient } = await import("@/lib/supabase/admin-server");
        await recordEmailAttempt(createAdminClient(), p.appointment.id, "confirmation", false);
      } catch {
        // Failure bookkeeping must not suppress the other notifications either.
        console.error(JSON.stringify({
          event: "booking_confirmation_preparation_record_failed",
          appointmentId: p.appointment.id,
          emailType: "confirmation",
          timestamp: new Date().toISOString(),
        }));
      }
    }
    if (emailPrepared) {
      // Email reporting is truthful: recordEmailAttempt stamps
      // confirmation_sent_at only when Resend actually delivered. The old
      // code path stamped on every booking, falsely advertising delivery.
      const result = await sendBookingConfirmationToClient({
        appointment: p.appointment,
        service: p.service,
        studio: p.studio,
        practitionerDisplayName: p.practitionerName,
        clientName: p.clientName,
        clientEmail: p.clientEmail,
        cancellationUrl: cancelUrl,
        rescheduleUrl,
        intakeUrl,
        treatmentTimeLine,
        appBaseUrl: appOrigin,
      });
      const { createAdminClient } = await import("@/lib/supabase/admin-server");
      const admin = createAdminClient();
      await recordEmailAttempt(admin, p.appointment.id, "confirmation", result.ok);
      if (!result.ok) {
        logEmailFailure({
          appointmentId: p.appointment.id,
          emailType: "confirmation",
          error: result.error,
          retryable: result.retryable,
          attemptNumber: 1,
        });
      }
    }
  }

  // SMS has its own delivery decision. Email being off or absent must not
  // suppress it. Reuse an intake URL prepared for email, when available;
  // SMS-only dispatch does not create a new intake row.
  if (p.clientPhone && p.studio.send_confirmation_sms) {
    const { createAdminClient } = await import("@/lib/supabase/admin-server");
    const admin = createAdminClient();
    // SMS confirmation for the internal booking surface. We deliberately
    // do NOT modify SMS consent here (consent is collected on the
    // public booking surface or by a practitioner action that this PR
    // does not ship); we only attempt to send if the consent gate
    // inside the helper passes. The helper handles toggle, opt-out,
    // phone normalization, claim race, and timeouts; it never throws.
    await sendBookingConfirmationSmsToClient({
      admin,
      appointmentId: p.appointment.id,
      startsAt: new Date(p.appointment.starts_at),
      timezone: p.studio.timezone,
      studio: p.studio,
      client: {
        phone: p.clientPhone,
        sms_consent_at: p.clientSmsConsentAt ?? null,
        sms_opted_out_at: p.clientSmsOptedOutAt ?? null,
      },
      intakeUrl,
      manageUrl,
    });
  }
  // Migration 0047: studio owners can opt out of the practitioner
  // new-booking notification. Default true preserves the previous
  // unconditional behavior. Client confirmation above already gates
  // separately on send_confirmation_emails and is unaffected here.
  if (p.studio.notify_practitioner_on_new_booking === false) {
    return;
  }
  await sendBookingNotificationToPractitioner({
    appointment: p.appointment,
    service: p.service,
    studio: p.studio,
    practitionerName: p.practitionerName,
    practitionerEmail: p.practitionerEmail,
    clientName: p.clientName,
    clientEmail: p.clientEmail ?? "",
    clientPhone: p.clientPhone,
    notes: p.notes,
    appointmentUrl,
    // PR #163. Practitioner-side bookings (created from the
    // calendar) never ask the "How did you hear about us?"
    // question; the practitioner knows the source already. Always
    // null here.
    referralSourceLabel: null,
  });
}
