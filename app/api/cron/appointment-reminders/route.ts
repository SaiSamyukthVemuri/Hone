import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import {
  claimEmailSend,
  logEmailFailure,
  recordEmailResult,
  send24hReminderToClient,
  send2hReminderToClient,
  sendIntakeReminderToClient,
  type ClaimableEmailType,
} from "@/lib/email/send-appointment";
import {
  generateIntakeLinkUrl,
  stampIntakeLinkIssued,
} from "@/lib/intake/queries";
import {
  send24hReminderSmsToClient,
  send2hReminderSmsToClient,
} from "@/lib/sms/send-appointment";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";
import type { Appointment, Client, Service, Studio } from "@/lib/types/database";
import { generateCancellationToken } from "@/lib/booking/tokens";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { recordOpsAlert } from "@/lib/ops/alerts";
import {
  intakeReminderWindowIso,
  reminderWindowIso,
} from "@/lib/cron/reminder-schedule";
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
  | "sms_reminder_2h_sent_at"
  | "intake_reminder_7d_sent_at"
  | "intake_reminder_3d_sent_at";
type AttemptsColumn =
  | "reminder_24h_send_attempts"
  | "reminder_2h_send_attempts"
  | "sms_reminder_24h_send_attempts"
  | "sms_reminder_2h_send_attempts"
  | "intake_reminder_7d_send_attempts"
  | "intake_reminder_3d_send_attempts";

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

// SMS pass counts consent/toggle/claim skips in the same bucket.
type SmsRunStats = RunStats;

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
    },
  });
}

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
  const emailType: ClaimableEmailType =
    opts.kind === "24h" ? "reminder_24h" : "reminder_2h";

  const appts = await loadAppointmentsForWindow({
    startIso: opts.windowStartIso,
    endIso: opts.windowEndIso,
    notSentColumn: sentColumn,
    attemptsColumn,
  });

  const admin = createAdminClient();
  const stats: RunStats = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };

  for (const appt of appts) {
    if (!appt.studio) continue;
    // Studio-level toggle.
    if (!(appt.studio as unknown as Record<string, boolean>)[studioToggle]) {
      continue;
    }
    if (!appt.client?.email) continue;

    // PR #189 (pilot safety): claim BEFORE the send so two
    // overlapping cron runs can never both email this row. The claim
    // RPC atomically increments the attempts counter and stamps
    // _claimed_at; losing the claim (another run holds it, already
    // sent, or attempts exhausted) skips the row without a send.
    const claimed = await claimEmailSend(admin, appt.id, emailType);
    if (!claimed) {
      stats.skipped += 1;
      continue;
    }

    // PR #258: a confirmed appointment can be cancelled / no-showed between the
    // window query and now; the claim does not re-validate status. Re-check
    // immediately before the send so a reminder is never emailed for a
    // no-longer-confirmed appointment. Idempotency stays owned by
    // claim-before-send; this only suppresses an out-of-date send (the bumped
    // claim attempt is harmless: a non-confirmed row is filtered out of the
    // next window query).
    const { data: fresh } = await admin
      .from("appointments")
      .select("status")
      .eq("id", appt.id)
      .maybeSingle();
    if (!fresh || fresh.status !== "confirmed") {
      stats.skipped += 1;
      continue;
    }

    stats.attempted += 1;
    const attemptNumber = (appt[attemptsColumn] as number) + 1;
    // PR #260/#264: appointment tokens are hash-only at rest (the raw
    // cancellation_token column was dropped in PR #264). The reminder mints
    // the stateless HMAC token (expires at the appointment start); /cancel
    // and /reschedule accept it, so the reminder links resolve.
    const token = generateCancellationToken(
      appt.id,
      new Date(appt.starts_at),
    );
    if (!token) {
      // Defensive: minting only fails if the appointment start is
      // unparseable. Record a failed result via the RPC (clears the
      // claim; the claim already counted the attempt) so we don't loop
      // forever on a structurally broken row.
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
    await recordEmailResult(admin, appt.id, emailType, result.ok);
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
      await alertIfReminderExhausted({
        studioId: appt.studio.id,
        appointmentId: appt.id,
        emailType,
        attemptNumber,
        retryable: result.retryable,
        reason: "send_failed",
      });
      stats.failed += 1;
    }
  }

  return stats;
}

