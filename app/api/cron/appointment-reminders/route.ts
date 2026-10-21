import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  beginAppointmentEmailMessage,
  settleEmailMessage,
  settleOutcomeForEmailSend,
} from "@/lib/email/delivery-ledger";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import {
  claimEmailSend,
  logEmailFailure,
  recordEmailResult,
  send24hReminderToClient,
  send2hReminderToClient,
  sendIntakeReminderToClient,
  type ClaimableEmailType,
  type EmailSendResult,
} from "@/lib/email/send-appointment";
import {
  generateIntakeLinkUrl,
  stampIntakeLinkIssued,
} from "@/lib/intake/queries";
import {
  createLedgerBudget,
  send24hReminderSmsToClient,
  send2hReminderSmsToClient,
  type LedgerBudget,
} from "@/lib/sms/send-appointment";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";
import type { Appointment, Client, Service, Studio } from "@/lib/types/database";
import { generateCancellationToken } from "@/lib/booking/tokens";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { reminderWindowIso } from "@/lib/cron/reminder-schedule";
import { recordReminderRunSuccess } from "@/lib/cron/reminder-heartbeat";
import { recoverLeadAlertsOnReminderTrigger } from "@/lib/platform-leads/alert-delivery";
import { clientSelfServiceLinks } from "@/lib/booking/client-self-service-policy";

const PER_RUN_LIMIT = 50;
const MAX_ATTEMPTS = 3;

type Joined = Appointment & {
  service: Pick<Service, "name" | "default_duration_minutes" | "pre_care_instructions"> | null;
  studio: Studio | null;
  // PR Twilio v1: SMS pass needs phone + consent + opt-out alongside
  // the existing email name/email. Selected in loadAppointmentsForWindow.
  client: Pick<
    Client,
    "name" | "email" | "phone" | "sms_consent_at" | "sms_opted_out_at"
  > | null;
  practitioner: { display_name: string | null; email: string | null } | null;
};

function pickRel<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// Widened to accept SMS column names too. The same join shape works
// for both email and SMS passes; the difference is purely which
// _sent_at / _send_attempts columns we filter on.
type SentColumn =
  | "reminder_24h_sent_at"
  | "reminder_2h_sent_at"
  | "sms_reminder_24h_sent_at"
  | "sms_reminder_2h_sent_at";
type AttemptsColumn =
  | "reminder_24h_send_attempts"
  | "reminder_2h_send_attempts"
  | "sms_reminder_24h_send_attempts"
  | "sms_reminder_2h_send_attempts";

async function loadAppointmentsForWindow(opts: {
  startIso: string;
  endIso: string;
  notSentColumn: SentColumn;
  attemptsColumn: AttemptsColumn;
}): Promise<Joined[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointments")
    .select(
      "*, service:services(name, default_duration_minutes, pre_care_instructions), studio:studios(*), client:clients(name, email, phone, sms_consent_at, sms_opted_out_at), practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name, email)",
    )
    .eq("status", "confirmed")
    .is(opts.notSentColumn, null)
    .lt(opts.attemptsColumn, MAX_ATTEMPTS)
    .gte("starts_at", opts.startIso)
    .lte("starts_at", opts.endIso)
    .order("starts_at", { ascending: true })
    .limit(PER_RUN_LIMIT);
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as Array<
    Appointment & {
      service: Joined["service"] | Joined["service"][] | null;
      studio: Studio | Studio[] | null;
      client: Joined["client"] | Joined["client"][] | null;
      practitioner: Joined["practitioner"] | Joined["practitioner"][] | null;
    }
  >).map((row) => ({
    ...(row as Appointment),
    service: pickRel(row.service),
    studio: pickRel(row.studio),
    client: pickRel(row.client),
    practitioner: pickRel(row.practitioner),
  }));
}

