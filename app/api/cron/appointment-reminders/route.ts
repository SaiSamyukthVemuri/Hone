import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import {
  logEmailFailure,
  recordEmailAttempt,
  send24hReminderToClient,
  send2hReminderToClient,
  type EmailType,
} from "@/lib/email/send-appointment";
import {
  send24hReminderSmsToClient,
  send2hReminderSmsToClient,
} from "@/lib/sms/send-appointment";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";
import type { Appointment, Client, Service, Studio } from "@/lib/types/database";
import { getRequiredAppOrigin } from "@/lib/app-origin";

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
      "*, service:services(name, default_duration_minutes, pre_care_instructions), studio:studios(*), client:clients(name, email, phone, sms_consent_at, sms_opted_out_at), practitioner:practitioners(display_name, email)",
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

type RunStats = { attempted: number; succeeded: number; failed: number };

// SMS pass adds a "skipped" bucket so the operator can see how many
// rows the consent/toggle/claim gates filtered out without sending,
// which is the common case when SMS is enabled for a studio but most
// clients have not opted in yet.
type SmsRunStats = RunStats & { skipped: number };

async function sendReminderPass(opts: {
  kind: "24h" | "2h";
  windowStartIso: string;
  windowEndIso: string;
}): Promise<RunStats> {
  // The cron query intentionally remains untouched per the email-truthful
  // refactor spec. The bug was in how _sent_at got stamped, not in how
  // rows were picked. recordEmailAttempt handles attempts + timestamp
  // atomically via the record_email_attempt RPC (migration 0028).
  const sentColumn =
    opts.kind === "24h" ? "reminder_24h_sent_at" : "reminder_2h_sent_at";
  const attemptsColumn =
    opts.kind === "24h"
      ? "reminder_24h_send_attempts"
      : "reminder_2h_send_attempts";
  const studioToggle =
    opts.kind === "24h" ? "send_24h_reminders" : "send_2h_reminders";
  const emailType: EmailType =
    opts.kind === "24h" ? "reminder_24h" : "reminder_2h";

  const appts = await loadAppointmentsForWindow({
    startIso: opts.windowStartIso,
    endIso: opts.windowEndIso,
    notSentColumn: sentColumn,
    attemptsColumn,
  });

  const admin = createAdminClient();
  const stats: RunStats = { attempted: 0, succeeded: 0, failed: 0 };

  for (const appt of appts) {
    if (!appt.studio) continue;
    // Studio-level toggle.
    if (!(appt.studio as unknown as Record<string, boolean>)[studioToggle]) {
      continue;
    }
    if (!appt.client?.email) continue;

    stats.attempted += 1;
    const attemptNumber = (appt[attemptsColumn] as number) + 1;
    const token = appt.cancellation_token;
    if (!token) {
      // Without a token there's no cancel/reschedule URL. Record a failed
      // attempt via the RPC so we don't loop forever on rows that pre-date
      // the token backfill.
      await recordEmailAttempt(admin, appt.id, emailType, false);
      logEmailFailure({
        appointmentId: appt.id,
        emailType,
        error: "Missing cancellation_token",
        retryable: false,
        attemptNumber,
      });
      stats.failed += 1;
      continue;
    }
    const cronAppOrigin = getRequiredAppOrigin();
    const cancellationUrl = `${cronAppOrigin}/cancel/${token}`;
    const rescheduleUrl = `${cronAppOrigin}/reschedule/${token}`;
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
    const result = await sendFn({
      appointment: appt,
      service: appt.service,
      studio: appt.studio,
      practitionerDisplayName: practitionerName,
      clientName: appt.client.name,
      clientEmail: appt.client.email,
      cancellationUrl,
      rescheduleUrl,
      treatmentTimeLine,
    });
    await recordEmailAttempt(admin, appt.id, emailType, result.ok);
    if (result.ok) {
      stats.succeeded += 1;
    } else {
      logEmailFailure({
        appointmentId: appt.id,
        emailType,
        error: result.error,
        retryable: result.retryable,
        attemptNumber,
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
  };

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

    const token = appt.cancellation_token;
    // SMS reminders carry one neutral /manage/<token> link instead
    // of separate reschedule/cancel labels; the manage landing page
    // surfaces both actions after the studio's policies. Null when
    // the row lacks a column token (very old pre-backfill rows); the
    // SMS template then drops the manage line and still sends the
    // moment-only reminder.
    const manageUrl = token ? `${getRequiredAppOrigin()}/manage/${token}` : null;

    const sendFn =
      opts.kind === "24h"
        ? send24hReminderSmsToClient
        : send2hReminderSmsToClient;
    const result = await sendFn({
      admin,
      appointmentId: appt.id,
      startsAt: new Date(appt.starts_at),
      timezone: appt.studio.timezone,
      studio: appt.studio,
      client: {
        phone: appt.client.phone,
        sms_consent_at: appt.client.sms_consent_at,
        sms_opted_out_at: appt.client.sms_opted_out_at,
      },
      manageUrl,
    });
    if (result.ok) {
      stats.attempted += 1;
      stats.succeeded += 1;
    } else if (result.skipped) {
      // Helper-level skip (toggle race, claim collision, gate miss).
      // We do not count these as attempted because no Twilio call
      // was made; the operator wants attempted/succeeded/failed to
      // reflect actual Twilio invocations.
      stats.skipped += 1;
    } else {
      stats.attempted += 1;
      stats.failed += 1;
    }
  }

  return stats;
}

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  // 24h pass: appointments starting in 23-25h from now.
  const win24Start = new Date(now + 23 * 60 * 60 * 1000).toISOString();
  const win24End = new Date(now + 25 * 60 * 60 * 1000).toISOString();
  // 2h pass: 1h45m to 2h15m.
  const win2Start = new Date(now + 105 * 60 * 1000).toISOString();
  const win2End = new Date(now + 135 * 60 * 1000).toISOString();

  const reminder_24h = await sendReminderPass({
    kind: "24h",
    windowStartIso: win24Start,
    windowEndIso: win24End,
  });
  const reminder_2h = await sendReminderPass({
    kind: "2h",
    windowStartIso: win2Start,
    windowEndIso: win2End,
  });

  // SMS reminder passes run immediately after their email counterparts,
  // sharing the same time windows. They use independent queries on the
  // sms_* columns; an email reminder failure does not block the SMS
  // reminder and vice versa. Stats are added to the response JSON as
  // additional fields; existing email keys (reminder_24h /
  // reminder_2h) are unchanged so downstream log parsing stays
  // compatible.
  const sms_reminder_24h = await sendSmsReminderPass({
    kind: "24h",
    windowStartIso: win24Start,
    windowEndIso: win24End,
  });
  const sms_reminder_2h = await sendSmsReminderPass({
    kind: "2h",
    windowStartIso: win2Start,
    windowEndIso: win2End,
  });

  return NextResponse.json({
    ok: true,
    reminder_24h,
    reminder_2h,
    sms_reminder_24h,
    sms_reminder_2h,
  });
}
