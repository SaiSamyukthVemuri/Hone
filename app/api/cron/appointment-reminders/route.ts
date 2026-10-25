import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import {
  claimEmailSendOutcome,
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
import { createUpstashReminderScanCoordinator, runReminderScanBatch, ReminderScanReadFailure, type ReminderScanPass, type ReminderScanCursor } from "@/lib/cron/reminder-scan-coordinator";
import { recordReminderRunSuccess } from "@/lib/cron/reminder-heartbeat";

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
  after: ReminderScanCursor | null;
  limit: number;
  signal: AbortSignal;
}): Promise<Joined[]> {
  const admin = createAdminClient();
  let query = admin
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
    .order("id", { ascending: true })
    .limit(Math.min(PER_RUN_LIMIT, opts.limit))
    .abortSignal(opts.signal);
  if (opts.after) {
    // A total keyset order survives rows leaving the candidate set as this
    // pass records results. OFFSET would skip unsent work after those writes.
    const time = JSON.stringify(opts.after.startsAt);
    const id = JSON.stringify(opts.after.id);
    query = query.or(`starts_at.gt.${time},and(starts_at.eq.${time},id.gt.${id})`);
  }
  const { data, error } = await query;
  if (error) throw new ReminderScanReadFailure(error.code, opts.signal.aborted);

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
// Plain appointment reminders and SMS retain no-CTA degradation on read error.
// Standalone intake email requires a known read: an error cannot establish
// completion or justify clearing its counted claim without sending.
async function readLatestIntake(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
  clientId: string,
  requireKnown = false,
): Promise<{ id: string; status: string } | null> {
  const { data, error } = await admin
    .from("client_intake_forms")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (requireKnown && error) throw new Error("reminder intake state unavailable");
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
}, appt: Joined, admin: ReturnType<typeof createAdminClient>, stats: EmailRunStats, appOrigin: string): Promise<"claim_unavailable" | void> {
  const attemptsColumn =
    opts.kind === "24h"
      ? "reminder_24h_send_attempts"
      : "reminder_2h_send_attempts";
  const studioToggle =
    opts.kind === "24h" ? "send_24h_reminders" : "send_2h_reminders";
  const emailType: ClaimableEmailType =
    opts.kind === "24h" ? "reminder_24h" : "reminder_2h";

  if (!appt.studio) return;
  if (!appt.client?.email) return;

  const wantsReminder =
    (appt.studio as unknown as Record<string, boolean>)[studioToggle] === true;
  // Absent only on a studios row read before 0186 is applied. The column
  // defaults true, so absent must mean ENABLED, never disabled.
  const intakeEnabled = appt.studio.send_intake_reminders !== false;

  // CASE 6: nothing to send. No intake read, no claim, no attempt.
  if (!wantsReminder && !intakeEnabled) return;

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
      true,
    );
    if (probe?.status !== "in_progress") {
      // CASE 5. No claim, no attempt bump, no email.
      stats.skipped += 1;
      return;
    }
  }

  // Claim-before-send (PR #189, migration 0080): atomic attempt increment +
  // _claimed_at, so two overlapping cron runs can never both send.
  const claimOutcome = await claimEmailSendOutcome(admin, appt.id, emailType);
  if (claimOutcome === "unavailable") return "claim_unavailable";
  const claimed = claimOutcome === "claimed";
  if (!claimed) {
    stats.skipped += 1;
    return;
  }

  // Recheck the current start used to compose this cached email after claiming.
  // This contains observed reschedules; it is not an atomic send-time fence.
  const { data: fresh, error: freshError } = await admin
    .from("appointments")
    .select("status, starts_at")
    .eq("id", appt.id)
    .maybeSingle();
  // An unavailable read is not evidence that this row was handled. Use the
  // existing handler failure path; never settle or clear the counted claim.
  if (freshError) throw new Error("reminder appointment state unavailable");
  if (!fresh || fresh.status !== "confirmed") {
    stats.skipped += 1;
    return;
  }

  const currentStart = Date.parse(fresh.starts_at);
  if (
    !Number.isFinite(currentStart) ||
    currentStart !== Date.parse(appt.starts_at) ||
    currentStart < Date.parse(opts.windowStartIso) ||
    currentStart > Date.parse(opts.windowEndIso)
  ) {
    // No send occurred. Preserve the counted claim and existing TTL; do not
    // settle, clear, refund or create a retry from this unfenced observation.
    stats.skipped += 1;
    return;
  }

  // HON-13: the studio's switches are read LIVE at the send decision too. The
  // row was selected at the start of the run with the studio's settings as they
  // were then; a studio that switched this reminder (or intake reminders) off
  // while the batch was running must not have it sent anyway. The SMS pass
  // already refreshes its switches before dispatch. A reminder the live switch
  // forbids is released exactly like the CASE 4 -> 5 flip below: the claim is
  // cleared, nothing is sent, and the next fire re-evaluates from a fresh read.
  const { data: liveStudio, error: liveStudioError } = await admin
    .from("studios")
    .select(`${studioToggle}, send_intake_reminders`)
    .eq("id", appt.studio.id)
    .maybeSingle();
  // An unavailable read is not evidence that the switch is still on.
  if (liveStudioError || !liveStudio) {
    throw new Error("reminder studio switches unavailable");
  }
  const liveSwitches = liveStudio as unknown as Record<string, boolean | null>;
  const liveWantsReminder = liveSwitches[studioToggle] === true;
  const liveIntakeEnabled = liveSwitches.send_intake_reminders !== false;
  if (wantsReminder ? !liveWantsReminder : !liveIntakeEnabled) {
    await recordEmailResult(admin, appt.id, emailType, false);
    stats.skipped += 1;
    return;
  }

  // LIVE intake re-read, immediately before the send decision. Deliberately
  // a SECOND query, never the pre-claim probe reused: the probe answered
  // "should we claim", this answers "what do we send", and they are asked at
  // different instants. Skipped entirely when intake reminders are off
  // (CASE 3), which is also why a studio with the setting off never pays for
  // an intake lookup.
  const intake = intakeEnabled
    ? await readLatestIntake(admin, appt.studio.id, appt.client_id, !wantsReminder)
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
    return;
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
      return;
    }
    const cancellationUrl = `${appOrigin}/cancel/${token}`;
    const rescheduleUrl = `${appOrigin}/reschedule/${token}`;
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
    result = await sendIntakeReminderToClient({
      kind: opts.kind,
      appointmentId: appt.id,
      clientEmail: appt.client.email,
      studioName: appt.studio.name,
      startsAt: new Date(appt.starts_at),
      timezone: appt.studio.timezone,
      intakeUrl: intakeUrl as string,
    });
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
  ledgerBudget: LedgerBudget;
}, appt: Joined, admin: ReturnType<typeof createAdminClient>, stats: SmsRunStats, smsAppOrigin: string): Promise<"claim_unavailable" | void> {
  const studioToggle =
    opts.kind === "24h" ? "send_24h_sms_reminders" : "send_2h_sms_reminders";

  if (!appt.studio) return;
  if (!(appt.studio as unknown as Record<string, boolean>)[studioToggle]) {
    // Studio toggle is off: skip without an attempt counter bump.
    // We do not call into the SMS helper because the gate inside it
    // would just return skipped; saving the DB roundtrip on every
    // pass is meaningful at scale.
    return;
  }
  if (!appt.client) return;
  // Hard prerequisites for the SMS helper. Skipping early avoids a
  // claim roundtrip when there is no point.
  if (!appt.client.phone) return;
  if (!appt.client.sms_consent_at) return;
  if (appt.client.sms_opted_out_at) return;

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
    return;
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
    return manageToken ? `${smsAppOrigin}/manage/${manageToken}` : null;
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
    return;
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
    if (result.reason === "reminder_claim_unavailable") return "claim_unavailable";
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

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  let failureStage: "setup" | "scan" | "heartbeat" = "setup";
  try {
    const freshStats = (): EmailRunStats => ({ attempted: 0, succeeded: 0, failed: 0, skipped: 0, intakeCtaIncluded: 0 });
    const reminder_24h = freshStats();
    const reminder_2h = freshStats();
    const sms_reminder_24h = freshStats();
    const sms_reminder_2h = freshStats();
    const statsByPass: Record<ReminderScanPass, EmailRunStats> = { email24h: reminder_24h, email2h: reminder_2h, sms24h: sms_reminder_24h, sms2h: sms_reminder_2h };
    const admin = createAdminClient();
    const appOrigin = getRequiredAppOrigin();
    const ledgerBudget = createLedgerBudget();
    failureStage = "scan";
    const batch = await runReminderScanBatch({
      coordinator: createUpstashReminderScanCoordinator(),
      readPage: async (pass, page, signal) => {
        const kind = pass.endsWith("24h") ? "24h" : "2h";
        const prefix = pass.startsWith("sms") ? "sms_" : "";
        return loadAppointmentsForWindow({
          ...page, signal,
          notSentColumn: (prefix + "reminder_" + kind + "_sent_at") as SentColumn,
          attemptsColumn: (prefix + "reminder_" + kind + "_send_attempts") as AttemptsColumn,
        });
      },
      handle: async (pass, appt, window) => {
        const kind = pass.endsWith("24h") ? "24h" : "2h";
        const stats = statsByPass[pass];
        const attemptedBefore = stats.attempted;
        const opts = { kind, windowStartIso: window.startIso, windowEndIso: window.endIso } as const;
        const unavailable = pass.startsWith("sms")
          ? await sendSmsReminderPass({ ...opts, ledgerBudget }, appt, admin, stats, appOrigin)
          : await sendReminderPass(opts, appt, admin, stats, appOrigin);
        return {
          kind: unavailable === "claim_unavailable" ? "claim_unavailable" : stats.attempted > attemptedBefore ? "processed" : "skipped",
          attempted: stats.attempted > attemptedBefore,
        };
      },
    });
    // Retain the factual timeout even when a bounded read retry recovers.
    // This does not resolve prior alerts or establish message delivery.
    if (batch.readRetry?.recovered && batch.kind === "complete" && !batch.coverageUnconfirmed) {
      try {
        await recordOpsAlert({
          severity: "warning", event: "reminder_read_timeout",
          message: "A reminder candidate read timed out before a bounded retry recovered. Check scheduler progress.",
          route: "/api/cron/appointment-reminders",
          safeDetails: { failure_stage: "read", failure_category: "read_timeout",
            read_timeouts: batch.readRetry.timeouts, read_retries: batch.readRetry.attempted ? 1 : 0,
            read_retry_recovered: true, candidate_queries: batch.queries },
        });
      } catch { /* Best-effort observation; completion still requires all passes. */ }
    }
    if (batch.kind !== "complete" || batch.coverageUnconfirmed) {
      try {
        await recordOpsAlert({
          severity: batch.kind === "unavailable" ? "critical" : "warning",
          event: batch.kind === "unavailable" ? "cron_route_failed" : "reminder_scan_incomplete",
          message: "Reminder scan incomplete. Check scheduler progress before retrying work.",
          route: "/api/cron/appointment-reminders",
          safeDetails: {
            reason: batch.reason, candidates_scanned: batch.scanned, candidate_queries: batch.queries,
            attempted: batch.attempted, coverage_unconfirmed: batch.coverageUnconfirmed,
            ...(batch.readRetry ? { read_timeouts: batch.readRetry.timeouts,
              read_retries: batch.readRetry.attempted ? 1 : 0,
              read_retry_recovered: batch.readRetry.recovered } : {}),
            ...(batch.failure ? {
              failure_stage: batch.failure.stage, failure_category: batch.failure.category,
              ...(batch.failure.sqlState ? { sql_state: batch.failure.sqlState } : {}),
            } : {}),
          },
        });
      } catch { /* An incomplete run remains incomplete if its diagnostic fails. */ }
      return NextResponse.json({ ok: false, error: "cron_failed" }, { status: 500 });
    }

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
    failureStage = "heartbeat";
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

    return NextResponse.json({
      ok: true,
      reminder_24h,
      reminder_2h,
      sms_reminder_24h,
      sms_reminder_2h,
    });
  } catch {
    // Rejection values may contain private contents or hostile getters/proxies.
    // Never inspect them. A failed diagnostic must not replace the route's 500.
    try {
      await recordOpsAlert({
        severity: "critical",
        event: "cron_route_failed",
        message: "Reminder run failed. Check scheduler progress before retrying work.",
        route: "/api/cron/appointment-reminders",
        safeDetails: {
          duration_ms: Date.now() - startedAt,
          failure_stage: failureStage,
          failure_category: failureStage === "setup" ? "setup_failed"
            : failureStage === "heartbeat" ? "heartbeat_failed" : "scan_failed",
        },
      });
    } catch { /* The original run remains failed if its diagnostic cannot be stored. */ }
    return NextResponse.json(
      { ok: false, error: "cron_failed" },
      { status: 500 },
    );
  }
}