// PR #189: email passes gained a "skipped" bucket for rows lost to a
// claim collision (another overlapping cron run holds the row). The
// pre-existing keys are unchanged for log compatibility.
type RunStats = {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

// The email window pass adds one non-sensitive composition counter: how many
// of the emails it actually sent carried an intake CTA. Aggregate only - no
// ids, no addresses, no link.
type EmailRunStats = RunStats & { intakeCtaIncluded: number };

// SMS pass counts consent/toggle/claim skips in the same bucket, and keeps
// its OWN intake-CTA counter. Accounting is per channel: an email that
// carried the link never counts as an SMS that did, or the reverse.
type SmsRunStats = RunStats & { intakeCtaIncluded: number };

// PR #258: when a reminder reaches MAX_ATTEMPTS without sending it is silently
// dropped (the window query filters attempts >= MAX_ATTEMPTS, so the row is
// never retried). Surface that to the operator via the existing ops-alert
// pipeline with NON-SENSITIVE metadata only, no client email/phone/notes,
// no token, no free-text error string (recordOpsAlert also redacts defensively).
async function alertIfReminderExhausted(opts: {
  studioId: string;
  appointmentId: string;
  emailType: ClaimableEmailType;
  attemptNumber: number;
  retryable: boolean;
  reason: "send_failed" | "missing_token";
  // Non-sensitive: a boolean, never the link, the intake answers or the
  // address. Lets the operator see when an exhausted send also cost the
  // client their intake nudge.
  intakeCtaIncluded: boolean;
}): Promise<void> {
  if (opts.attemptNumber < MAX_ATTEMPTS) return;
  await recordOpsAlert({
    severity: "warning",
    event: "reminder_send_exhausted",
    message: `Appointment reminder (${opts.emailType}) exhausted ${MAX_ATTEMPTS} send attempts without success.`,
    studioId: opts.studioId,
    appointmentId: opts.appointmentId,
    route: "/api/cron/appointment-reminders",
    safeDetails: {
      reminder_type: opts.emailType,
      attempt_count: opts.attemptNumber,
      retryable: opts.retryable,
      reason: opts.reason,
      intake_cta_included: opts.intakeCtaIncluded,
    },
  });
}

// The client's latest non-deleted intake for (studio, client). Studio + client
// scoped so tenant isolation holds on the session-less admin client. Reads id
// and status ONLY: no client PII, no responses, no token.
//
// FAIL-SAFE, NOT FAIL-LOUD. A read error yields null, which every caller reads
// as "not incomplete" and therefore "no intake CTA". The appointment reminder
// is the time-critical message; degrading it to nothing because an intake
// lookup blipped would be strictly worse than sending it without the CTA.
async function readLatestIntake(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
  clientId: string,
): Promise<{ id: string; status: string } | null> {
  const { data } = await admin
    .from("client_intake_forms")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string; status: string } | null) ?? null;
}