// PR #306: intake-form reminder pass. Reuses the same claim-before-send
// idempotency + due-window loader as the appointment reminders, but only emails
// when the client's latest intake is still in_progress and always mints + stamps
// a FRESH secure intake link. No studio toggle (the per-appointment dedupe +
// skip-submitted + the 7d/3d cadence keep it non-spammy). Logs only ids/kinds,
// never a raw token or client PII.
async function sendIntakeReminderPass(opts: {
  kind: "7d" | "3d";
  windowStartIso: string;
  windowEndIso: string;
}): Promise<RunStats> {
  const sentColumn: SentColumn =
    opts.kind === "7d"
      ? "intake_reminder_7d_sent_at"
      : "intake_reminder_3d_sent_at";
  const attemptsColumn: AttemptsColumn =
    opts.kind === "7d"
      ? "intake_reminder_7d_send_attempts"
      : "intake_reminder_3d_send_attempts";
  const emailType: ClaimableEmailType =
    opts.kind === "7d" ? "intake_reminder_7d" : "intake_reminder_3d";

  const appts = await loadAppointmentsForWindow({
    startIso: opts.windowStartIso,
    endIso: opts.windowEndIso,
    notSentColumn: sentColumn,
    attemptsColumn,
  });

  const admin = createAdminClient();
  const stats: RunStats = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  const appOrigin = getRequiredAppOrigin();

  for (const appt of appts) {
    if (!appt.studio) continue;
    if (!appt.client?.email) continue;

    // Resolve the client's latest intake BEFORE claiming, so a submitted /
    // reviewed / missing intake is skipped without wasting a claim attempt.
    // Admin client (the cron is session-less); studio + client scoped so studio
    // isolation holds. Only id + status are read, no client PII, no token.
    const { data: intake } = await admin
      .from("client_intake_forms")
      .select("id, status")
      .eq("studio_id", appt.studio.id)
      .eq("client_id", appt.client_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!intake || intake.status !== "in_progress") {
      stats.skipped += 1;
      continue;
    }

    // Claim-before-send: two overlapping cron runs can never both email this
    // row (atomic increment + _claimed_at via claim_email_send, 0098 branch).
    const claimed = await claimEmailSend(admin, appt.id, emailType);
    if (!claimed) {
      stats.skipped += 1;
      continue;
    }

    // Cancellation re-check (mirrors the appointment reminder pass): suppress a
    // send for an appointment cancelled between the window query and now.
    const { data: fresh } = await admin
      .from("appointments")
      .select("status")
      .eq("id", appt.id)
      .maybeSingle();
    if (!fresh || fresh.status !== "confirmed") {
      stats.skipped += 1;
      continue;
    }

    stats.attempted += 1;
    const attemptNumber = (appt[attemptsColumn] as number) + 1;

    // Always mint a FRESH valid link (now + 14-day TTL; signed token stays the
    // authoritative expiry) so the reminder carries a working link. Saved
    // answers are preserved: this reuses the existing intake row, never a new
    // one. The raw token is never logged or stored.
    const intakeUrl = generateIntakeLinkUrl(intake.id, appOrigin);
    const result = await sendIntakeReminderToClient({
      clientEmail: appt.client.email,
      studioName: appt.studio.name,
      startsAt: new Date(appt.starts_at),
      timezone: appt.studio.timezone,
      intakeUrl,
    });
    await recordEmailResult(admin, appt.id, emailType, result.ok);
    if (result.ok) {
      // Stamp the PR #303 intake-link display metadata only on a real emailed
      // send (last_sent_at + expires_at + send_count).
      await stampIntakeLinkIssued(admin, intake.id, { emailed: true });
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

    // PR #258: same cancellation-race re-check as the email pass, never SMS a
    // reminder for an appointment cancelled/no-showed after the window query.
    const { data: freshSms } = await admin
      .from("appointments")
      .select("status")
      .eq("id", appt.id)
      .maybeSingle();
    if (!freshSms || freshSms.status !== "confirmed") {
      stats.skipped += 1;
      continue;
    }

    // PR #260/#264: appointment tokens are hash-only at rest (the raw
    // cancellation_token column was dropped in PR #264). Mint the stateless
    // HMAC token so the SMS manage link resolves (/manage accepts it). Null
    // only if minting fails (unparseable start); the SMS template then drops
    // the manage line and still sends the moment-only reminder.
    let manageToken: string | null;
    try {
      manageToken = generateCancellationToken(appt.id, new Date(appt.starts_at));
    } catch {
      manageToken = null;
    }
    const manageUrl = manageToken
      ? `${getRequiredAppOrigin()}/manage/${manageToken}`
      : null;

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
    const sms_reminder_24h = await sendSmsReminderPass({
      kind: "24h",
      windowStartIso: win24.startIso,
      windowEndIso: win24.endIso,
    });
    const sms_reminder_2h = await sendSmsReminderPass({
      kind: "2h",
      windowStartIso: win2.startIso,
      windowEndIso: win2.endIso,
    });

    // PR #306: intake-form reminder passes (7 days + 3 days before). Own wide
    // windows (2h each, centered on the target day) + own idempotency columns;
    // independent of the appointment/SMS reminders above.
    const win7d = intakeReminderWindowIso("7d", now);
    const win3d = intakeReminderWindowIso("3d", now);
    const intake_reminder_7d = await sendIntakeReminderPass({
      kind: "7d",
      windowStartIso: win7d.startIso,
      windowEndIso: win7d.endIso,
    });
    const intake_reminder_3d = await sendIntakeReminderPass({
      kind: "3d",
      windowStartIso: win3d.startIso,
      windowEndIso: win3d.endIso,
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
      emailAttempted:
        reminder_24h.attempted +
        reminder_2h.attempted +
        intake_reminder_7d.attempted +
        intake_reminder_3d.attempted,
      emailSucceeded:
        reminder_24h.succeeded +
        reminder_2h.succeeded +
        intake_reminder_7d.succeeded +
        intake_reminder_3d.succeeded,
      emailFailed:
        reminder_24h.failed +
        reminder_2h.failed +
        intake_reminder_7d.failed +
        intake_reminder_3d.failed,
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
      intake_reminder_7d,
      intake_reminder_3d,
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
    return NextResponse.json(
      { ok: false, error: "cron_failed" },
      { status: 500 },
    );
  }
}
