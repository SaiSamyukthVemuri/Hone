import { NextResponse } from "next/server";
import { keysetFilter } from "@/lib/cron/reminder-keyset";
import {
  partitionRoutableStudios,
  refusalsToReport,
  truncationProven,
  type StudioRoutability,
} from "@/lib/cron/reminder-routable-studios";
import { resolveStudioSmsSender, studioSenderAllowsSend } from "@/lib/sms/studio-sender";
import { SENDER_REFUSAL_REASON } from "@/lib/sms/send-appointment";
import { assertDeterministicOrder, fetchAllRows } from "@/lib/export/paginate";
import type { SmsType } from "@/lib/types/database";
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
  type EmailSendResult,
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
import { reminderWindowIso } from "@/lib/cron/reminder-schedule";
import { recordReminderRunSuccess } from "@/lib/cron/reminder-heartbeat";

const PER_RUN_LIMIT = 50;

// ---------------------------------------------------------------------------
// BATCH STARVATION, AND WHY PAGING IS THE FIX
// ---------------------------------------------------------------------------
//
// A routing refusal is deliberately free: it sends nothing, claims no attempt,
// and leaves the sent column null. Correct per row — and it means the row's
// ELIGIBILITY IS UNCHANGED, so it sorts into exactly the same position on the
// next pass.
//
// With a single fixed first page of 50 ordered by starts_at, fifty earlier
// unroutable rows are therefore re-selected every pass, forever, and a later
// ROUTABLE row is never loaded at all — its reminder window closes while the
// cron reports a clean run. Provider-failed rows do not do this, because the
// claim increments `send_attempts` until they exceed MAX_ATTEMPTS and drop out
// of the filter. Routing refusals never touch that counter, which is exactly
// what makes them starving rather than self-limiting.
//
// So the pass PAGES FORWARD past refused candidates, and the two bounds that
// matter are kept separate:
//
//   SEND WORK   — rows that actually reached the send helper for a real
//                 attempt. Still capped at PER_RUN_LIMIT, so provider and
//                 claim load is exactly what it was before.
//   SCAN WORK   — rows merely examined and skipped. Capped independently, so a
//                 wholly unroutable estate cannot spin.
//
// A routing refusal costs SCAN budget and NOT send budget. That is the whole
// repair: the pass keeps looking until it has done its bounded amount of real
// work, rather than stopping because the first fifty candidates were unusable.
const REMINDER_PAGE_SIZE = 50;

/**
 * Hard ceiling on rows EXAMINED in one pass.
 *
 * Explicit, and it must never masquerade as full coverage: reaching it emits a
 * truthful ops alert naming how far the pass got, because "we scanned 500 rows
 * and stopped" and "we reached the end of the candidates" are different facts
 * and an operator must be able to tell them apart.
 */
const MAX_SCAN_ROWS = 500;

/**
 * The studios that could send this window's reminders at all.
 *
 * BOUNDED BY STUDIO COUNT, NOT BY BACKLOG. An earlier version enumerated
 * studios by scanning every eligible appointment in the window in 500-row
 * pages before any SMS work began. That defeated the per-run bound the pass
 * exists to honour: a large enough backlog could exhaust the cron's runtime
 * budget before it sent a single routable reminder — and capping that scan
 * would have reintroduced starvation, because a capped prefix of one broken
 * studio's rows yields no routable studios at all.
 *
 * Reading `studios` directly removes the coupling entirely. The set is small,
 * the query is one narrow column, and it is the same toggle the per-row gate
 * already consults — so a studio with the window's SMS toggle off is skipped
 * before a single appointment is read.
 */
async function toggledStudioIds(studioToggle: string): Promise<string[]> {
  const admin = createAdminClient();

  // PAGED, BECAUSE POSTGREST SILENTLY CAPS AT `max_rows` (1000).
  //
  // An unpaged select returns the first 1000 and says nothing. The studios
  // beyond that cap would never be resolved, never appear in `onlyStudioIds`,
  // and therefore lose every reminder on every invocation WITHOUT even
  // producing a routing alert — the alert only fires for studios this function
  // returned. That is the silent-loss failure this whole lane exists to
  // remove, reappearing one layer up.
  //
  // `fetchAllRows` is the repository's existing instrument for exactly this
  // and is all-or-nothing: a failure on page 7 fails the read rather than
  // returning six pages as if they were the table. `id` is the ordering and
  // the tiebreak, so pagination cannot duplicate one studio onto two pages
  // while dropping another.
  assertDeterministicOrder("studios", ["id"]);
  const { data, error } = await fetchAllRows<{ id: string }>((from, to) =>
    admin
      .from("studios")
      .select("id")
      .eq(studioToggle, true)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id);
}

/**
 * Report that a STUDIO cannot send, once per pass.
 *
 * Separate from the per-row `logSmsRoutingFailure` in the send helper: nothing
 * was claimed, no provider was called, and no particular appointment is being
 * described — this is a studio-level configuration fault, discovered while
 * deciding which studios are worth selecting rows for.
 *
 * It rides the same alert authority and the same three-word vocabulary, so
 * 0194's partial unique index on (studio_id, event) collapses repeats into one
 * OPEN alert per studio and the repeat is reported as a dedupe rather than a
 * failure.
 */