// The ~24h and ~2h window email, composed.
//
// ONE CLAIM OWNS THE WINDOW. Appointment reminders and intake reminders are
// independent studio settings, but they are NOT independent sends: whatever
// this pass decides to compose, it claims the single reminder_24h /
// reminder_2h slot for the appointment. AT MOST ONE EMAIL PER APPOINTMENT PER
// WINDOW is therefore a property of one conditional UPDATE (claim_email_send,
// migration 0080), not a behaviour two send paths have to be trusted to
// respect. Two slots could not give that: two independent conditional UPDATEs
// are not atomic with respect to each other, so a toggle flip or an intake
// submission landing between two overlapping cron runs would let each run win
// a different slot and send.
//
// THE SIX CASES (R = the matching send_Nh_reminders, I = send_intake_reminders,
// intake state re-read LIVE after the claim):
//
//   1. R on,  I on,  incomplete -> ONE reminder carrying the intake CTA
//   2. R on,  I on,  complete   -> ONE plain reminder
//   3. R on,  I off             -> ONE plain reminder (intake never read)
//   4. R off, I on,  incomplete -> ONE standalone intake reminder
//   5. R off, I on,  complete   -> NOTHING, and no claim (see the probe below)
//   6. R off, I off             -> NOTHING, no read, no claim
async function sendReminderPass(opts: {
  kind: "24h" | "2h";
  windowStartIso: string;
  windowEndIso: string;
}): Promise<EmailRunStats> {
  const sentColumn =
    opts.kind === "24h" ? "reminder_24h_sent_at" : "reminder_2h_sent_at";
  const attemptsColumn =
    opts.kind === "24h"
      ? "reminder_24h_send_attempts"
      : "reminder_2h_send_attempts";
  const studioToggle =
    opts.kind === "24h" ? "send_24h_reminders" : "send_2h_reminders";
  const emailType: ClaimableEmailType =
    opts.kind === "24h" ? "reminder_24h" : "reminder_2h";

  const appts = await loadAppointmentsForWindow({
    startIso: opts.windowStartIso,
    endIso: opts.windowEndIso,
    notSentColumn: sentColumn,
    attemptsColumn,
  });

  const admin = createAdminClient();
  const stats: EmailRunStats = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    intakeCtaIncluded: 0,
  };
  const appOrigin = getRequiredAppOrigin();

  for (const appt of appts) {
    if (!appt.studio) continue;
    if (!appt.client?.email) continue;

    const wantsReminder =
      (appt.studio as unknown as Record<string, boolean>)[studioToggle] === true;
    // Absent only on a studios row read before 0186 is applied. The column
    // defaults true, so absent must mean ENABLED, never disabled.
    const intakeEnabled = appt.studio.send_intake_reminders !== false;

    // CASE 6: nothing to send. No intake read, no claim, no attempt.
    if (!wantsReminder && !intakeEnabled) continue;

    // CASES 4/5 ONLY: whether to claim at all depends on intake state, so it
    // has to be known BEFORE the claim. Claiming first would burn an attempt
    // on every Case-5 row and could exhaust the 3-strike cap, blocking a
    // legitimate reminder if the studio re-enabled it later in the window.
    // When the appointment reminder is ON we are sending regardless, so this
    // probe is skipped and the single post-claim live read below is enough.
    if (!wantsReminder) {
      const probe = await readLatestIntake(
        admin,
        appt.studio.id,
        appt.client_id,
      );
      if (probe?.status !== "in_progress") {
        // CASE 5. No claim, no attempt bump, no email.
        stats.skipped += 1;
        continue;
      }
    }

    // Claim-before-send (PR #189, migration 0080): atomic attempt increment +
    // _claimed_at, so two overlapping cron runs can never both send.
    const claimed = await claimEmailSend(admin, appt.id, emailType);
    if (!claimed) {
      stats.skipped += 1;
      continue;
    }

    // PR #258: a confirmed appointment can be cancelled / no-showed between
    // the window query and now; the claim does not re-validate status.
    const { data: fresh } = await admin
      .from("appointments")
      .select("status")
      .eq("id", appt.id)
      .maybeSingle();
    if (!fresh || fresh.status !== "confirmed") {
      stats.skipped += 1;
      continue;
    }

    // LIVE intake re-read, immediately before the send decision. Deliberately
    // a SECOND query, never the pre-claim probe reused: the probe answered
    // "should we claim", this answers "what do we send", and they are asked at
    // different instants. Skipped entirely when intake reminders are off
    // (CASE 3), which is also why a studio with the setting off never pays for
    // an intake lookup.
    const intake = intakeEnabled
      ? await readLatestIntake(admin, appt.studio.id, appt.client_id)
      : null;
    const intakeIncomplete = intake?.status === "in_progress";

    if (!wantsReminder && !intakeIncomplete) {
      // CASE 4 -> 5 between the probe and the live read: the client submitted,
      // and there is no appointment reminder to fall back on. Clear the claim
      // explicitly rather than letting it go stale, because unlike the
      // cancellation branch above this row is still confirmed and WILL be
      // re-queried. The attempt the claim already counted stands; the pre-claim
      // probe stops every later fire before it claims again.
      await recordEmailResult(admin, appt.id, emailType, false);
      stats.skipped += 1;
      continue;
    }

    stats.attempted += 1;
    const attemptNumber = (appt[attemptsColumn] as number) + 1;

    // A FRESH link per send (now + 14-day TTL; the signed token stays the
    // authoritative expiry). Saved answers are preserved: this reuses the
    // existing intake row, never a new one. The raw token is never logged.
    const intakeUrl =
      intakeIncomplete && intake
        ? generateIntakeLinkUrl(intake.id, appOrigin)
        : null;

    let result: EmailSendResult;

    // DELIVERY-VISIBILITY-01: one email delivery-ledger row per real attempt.
    //
    // THE ROW IS BEGUN IMMEDIATELY BEFORE THE PROVIDER CALL, AFTER ALL
    // PREPARATION (Codex P2 4307698580). It used to be begun here, before the
    // token was minted and before the treatment-time context was read, and
    // `begin` leaves the row `claimed` — so two paths left a row that nothing
    // would ever settle:
    //
    //   * an unmintable token `continue`s the loop (it records a failed email
    //     result and moves on), skipping the settle entirely;
    //   * `getTreatmentTimeContextForEmail` can THROW, and nothing between
    //     here and the settle catches it.
    //
    // A row stuck in `claimed` is invisible: no health measure reports one. So
    // the reference is computed once and the row is created at the last moment
    // in each branch, which is what the old comment already claimed was true.
    // Fail-soft is unchanged: a null id sends exactly as before, untagged. The
    // case-4 standalone intake email is the same window slot, so it carries the
    // same purpose.
    const ledgerRef = {
      studioId: appt.studio.id,
      appointmentId: appt.id,
      purpose:
        opts.kind === "24h"
          ? ("appointment_reminder_24h" as const)
          : ("appointment_reminder_2h" as const),
    };
    let ledgerMessageId: string | null = null;

    if (wantsReminder) {
      // CASES 1/2/3 - the appointment reminder, carrying the intake CTA only
      // when intakeUrl is non-null.
      // PR #260/#264: appointment tokens are hash-only at rest. The reminder
      // mints the stateless HMAC token (expires at the appointment start);
      // /cancel and /reschedule accept it, so the reminder links resolve.
      const token = generateCancellationToken(appt.id, new Date(appt.starts_at));
      if (!token) {
        // Defensive: minting only fails if the appointment start is
        // unparseable. Record a failed result via the RPC (clears the claim;
        // the claim already counted the attempt) so we don't loop forever on a
        // structurally broken row.
        await recordEmailResult(admin, appt.id, emailType, false);
        logEmailFailure({
          appointmentId: appt.id,
          emailType,
          error: "Missing appointment token",
          retryable: false,
          attemptNumber,
        });
        await alertIfReminderExhausted({
          studioId: appt.studio.id,
          appointmentId: appt.id,
          emailType,
          attemptNumber,
          retryable: false,
          reason: "missing_token",
          intakeCtaIncluded: intakeUrl !== null,
        });
        stats.failed += 1;
        continue;
      }
  // HON-47. One policy-aware helper for all three links: a studio that has
  // switched an action off must not have that link SENT, in any channel.
  // `/manage` is never suppressed — it is the honest fallback. The flags come
  // from the studio row already read server-side.
      const { cancelUrl: cancellationUrl, rescheduleUrl } =
        clientSelfServiceLinks({ origin: appOrigin, token, studio: appt.studio });
      const practitionerName =
        appt.practitioner?.display_name?.trim() ||
        appt.practitioner?.email ||
        null;

      const treatmentTimeLine = appt.studio.show_treatment_time_to_clients
        ? buildTreatmentTimeLine({
            enabled: true,
            clientFirstName:
              appt.client.name.split(/\s+/)[0] || appt.client.name,
            context: await getTreatmentTimeContextForEmail(
              appt.studio.id,
              appt.client_id,
            ),
          })
        : null;
      const sendFn =
        opts.kind === "24h" ? send24hReminderToClient : send2hReminderToClient;
      // Everything that could fail or throw is behind us.
      ledgerMessageId = await beginAppointmentEmailMessage(admin, ledgerRef);
      result = await sendFn({
        appointment: appt,
        service: appt.service,
        studio: appt.studio,
        practitionerDisplayName: practitionerName,
        clientName: appt.client.name,
        clientEmail: appt.client.email,
        cancellationUrl,
        rescheduleUrl,
        treatmentTimeLine,
        intakeUrl,
        ledgerMessageId,
      });
    } else {
      // CASE 4 - the appointment reminder is off but intake reminders are on
      // and the intake is still incomplete, so the nudge goes out on its own.
      // Still under the window claim above, so it cannot race a reminder.
      //
      // intakeUrl is non-null here BY CONSTRUCTION: reaching this branch means
      // !wantsReminder, and the !wantsReminder && !intakeIncomplete case
      // already `continue`d above - so intakeIncomplete holds, `intake` is
      // non-null, and the link was minted.
      ledgerMessageId = await beginAppointmentEmailMessage(admin, ledgerRef);
      result = await sendIntakeReminderToClient({
        kind: opts.kind,
        clientEmail: appt.client.email,
        studioName: appt.studio.name,
        startsAt: new Date(appt.starts_at),
        timezone: appt.studio.timezone,
        intakeUrl: intakeUrl as string,
        ledgerMessageId,
      });
    }

    if (ledgerMessageId) {
      await settleEmailMessage(admin, ledgerMessageId, settleOutcomeForEmailSend(result));
    }
    await recordEmailResult(admin, appt.id, emailType, result.ok);
    if (result.ok) {
      // Stamp the PR #303 intake-link display metadata ONLY when a link was
      // actually in the email that actually sent. A plain appointment reminder
      // must never look like an intake link was issued.
      if (intakeUrl && intake) {
        await stampIntakeLinkIssued(admin, intake.id, { emailed: true });
        stats.intakeCtaIncluded += 1;
      }
      stats.succeeded += 1;
    } else {
      logEmailFailure({
        appointmentId: appt.id,
        emailType,
        error: result.error,
        retryable: result.retryable,
        attemptNumber,
        studioId: appt.studio.id,
      });
      await alertIfReminderExhausted({
        studioId: appt.studio.id,
        appointmentId: appt.id,
        emailType,
        attemptNumber,
        retryable: result.retryable,
        reason: "send_failed",
        intakeCtaIncluded: intakeUrl !== null,
      });
      stats.failed += 1;
    }
  }

  return stats;
}