function logStudioRoutingRefusal(opts: {
  studioId: string;
  smsType: SmsType;
  reason: string;
}): void {
  console.error(
    JSON.stringify({
      event: "sms_routing_studio_excluded",
      studioId: opts.studioId,
      smsType: opts.smsType,
      reason: opts.reason,
      timestamp: new Date().toISOString(),
    }),
  );
  void (async () => {
    try {
      const { recordOpsAlert } = await import("@/lib/ops/alerts");
      await recordOpsAlert({
        severity: "warning",
        event: opts.reason,
        message: `SMS reminders (${opts.smsType}) cannot be sent: the studio has no usable sending identity.`,
        studioId: opts.studioId,
        route: "app/api/cron/appointment-reminders",
        safeDetails: {
          sms_type: opts.smsType,
          // Stated so an operator is not left inferring whether anything went
          // out, or whether the studio burned part of its attempt budget.
          attempt_claimed: false,
          provider_called: false,
          excluded_from_selection: true,
        },
      });
    } catch {
      // Never break the cron over alerting.
    }
  })();
}

/** Routing refusals — free of the send budget, by reason, from the helper. */
const ROUTING_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  "sms_sender_not_active_for_studio",
  "sms_sender_ambiguous",
  "sms_sender_read_failed",
]);
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
  /**
   * KEYSET cursor, exclusive: return only rows ordered after this one.
   *
   * Deliberately NOT `OFFSET`. Eligibility changes underneath a paging run —
   * a row sends and stamps its sent column, another is cancelled — so an
   * offset silently SKIPS rows when the prefix shrinks. A keyset on the same
   * (starts_at, id) the query orders by cannot: it names a position in the
   * ordering, not a count of rows that preceded it.
   */
  after?: { startsAt: string; id: string } | null;
  pageSize?: number;
  /**
   * Restrict selection to these studios.
   *
   * This is the fairness mechanism: a studio with no usable sender contributes
   * NO candidate rows, so it cannot occupy the page regardless of how many
   * appointments it has or how early they sort.
   */
  onlyStudioIds?: ReadonlyArray<string> | null;
}): Promise<Joined[]> {
  const admin = createAdminClient();
  let q = admin
    .from("appointments")
    .select(
      "*, service:services(name, default_duration_minutes, pre_care_instructions), studio:studios(*), client:clients(name, email, phone, sms_consent_at, sms_opted_out_at), practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name, email)",
    )
    .eq("status", "confirmed")
    .is(opts.notSentColumn, null)
    .lt(opts.attemptsColumn, MAX_ATTEMPTS)
    .gte("starts_at", opts.startIso)
    .lte("starts_at", opts.endIso)
    // `id` is the tiebreak, so (starts_at, id) is a TOTAL order. Without it two
    // appointments sharing a start have no defined order and a keyset cursor
    // could re-emit one and skip the other.
    .order("starts_at", { ascending: true })
    .order("id", { ascending: true });

  const keyset = keysetFilter(opts.after ?? null);
  if (keyset) q = q.or(keyset);
  if (opts.onlyStudioIds) q = q.in("studio_id", opts.onlyStudioIds as string[]);

  const { data, error } = await q.limit(opts.pageSize ?? PER_RUN_LIMIT);
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

  const admin = createAdminClient();
  const stats: SmsRunStats = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    intakeCtaIncluded: 0,
  };
  const smsAppOrigin = getRequiredAppOrigin();

  // FAIRNESS: resolve each candidate studio ONCE, then select only from the
  // studios that can actually send. An unroutable studio contributes no rows,
  // so it cannot occupy the page — the starvation has no surface left.
  const studioIds = await toggledStudioIds(studioToggle);
  const resolutions: StudioRoutability[] = [];
  for (const studioId of studioIds) {
    const r = await resolveStudioSmsSender(admin, studioId);
    resolutions.push(
      studioSenderAllowsSend(r)
        ? { studioId, routable: true }
        : { studioId, routable: false, reason: SENDER_REFUSAL_REASON[r.reason] },
    );
  }

  // REPORT BEFORE EXCLUDING.
  //
  // Filtering an unroutable studio out of selection means its rows never reach
  // `sendOne`, which is the ONLY path that records the durable `sms_sender_*`
  // alert. Without this, the fairness repair would trade starvation for
  // SILENCE: a studio with a missing, ambiguous or unreadable sender would lose
  // every reminder while producing no operator signal at all — strictly worse,
  // because a starving studio at least alerted on the rows it did reach.
  //
  // Once per studio per pass, not once per row, and 0194's partial unique index
  // collapses repeats into one open alert per (studio, event) — the dedupe an
  // earlier repair taught the recorder to report as expected rather than failed.
  const smsTypeForPass: SmsType =
    opts.kind === "24h" ? "reminder_24h" : "reminder_2h";
  for (const refusal of refusalsToReport(resolutions)) {
    logStudioRoutingRefusal({
      studioId: refusal.studioId,
      smsType: smsTypeForPass,
      reason: refusal.reason,
    });
  }

  const { routable, unroutable } = partitionRoutableStudios(resolutions);

  // Nothing can send this pass. Not an error — an unprovisioned estate is a
  // configuration fact, and every refusal above has already been reported.
  if (routable.length === 0) {
    stats.skipped += unroutable.length;
    return stats;
  }

  // Keyset cursor over (starts_at, id); see the batch-starvation note above.
  let cursor: { startsAt: string; id: string } | null = null;
  let sendWork = 0;
  let scanned = 0;
  let scanCeilingHit = false;
  let exhausted = false;

  pages: while (sendWork < PER_RUN_LIMIT && scanned < MAX_SCAN_ROWS) {
    const page = await loadAppointmentsForWindow({
      startIso: opts.windowStartIso,
      endIso: opts.windowEndIso,
      notSentColumn: sentColumn,
      attemptsColumn,
      after: cursor,
      // +1 LOOKAHEAD. A full page is NOT proof that more candidates existed:
      // a set of exactly REMINDER_PAGE_SIZE rows fills the page and ends.
      // Truncation may only be claimed when a further row was actually seen.
      pageSize: REMINDER_PAGE_SIZE + 1,
      onlyStudioIds: routable,
    });
    const hasMore = truncationProven({
      returned: page.length,
      limit: REMINDER_PAGE_SIZE,
    });
    const rows = page.slice(0, REMINDER_PAGE_SIZE);
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    // PROVEN EXHAUSTION IS RECORDED HERE, NOT AT THE BOTTOM.
    //
    // The `+1` lookahead already answered "is there another candidate?" for
    // this page. Waiting until after the row loop to act on it lost the answer
    // whenever the loop exited early: on an exactly-500 set the tenth page
    // processes row 500, trips the scan ceiling, and `break pages` jumps over
    // the `if (!hasMore)` block — so the pass emitted
    // `reminder_scan_ceiling_reached` and claimed later candidates existed
    // when the query had just proved they did not.
    if (!hasMore) exhausted = true;

    for (const appt of rows) {
      // Advance the cursor BEFORE any `continue`, so a skipped row can never be
      // re-fetched on the next page — which would be an infinite loop, not
      // merely a wasted read.
      cursor = { startsAt: appt.starts_at, id: appt.id };
      scanned += 1;
      if (scanned >= MAX_SCAN_ROWS) scanCeilingHit = true;

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
      let manageToken: string | null;
      try {
        manageToken = generateCancellationToken(appt.id, new Date(appt.starts_at));
      } catch {
        manageToken = null;
      }
      const manageUrl = manageToken
        ? `${smsAppOrigin}/manage/${manageToken}`
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
        intakeUrl: smsIntakeUrl,
      });
      if (result.ok) {
        stats.attempted += 1;
        stats.succeeded += 1;
        // Stamp intake-link metadata ONLY when the SMS that actually sent
        // carried the link. A plain appointment SMS must never look like an
        // intake link was issued, and the email pass's own stamp is separate.
        if (smsIntakeUrl && smsIntake) {
          await stampIntakeLinkIssued(admin, smsIntake.id, { emailed: false });
          stats.intakeCtaIncluded += 1;
        }
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

      // SEND BUDGET ACCOUNTING. A ROUTING REFUSAL IS FREE.
      //
      // This is the repair. A refusal did no provider work and claimed no
      // attempt, so charging it against the send budget is what let fifty
      // unroutable rows consume an entire pass. It costs scan budget only,
      // and the pass keeps paging until it has done its bounded amount of
      // REAL work.
      const routingRefused =
        !result.ok &&
        result.skipped === true &&
        ROUTING_REFUSAL_REASONS.has(result.reason);
      if (!routingRefused) sendWork += 1;
      if (sendWork >= PER_RUN_LIMIT) break pages;
      if (scanned >= MAX_SCAN_ROWS) break pages;
    }

    if (!hasMore) break; // already recorded as exhausted above
  }

  // TRUTHFUL EVIDENCE WHEN THE CEILING BITES.
  //
  // Stopping at the scan ceiling is NOT the same as reaching the end of the
  // candidates, and a pass that cannot tell an operator which one happened is
  // reporting a clean run it did not have.
  if (scanCeilingHit && !exhausted) {
    void (async () => {
      try {
        const { recordOpsAlert } = await import("@/lib/ops/alerts");
        await recordOpsAlert({
          severity: "warning",
          event: "reminder_scan_ceiling_reached",
          message:
            `SMS reminder pass (${opts.kind}) stopped at the ${MAX_SCAN_ROWS}-row scan ceiling; later eligible rows were NOT examined.`,
          route: "app/api/cron/appointment-reminders",
          safeDetails: {
            kind: opts.kind,
            scanned,
            send_work: sendWork,
            scan_ceiling: MAX_SCAN_ROWS,
            candidates_exhausted: false,
          },
        });
      } catch {
        // Never break the cron over alerting.
      }
    })();
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

    return NextResponse.json({
      ok: true,
      reminder_24h,
      reminder_2h,
      sms_reminder_24h,
      sms_reminder_2h,
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