// SMS reminder pass (PR Twilio v1). Mirrors sendReminderPass above
// but keys off the SMS columns and uses claim_sms_send +
// record_sms_result via the helper. We deliberately keep this as a
// separate pass with its own query so the SMS send-attempt state is
// independent from email: an appointment with a successful email
// reminder still gets an SMS reminder attempt (and vice versa), and
// neither column blocks the other.
async function sendSmsReminderPass(opts: {
  kind: "24h" | "2h";
  windowStartIso: string;
  windowEndIso: string;
  /** The run's ONE ledger budget, shared with the other SMS pass. */
  ledgerBudget: LedgerBudget;
}): Promise<SmsRunStats> {
  const sentColumn: SentColumn =
    opts.kind === "24h" ? "sms_reminder_24h_sent_at" : "sms_reminder_2h_sent_at";
  const attemptsColumn: AttemptsColumn =
    opts.kind === "24h"
      ? "sms_reminder_24h_send_attempts"
      : "sms_reminder_2h_send_attempts";
  const studioToggle =
    opts.kind === "24h" ? "send_24h_sms_reminders" : "send_2h_sms_reminders";

  const appts = await loadAppointmentsForWindow({
    startIso: opts.windowStartIso,
    endIso: opts.windowEndIso,
    notSentColumn: sentColumn,
    attemptsColumn,
  });

  const admin = createAdminClient();
  const stats: SmsRunStats = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    intakeCtaIncluded: 0,
  };
  const smsAppOrigin = getRequiredAppOrigin();

  for (const appt of appts) {
    if (!appt.studio) continue;
    if (!(appt.studio as unknown as Record<string, boolean>)[studioToggle]) {
      // Studio toggle is off: skip without an attempt counter bump.
      // We do not call into the SMS helper because the gate inside it
      // would just return skipped; saving the DB roundtrip on every
      // pass is meaningful at scale.
      continue;
    }
    if (!appt.client) continue;
    // Hard prerequisites for the SMS helper. Skipping early avoids a
    // claim roundtrip when there is no point.
    if (!appt.client.phone) continue;
    if (!appt.client.sms_consent_at) continue;
    if (appt.client.sms_opted_out_at) continue;

    // PR #258: same cancellation-race re-check as the email pass, never SMS a
    // reminder for an appointment cancelled/no-showed after the window query.
    // A cheap PRE-FILTER, so a cancelled row costs no intake read and no
    // claim. SMS-02: the authoritative re-check (status AND start) runs inside
    // the send helper's claim_reminder_sms_send, under the appointment row
    // lock and in the same transaction as the claim.
    const { data: freshSms } = await admin
      .from("appointments")
      .select("status")
      .eq("id", appt.id)
      .maybeSingle();
    if (!freshSms || freshSms.status !== "confirmed") {
      stats.skipped += 1;
      continue;
    }

    // INTAKE CTA, composed into this one SMS. Reaching here already means
    // this window's SMS toggle is on and the client has a phone, consent and
    // no opt-out, so enabling send_intake_reminders can never open a new SMS
    // channel on its own. There is deliberately NO standalone intake SMS: if
    // the window's SMS toggle is off this pass already skipped the row, so the
    // single claim_sms_send slot below still owns the window outright.
    //
    // The read is LIVE and its own query - never the email pass's result -
    // and it fails safe: a read error yields null, so the appointment SMS
    // still goes out without the CTA.
    const smsIntake =
      appt.studio.send_intake_reminders !== false
        ? await readLatestIntake(admin, appt.studio.id, appt.client_id)
        : null;
    const smsIntakeUrl =
      smsIntake?.status === "in_progress"
        ? generateIntakeLinkUrl(smsIntake.id, smsAppOrigin)
        : null;

    // PR #260/#264: appointment tokens are hash-only at rest (the raw
    // cancellation_token column was dropped in PR #264). Mint the stateless
    // HMAC token so the SMS manage link resolves (/manage accepts it). Null
    // only if minting fails (unparseable start); the SMS template then drops
    // the manage line and still sends the moment-only reminder.
    //
    // SMS-02: a BUILDER, called by the helper with the start it re-read after
    // the claim. The token expires at the start, so a link minted from the
    // window query's start would be wrong for an appointment moved since.
    const appointmentId = appt.id;
    const manageUrlFor = (startsAt: Date): string | null => {
      let manageToken: string | null;
      try {
        manageToken = generateCancellationToken(appointmentId, startsAt);
      } catch {
        manageToken = null;
      }
      // /manage is never suppressed, so this stays a plain build — but it goes
      // through the helper so there is ONE place that decides these URLs.
      return manageToken
        ? clientSelfServiceLinks({
            origin: smsAppOrigin,
            token: manageToken,
            studio: null,
          }).manageUrl
        : null;
    };

    // Candidate eligibility is only a snapshot. Refresh after intake work,
    // immediately before dispatch, so STOP/consent/phone/switch changes made
    // while the row was queued reach the real sender's consent gate.
    const { data: recipient, error: recipientError } = await admin
      .from("appointments")
      .select("status, client_id, client:clients(phone, sms_consent_at, sms_opted_out_at), studio:studios(send_24h_sms_reminders, send_2h_sms_reminders)")
      .eq("id", appt.id)
      .eq("studio_id", appt.studio.id)
      .maybeSingle();
    const current = recipient as unknown as {
      status: string;
      client_id: string;
      client: Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at"> | Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at">[] | null;
      studio: Pick<Studio, "send_24h_sms_reminders" | "send_2h_sms_reminders"> | Pick<Studio, "send_24h_sms_reminders" | "send_2h_sms_reminders">[] | null;
    } | null;
    const currentClient = pickRel(current?.client ?? null);
    const currentStudio = pickRel(current?.studio ?? null);
    if (
      recipientError || !currentClient || !currentStudio ||
      current?.status !== "confirmed" || current.client_id !== appt.client_id
    ) {
      // Do not attach the queued client's intake link to a reassigned client.
      // A later run can select that appointment with its new context.
      stats.skipped += 1;
      continue;
    }

    const sendFn =
      opts.kind === "24h"
        ? send24hReminderSmsToClient
        : send2hReminderSmsToClient;
    const result = await sendFn({
      admin,
      appointmentId: appt.id,
      window: { startIso: opts.windowStartIso, endIso: opts.windowEndIso },
      timezone: appt.studio.timezone,
      studio: { ...appt.studio, ...currentStudio },
      client: currentClient,
      manageUrlFor,
      intakeUrl: smsIntakeUrl,
      ledgerBudget: opts.ledgerBudget,
    });
    // Whether the intake link may now be in the client's hands: the message
    // carrying it was accepted, or POSSIBLY accepted (an answer that was lost;
    // recorded as sent and never retried). Never for a definite refusal or a
    // skip, where the link never left Hone.
    let linkMayHaveGone = false;
    if (result.ok) {
      stats.attempted += 1;
      stats.succeeded += 1;
      linkMayHaveGone = result.intakeLinkIncluded;
    } else if (result.skipped) {
      // Helper-level skip (toggle race, claim collision, gate miss, or a
      // reminder claim that could not be reached). We do not count these
      // as attempted because no Twilio call was made; the operator wants
      // attempted/succeeded/failed to reflect actual Twilio invocations.
      stats.skipped += 1;
    } else {
      // A refusal, or a possibly-sent answer: either way not proven sent.
      stats.attempted += 1;
      stats.failed += 1;
      linkMayHaveGone = result.possiblySent === true && result.intakeLinkIncluded;
    }
    // Stamp intake-link metadata ONLY for a message that carried the link and
    // may have reached the client. A plain appointment SMS must never look
    // like an intake link was issued, and the email pass's own stamp is
    // separate.
    if (linkMayHaveGone && smsIntake) {
      await stampIntakeLinkIssued(admin, smsIntake.id, { emailed: false });
      stats.intakeCtaIncluded += 1;
    }
  }

  return stats;
}

/**
 * LEAD-ALERT-01: bounded operator lead-alert recovery on this trigger, on the
 * success AND the failure path (Codex P2 4253278108, 4254097611). Gated before
 * any database or provider call until lead alerts are configured; never
 * throws; a lead-alert problem is its own warning ops alert and a response
 * field, never a change to what reminders did or how the route answers.
 */
async function runLeadAlertRecovery() {
  try {
    // Bounded end to end, its own failure report included (Codex P2
    // 4259034271): at most REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS + _REPORT_MS.
    const out = await recoverLeadAlertsOnReminderTrigger();
    return out.ran
      ? {
          ran: true as const,
          ok: out.summary.ok,
          // false = stopped at its cap or budget with work possibly left (backpressure)
          drained: out.summary.drained,
          attempted: out.summary.attempted,
          accepted: out.summary.accepted,
          failed: out.summary.failed,
          expired: out.summary.expired,
          // claim/freeze/settle cancelled at the deadline: recovered later, neither sent nor failed
          unknown: out.summary.unknown,
          timed_out: out.summary.timedOut,
        }
      : { ran: false as const, reason: out.reason };
  } catch {
    return { ran: false as const, reason: "threw" as const };
  }
}

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const now = Date.now();
    // PR #258: windows come from the shared lib/cron/reminder-schedule module
    // (single source of truth with the invariant tests + vercel.json cadence).
    // 24h pass: 23-25h out. 2h pass: 1h45m-2h15m (30 min = 2x the */15 cadence,
    // so no appointment minute offset is ever missed and a single skipped cron
    // fire still leaves a grid point in-window).
    const win24 = reminderWindowIso("24h", now);
    const win2 = reminderWindowIso("2h", now);

    const reminder_24h = await sendReminderPass({
      kind: "24h",
      windowStartIso: win24.startIso,
      windowEndIso: win24.endIso,
    });
    const reminder_2h = await sendReminderPass({
      kind: "2h",
      windowStartIso: win2.startIso,
      windowEndIso: win2.endIso,
    });

    // SMS reminder passes run immediately after their email counterparts,
    // sharing the same time windows. They use independent queries on the
    // sms_* columns; an email reminder failure does not block the SMS
    // reminder and vice versa. Stats are added to the response JSON as
    // additional fields; existing email keys (reminder_24h /
    // reminder_2h) are unchanged so downstream log parsing stays
    // compatible.
    //
    // SMS-02 (Codex P1 4232680578): ONE ledger budget for this run, shared
    // by both SMS passes, so a stalled or slow ledger costs the run a bounded
    // wait however many reminders it carries. The email passes never touch
    // the SMS ledger.
    const ledgerBudget = createLedgerBudget();
    const sms_reminder_24h = await sendSmsReminderPass({
      kind: "24h",
      windowStartIso: win24.startIso,
      windowEndIso: win24.endIso,
      ledgerBudget,
    });
    const sms_reminder_2h = await sendSmsReminderPass({
      kind: "2h",
      windowStartIso: win2.startIso,
      windowEndIso: win2.endIso,
      ledgerBudget,
    });

    // PR #265: record a non-sensitive "last successful reminder cron run"
    // heartbeat AFTER all four passes complete (only reached on the authorized
    // success path; a thrown run skips this and the catch records
    // cron_route_failed instead). Best-effort/fail-open, never blocks the run.
    // Aggregate counts only: no client email/phone/name, notes, token, or URL.
    // OPS-01.1 (review 3775042692): `at` is the COMPLETION time (recency axis);
    // `invokedAt` is this run's real INVOCATION time: `startedAt`, captured
    // immediately after the auth gate and before any reminder work. Scheduler
    // cadence is the spacing between invocations, so a slow or fast run can no
    // longer distort it. `previousInvokedAt` is filled in atomically by the
    // heartbeat merge from the value this write displaces.
    await recordReminderRunSuccess({
      at: new Date().toISOString(),
      invokedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      emailAttempted: reminder_24h.attempted + reminder_2h.attempted,
      emailSucceeded: reminder_24h.succeeded + reminder_2h.succeeded,
      emailFailed: reminder_24h.failed + reminder_2h.failed,
      smsAttempted: sms_reminder_24h.attempted + sms_reminder_2h.attempted,
      smsSucceeded: sms_reminder_24h.succeeded + sms_reminder_2h.succeeded,
      smsFailed: sms_reminder_24h.failed + sms_reminder_2h.failed,
    });

    // LEAD-ALERT-01 (Codex P2 4253278108): bounded operator lead-alert
    // recovery on this existing 15-minute trigger, AFTER every reminder pass
    // and the heartbeat, so it can never change what reminders did. It is gated
    // before any database or provider call until lead alerts are configured,
    // never throws, and reports its own outcome: a lead-alert problem is an ops
    // alert and a field below, never a failed reminders run.
    const lead_alerts = await runLeadAlertRecovery();

    return NextResponse.json({
      ok: true,
      reminder_24h,
      reminder_2h,
      sms_reminder_24h,
      sms_reminder_2h,
      lead_alerts,
    });
  } catch (err) {
    // PR #153. Cron-route failure alert. The cron runs every few
    // minutes; if it starts throwing, reminders silently stop. The
    // 3-strike per-row attempt counter caps the blast radius once
    // the scheduler resumes, but the operator needs to know now.
    await recordOpsAlert({
      severity: "critical",
      event: "cron_route_failed",
      message:
        err instanceof Error ? err.message : String(err ?? "unknown error"),
      route: "/api/cron/appointment-reminders",
      safeDetails: {
        duration_ms: Date.now() - startedAt,
      },
    });
    // LEAD-ALERT-01 (Codex P2 4254097611): an unrelated reminders failure must
    // not stop lead-alert retries -- the daily backstop alone cannot keep the
    // 20-hour schedule. The SAME bounded, gated, never-throwing recovery runs
    // here too, AFTER the reminders' own failure alert. The reminders' 500 and
    // cron_route_failed are unchanged.
    const lead_alerts = await runLeadAlertRecovery();
    return NextResponse.json(
      { ok: false, error: "cron_failed", lead_alerts },
      { status: 500 },
    );
  }
}
