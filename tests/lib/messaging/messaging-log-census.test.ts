import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  analyzeSource,
  censusOf,
  VERIFIED_FUNCTIONS,
  closedResultFunctions,
  CLOSED_RESULT_SOURCE,
  isSensitiveName,
  keyOf,
  literalViolation,
  surfaceFiles,
  type Writer,
} from "./log-census";

// ===========================================================================
// MSG-007: THE WHOLE-SURFACE MESSAGING LOG CENSUS.
//
// #1010, #1016, #1038, #1049 and #1076 each made one messaging log path
// minimum-necessary, and each is proved by its own behaviour test (see
// tests/lib/sms/helpers/log-capture.ts). None of them stops the NEXT log line.
// This file does: it enumerates every log writer on the messaging surface and
// holds each one to the #1076 rules.
//
// THE SURFACE (derived by git, see log-census.ts): every file under the SMS,
// email, waitlist, notification and portal-message modules, the Twilio webhook
// and cron routes, plus every application file that imports one of those
// modules. A WRITER is a console.* or safeLog.* call, or a call to a file-local
// helper that forwards its caller's object into one; such a helper's calls are
// followed, so `logEvent("x", { to: params.To })` is judged at the call.
//
// THE RULES, for everything a writer can put on the line (the source shows it):
//   1. no name that is a destination, credential or content: phone, email,
//      recipient, address, token, url, link, body, ... (a digest or a type of
//      one, "emailFingerprint", "smsType", is not the thing itself);
//   2. no literal that is a link, an email address, a token-bearing path, or a
//      phone number, masked or not;
//   3. nothing the analyzer cannot see into, and no forwarding helper whose
//      callers it cannot follow (an exported one) unless UNFOLLOWABLE lists it.
//      A helper parameter is followed whatever its type: a `string` can be a
//      payload the caller serialised (Codex P2 4368011462);
//   4. raw error or provider text only where ERROR_TEXT lists it (below).
//
// THE CENSUS is pinned: per file, the number of writers of each kind. Adding a
// writer fails here until it is classified: add it to CENSUS, and if it writes
// error text, to ERROR_TEXT with its kind. Moving code never fails; changing a
// log line passes as long as it still satisfies rules 1-3.
//
// FAIL CLOSED (Codex P2 4368011462, P2 4368062287). Anything the analyzer does
// not recognise is never clean: a constructor other than Date, a call whose
// function is not in VERIFIED_FUNCTIONS, a value named only as a container
// (payload, detail, data, result, ...) that cannot be followed, a caught value,
// an operator outside the enumerated sets, a console method or stdout write it
// did not know, a sink or helper used as a value. Each is either opaque (rule 3)
// or listed in ERROR_TEXT with its kind.
//
// THE LIMIT, stated plainly. Rules 1-3 are proved from the source. Error text
// is not: a database message, a thrown exception or a provider's error string
// is decided at run time. ERROR_TEXT is therefore not a proof of safety; it is
// the complete, frozen list of writers where that text reaches the log, so the
// set cannot grow without a reviewer seeing it.
//
// CLOSED RESULTS (MSG-LOG-RAW-ERROR). `result.error` is not raw text when
// `result` holds what a lib/email sender returned: EmailSendResult's failure
// `error` is the closed EmailSendFailure category (never the destination or the
// provider's message), and the census reads that from the source (see
// closedResultFunctions). The five portal, portal-login and intake-reissue rows
// that logged the old free text left ERROR_TEXT that way. The remaining
// "provider" rows log a raw provider error object or a thrown error themselves,
// and are their owners' to fix.
// ===========================================================================

const CENSUS: Record<string, Record<string, number>> = {
  "app/(app)/calendar/actions.ts": { "console.error": 12, "logBookingDbError()": 5, "logPostcare()": 3 },
  "app/(app)/calendar/move-appointment-actions.ts": { "console.error": 3 },
  "app/(app)/calendar/postcare-auto-send.ts": { "console.error": 1, "console.log": 1, "logOutcome()": 8 },
  "app/(app)/clients/[id]/actions.ts": { "safeLog.error": 7 },
  "app/(app)/clients/[id]/intake/actions.ts": { "logIntakeActionFailure()": 19, "safeLog.error": 3 },
  "app/(app)/clients/[id]/page.tsx": { "console.error": 1, "logClinicalReadFailure()": 4 },
  "app/(app)/clients/[id]/portal-messages-actions.ts": { "safeLog.error": 6 },
  "app/(app)/settings/team/actions.ts": { "console.error": 3, "console.warn": 1 },
  "app/(app)/settings/waitlist/consent-actions.ts": { "console.error": 1, "logRefusal()": 5 },
  "app/(app)/settings/waitlist/page.tsx": { "console.error": 5 },
  "app/(app)/settings/waitlist/profile-actions.ts": { "console.error": 1, "logRefusal()": 4 },
  "app/admin/studios/new/actions.ts": { "console.error": 1 },
  "app/api/cron/calendar-reconcile/route.ts": { "console.error": 1 },
  "app/api/cron/calendar-sync/route.ts": { "console.error": 1 },
  "app/api/cron/materialize-recurring-breaks/route.ts": { "console.error": 2 },
  "app/api/twilio/inbound-sms/route.ts": { "console.error": 1, "console.log": 1, "logError()": 12, "logEvent()": 3 },
  "app/api/twilio/message-status/route.ts": { "console.error": 1, "console.log": 1, "logError()": 4, "logEvent()": 4 },
  "app/book/[slug]/actions.ts": { "console.error": 6, "invitationBookingIndeterminate()": 1, "invitationConsumedWithoutBooking()": 6, "logInternalBookingError()": 15, "postCommit()": 11 },
  "app/book/[slug]/waitlist-actions.ts": { "console.error": 1, "logWaitlistEvent()": 17 },
  "app/cancel/[token]/actions.ts": { "logInternal()": 4, "safeLog.error": 2 },
  "app/intake/[token]/actions.ts": { "console.error": 4, "logInternalIntakeError()": 4 },
  "app/portal/login/actions.ts": { "console.log": 2, "logSanitized()": 6 },
  "app/portal/portal-message-actions.ts": { "console.error": 7 },
  "app/portal/rebook-actions.ts": { "console.error": 1, "logRebookError()": 13, "postCommit()": 10 },
  "app/reschedule/[token]/actions.ts": { "attempt()": 8, "console.error": 3, "logInternal()": 11 },
  "lib/billing/payment-receipt.ts": { "console.error": 2, "logInternal()": 4 },
  "lib/email/client.ts": { "console.warn": 1 },
  "lib/email/send-appointment.ts": { "console.error": 1, "logEmailDiagnostic()": 3, "safeLog.error": 1 },
  "lib/email/send-welcome.ts": { "console.error": 1, "markError()": 5 },
  "lib/notifications/practitioner-notifications.ts": { "console.error": 1, "logSilently()": 3 },
  "lib/ops/alert-email.ts": { "console.error": 2, "console.warn": 2 },
  "lib/portal-messages/queries.ts": { "console.error": 1 },
  "lib/portal-messages/replies-queries.ts": { "console.error": 1 },
  "lib/portal/magic-link.ts": { "console.error": 1, "safeLog.error": 1, "safeLog.info": 1 },
  "lib/rate-limit/public.ts": { "console.error": 3, "console.warn": 2, "limitMarketingForm()": 2, "logBackendUnavailable()": 10, "logRateLimitExceeded()": 15 },
  "lib/sms/delivery-ledger.ts": { "console.error": 1, "logLedger()": 17 },
  "lib/sms/send-appointment.ts": { "boundedLedgerStep()": 2, "console.error": 2, "logSmsDiagnostic()": 3, "readUnsentReminderAttemptNumber()": 1, "safeLog.error": 2, "safeLog.info": 2, "sendReminder()": 2 },
  "lib/waitlist/delivery/join-ack-sms.ts": { "console.log": 1, "log()": 4 },
  "lib/waitlist/delivery/sms.ts": { "console.log": 1, "log()": 4 },
  "lib/waitlist/invite-to-book-adapter.ts": { "console.error": 2, "recordFailed()": 2 },
  "lib/waitlist/operator-queue-presence.ts": { "console.error": 1 },
};

// Kinds:
//   db       a Supabase/PostgREST error's message. Postgres names the constraint,
//            not the row, but "invalid input syntax for type ...: <value>" echoes
//            the value it refused.
//   thrown   a caught exception's message or object.
//   provider a raw email-provider error object or a thrown send error, logged
//            by the call site itself.
//   closed   a closed vocabulary the analyzer cannot see: sendSmsSafely's error
//            tags (lib/sms/twilio.ts), payment-receipt's sanitiseSafe output.
//   input    (fail closed) a request or form value written as given
//            (formDataStr(...), formData.get(...), a slug): the browser decides it.
//   db_result (fail closed) a field of a database or RPC reply (`row.result`,
//            a destructured `data`): SQL decides it, the source cannot show it.
type ErrorKind = "db" | "thrown" | "provider" | "closed" | "input" | "db_result";
const ERROR_TEXT: ReadonlyArray<readonly [key: string, count: number, kind: ErrorKind]> = [
  ["app/(app)/calendar/actions.ts | console.error | practitioner_cancel_rpc_error", 1, "db"],
  ["app/(app)/calendar/actions.ts | console.error | client cancel notification email failed", 1, "provider"],
  ["app/(app)/calendar/actions.ts | console.error | mark_complete_rpc_error", 1, "db"],
  ["app/(app)/calendar/actions.ts | console.error | mark_no_show_rpc_error", 1, "db"],
  ["app/(app)/calendar/actions.ts | console.error | send_postcare_lookup_failed", 1, "db"],
  ["app/(app)/calendar/actions.ts | console.error | send_postcare_email_failed", 1, "input"],
  ["app/(app)/calendar/actions.ts | console.error | send_postcare_success_write_failed", 1, "input"],
  ["app/(app)/calendar/actions.ts | logPostcare() | send_postcare_claim_command_failed", 1, "input"],
  ["app/(app)/calendar/actions.ts | logPostcare() | send_postcare_claim_empty", 1, "input"],
  ["app/(app)/calendar/actions.ts | logPostcare() | send_postcare_settle_failure_unpersisted", 1, "input"],
  ["app/(app)/calendar/postcare-auto-send.ts | console.error | postcare_auto_send_threw", 1, "thrown"],
  ["app/(app)/clients/[id]/actions.ts | safeLog.error | client_update_failed", 1, "input"],
  ["app/(app)/clients/[id]/actions.ts | safeLog.error | client_archive_audit_failed", 1, "input"],
  ["app/(app)/clients/[id]/actions.ts | safeLog.error | client_unarchive_audit_failed", 1, "input"],
  ["app/(app)/clients/[id]/intake/actions.ts | safeLog.error | {code}", 1, "db"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_insert_failed", 1, "db"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_notification_stamp_failed", 1, "db"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_reply_mark_seen_failed", 1, "db"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_archive_failed", 1, "db"],
  ["app/(app)/settings/team/actions.ts | console.error | Failed to send invitation email:", 2, "provider"],
  ["app/(app)/settings/team/actions.ts | console.error | team_action_db_error:remove_practitioner:", 1, "db_result"],
  ["app/(app)/settings/waitlist/consent-actions.ts | logRefusal() | unknown", 1, "db_result"],
  ["app/(app)/settings/waitlist/profile-actions.ts | logRefusal() | waitlist_availability_failed", 1, "db_result"],
  ["app/(app)/settings/waitlist/profile-actions.ts | logRefusal() | waitlist_manual_entry_failed", 1, "db_result"],
  ["app/(app)/settings/waitlist/profile-actions.ts | logRefusal() | waitlist_legacy_import_failed", 1, "db_result"],
  ["app/api/cron/calendar-reconcile/route.ts | console.error | reminder_scheduler_health_check_threw", 1, "thrown"],
  ["app/api/cron/calendar-sync/route.ts | console.error | reminder_scheduler_health_check_threw", 1, "thrown"],
  ["app/api/cron/materialize-recurring-breaks/route.ts | console.error | recurring_break_materialization_conflict", 1, "db"],
  ["app/api/cron/materialize-recurring-breaks/route.ts | console.error | reminder_scheduler_health_check_threw", 1, "thrown"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_body_read_failed", 1, "thrown"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_client_scan_failed", 1, "thrown"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_client_optout_failed", 1, "db"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_prospect_scan_failed", 1, "thrown"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_prospect_optout_failed", 1, "db"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_audit_insert_failed", 1, "db"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_prospect_audit_insert_failed", 1, "db"],
  ["app/api/twilio/message-status/route.ts | logEvent() | twilio_status_recorded", 1, "db_result"],
  ["app/book/[slug]/actions.ts | console.error | booking_slot_rejected", 1, "db_result"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_client_not_resolved", 1, "db_result"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_command_refused", 1, "db_result"],
  ["app/book/[slug]/actions.ts | invitationConsumedWithoutBooking() | created", 1, "db_result"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_command_refused", 1, "db_result"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_studio_lookup_failed", 1, "input"],
  ["app/intake/[token]/actions.ts | console.error | Failed to look up client for intake sync:", 1, "db"],
  ["app/intake/[token]/actions.ts | console.error | Failed to sync intake to client:", 1, "db"],
  ["app/intake/[token]/actions.ts | logInternalIntakeError() | intake_lookup_error", 2, "db"],
  ["app/intake/[token]/actions.ts | logInternalIntakeError() | intake_save_update_error", 1, "db"],
  ["app/intake/[token]/actions.ts | logInternalIntakeError() | intake_submit_update_error", 1, "db"],
  ["app/portal/login/actions.ts | logSanitized() | portal_login_request_no_match", 1, "input"],
  ["app/portal/login/actions.ts | logSanitized() | portal_login_multiple_matches_needs_review", 1, "input"],
  ["app/portal/login/actions.ts | logSanitized() | portal_login_magic_insert_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_message_mark_reviewed_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_client_lookup_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_parent_lookup_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_insert_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_studio_lookup_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_notification_stamp_failed", 1, "db"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_slot_rejected", 1, "db_result"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_commit_refused", 1, "db_result"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_assert_lookup_failed", 1, "db"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_fetch_summary_failed", 1, "db"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_rpc_failed", 1, "db"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_command_unmapped_code", 1, "db_result"],
  ["lib/billing/payment-receipt.ts | logInternal() | payment_receipt_pdf_failed", 1, "closed"],
  ["lib/billing/payment-receipt.ts | logInternal() | {args}", 1, "db"],
  ["lib/billing/payment-receipt.ts | logInternal() | payment_receipt_claim_failed", 1, "db"],
  ["lib/billing/payment-receipt.ts | logInternal() | payment_receipt_sent_record_update_failed", 1, "db"],
  ["lib/notifications/practitioner-notifications.ts | logSilently() | practitioner_notification_insert_failed", 1, "db"],
  ["lib/notifications/practitioner-notifications.ts | logSilently() | practitioner_notification_insert_threw", 1, "thrown"],
  ["lib/portal-messages/queries.ts | console.error | portal_messages_for_practitioner_failed", 1, "db"],
  ["lib/portal-messages/replies-queries.ts | console.error | portal_message_replies_for_practitioner_failed", 1, "db"],
  ["lib/rate-limit/public.ts | console.error | ratelimit_backend_unavailable", 1, "thrown"],
  ["lib/sms/delivery-ledger.ts | logLedger() | sms_ledger_settle_refused", 1, "db_result"],
  ["lib/waitlist/delivery/join-ack-sms.ts | log() | not_claimed", 1, "db_result"],
  ["lib/waitlist/delivery/join-ack-sms.ts | log() | {outcome}", 1, "closed"],
  ["lib/waitlist/delivery/sms.ts | log() | not_claimed", 1, "db_result"],
  ["lib/waitlist/delivery/sms.ts | log() | {outcome}", 1, "closed"],
];

// Exported functions that write one of their own parameters whole, so their
// callers (in other files) are not followed. Each is a typed string record id
// written under its own name, not a payload; the name rule still applies to it,
// and a record id is #828 G-26's concern (safeLog), not a destination. Any
// other exported forwarder fails until it is listed here with its reason.
const UNFOLLOWABLE: Record<string, string> = {
  "app/(app)/calendar/postcare-auto-send.ts: autoSendPostcareOnComplete(appointmentId)":
    "appointmentId: string, written as the appointment reference in postcare_auto_send lines",
  "lib/waitlist/operator-queue-presence.ts: hasActiveWaitlistEntries(studioId)":
    "studioId: string, written as the studio reference in waitlist_nav_presence_failed",
};

const census = censusOf(surfaceFiles());
const writers: Writer[] = [...census.values()].flatMap((c) => c.writers);
const where = (w: Writer) => `${w.file}:${w.line} ${w.text}`;

describe("MSG-007 log census: the surface is the real one", () => {
  it("covers the SMS, email, waitlist and webhook writers #1076 proved one by one", () => {
    for (const file of [
      "lib/sms/send-appointment.ts",
      "lib/sms/delivery-ledger.ts",
      "lib/email/send-appointment.ts",
      "lib/waitlist/delivery/sms.ts",
      "lib/waitlist/delivery/join-ack-sms.ts",
      "app/api/twilio/inbound-sms/route.ts",
      "app/api/twilio/message-status/route.ts",
    ]) {
      expect(census.has(file), file).toBe(true);
    }
    expect(writers.length).toBeGreaterThan(200);
  });

  it("follows string-payload helpers to their calls (lib/email and lib/sms diagnostics)", () => {
    for (const [file, via] of [
      ["lib/email/send-appointment.ts", "logEmailDiagnostic()"],
      ["lib/sms/send-appointment.ts", "logSmsDiagnostic()"],
    ] as const) {
      const calls = writers.filter((w) => w.file === file && w.via === via);
      expect(calls.length, `${file} ${via}`).toBeGreaterThan(0);
      expect(calls.every((w) => w.label.length > 0 && !w.label.startsWith("{")), via).toBe(true);
    }
  });

  it("follows forwarding helpers to their calls (the webhook's logError is judged per event)", () => {
    const calls = writers.filter((w) => w.file === "app/api/twilio/inbound-sms/route.ts" && w.via === "logError()");
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((w) => w.label.startsWith("twilio_inbound_"))).toBe(true);
  });
});

describe("MSG-007 log census: every writer is classified", () => {
  it("the census of writers per file matches CENSUS exactly", () => {
    const actual: Record<string, Record<string, number>> = {};
    for (const w of writers) {
      actual[w.file] ??= {};
      actual[w.file][w.via] = (actual[w.file][w.via] ?? 0) + 1;
    }
    const drift: string[] = [];
    for (const file of new Set([...Object.keys(actual), ...Object.keys(CENSUS)])) {
      for (const via of new Set([...Object.keys(actual[file] ?? {}), ...Object.keys(CENSUS[file] ?? {})])) {
        const got = actual[file]?.[via] ?? 0;
        const pinned = CENSUS[file]?.[via] ?? 0;
        if (got !== pinned) {
          const sites = writers.filter((w) => w.file === file && w.via === via).map(where);
          drift.push(`${file} ${via}: pinned ${pinned}, found ${got}. Classify:\n    ${sites.join("\n    ")}`);
        }
      }
    }
    expect(drift, `unclassified or removed log writers:\n${drift.join("\n")}`).toEqual([]);
  });

  it("raw error text reaches the log only where ERROR_TEXT lists it", () => {
    const actual = new Map<string, number>();
    for (const w of writers) if (w.errorText.length > 0) actual.set(keyOf(w), (actual.get(keyOf(w)) ?? 0) + 1);
    const pinned = new Map(ERROR_TEXT.map(([key, count]) => [key, count]));
    const drift: string[] = [];
    for (const key of new Set([...actual.keys(), ...pinned.keys()])) {
      if (actual.get(key) !== pinned.get(key)) {
        const sites = writers.filter((w) => keyOf(w) === key).map((w) => `${where(w)}  [${w.errorText.join(", ")}]`);
        drift.push(`${key}: pinned ${pinned.get(key) ?? 0}, found ${actual.get(key) ?? 0}\n    ${sites.join("\n    ")}`);
      }
    }
    expect(drift, `error text not in ERROR_TEXT (or a listed row is gone):\n${drift.join("\n")}`).toEqual([]);
  });

  it("ERROR_TEXT has no duplicate rows", () => {
    const keys = ERROR_TEXT.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("MSG-007 log census: no writer carries a destination, link or token", () => {
  it("no writer writes a name that is a phone, email, recipient, token, link or body", () => {
    const bad = writers.flatMap((w) => [...new Set(w.names.filter(isSensitiveName))].map((n) => `${n} in ${where(w)}`));
    expect(bad).toEqual([]);
  });

  it("no writer writes a literal link, email address, token path or phone number", () => {
    const bad = writers.flatMap((w) =>
      w.literals.flatMap((l) => {
        const v = literalViolation(l);
        return v ? [`${v} (${JSON.stringify(l)}) in ${where(w)}`] : [];
      }),
    );
    expect(bad).toEqual([]);
  });

  it("no writer writes a value the census cannot see into", () => {
    const bad = writers.flatMap((w) => w.opaque.map((o) => `${o} in ${where(w)}`));
    expect(bad).toEqual([]);
  });

  it("every forwarding helper is file-local, so its callers are followed, or is listed in UNFOLLOWABLE", () => {
    const found = [...census].flatMap(([file, c]) => c.unfollowable.map((u) => `${file}: ${u}`)).sort();
    expect(found).toEqual(Object.keys(UNFOLLOWABLE).sort());
  });
});

describe("MSG-007 log census: VERIFIED_FUNCTIONS are what they claim", () => {
  it.each(Object.entries(VERIFIED_FUNCTIONS))("%s is declared in the file its entry names", (name, entry) => {
    if (entry.file === "builtin") {
      expect(name).toMatch(/^Math\.\w+$/);
      return;
    }
    const source = readFileSync(path.join(process.cwd(), entry.file), "utf8");
    expect(source).toMatch(new RegExp(`function ${name}\\(`));
  });
});

describe("MSG-LOG-RAW-ERROR: lib/email send results are closed by type", () => {
  const source = readFileSync(path.join(process.cwd(), CLOSED_RESULT_SOURCE), "utf8");

  it("EmailSendResult's failure carries only the closed EmailSendFailure category", () => {
    expect(source).toContain("| { ok: false; error: EmailSendFailure; retryable: boolean };");
    expect(source).toMatch(/export type EmailSendFailure = \(typeof EMAIL_SEND_FAILURES\)\[number\];/);
  });

  it("the closed senders are derived from the source, and include the ones the portal and intake log", () => {
    const closed = closedResultFunctions(source);
    for (const fn of ["sendEmailSafely", "sendIntakeUpdateRequestToClient", "sendCancellationEmail"]) {
      expect(closed.has(fn), fn).toBe(true);
    }
    // A sender that does not return EmailSendResult is not trusted.
    expect(closed.has("logEmailFailure")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The census itself, proved on synthetic sources: each rule must catch the
// shape it exists for, or a green census would mean nothing.
// ---------------------------------------------------------------------------

function analyze(source: string) {
  return analyzeSource("lib/sms/synthetic.ts", source);
}
function sensitive(w: Writer) {
  return w.names.filter(isSensitiveName);
}

describe("MSG-007 log census: the analyzer catches what it must", () => {
  it("a phone under any key, written directly", () => {
    const { writers: ws } = analyze(`export function f(to: string) { console.log(JSON.stringify({ event: "x", to })); }`);
    expect(ws).toHaveLength(1);
    expect(sensitive(ws[0])).toEqual(["to"]);
  });

  it("a destination handed to a forwarding helper is judged at the call", () => {
    const { writers: ws } = analyze(`
      function logEvent(event: string, fields: Record<string, unknown>) {
        console.log(JSON.stringify({ event, ...fields }));
      }
      export function g(params: { From: string; MessageSid: string }) {
        logEvent("ok", { sid: params.MessageSid });
        logEvent("leak", { from: params.From, clientEmail: "x" });
      }`);
    const calls = ws.filter((w) => w.via === "logEvent()");
    expect(calls.map((w) => w.label)).toEqual(["ok", "leak"]);
    expect(sensitive(calls[0])).toEqual([]);
    // The key, the provider field it reads (params.From), and the email key.
    expect(sensitive(calls[1])).toEqual(["from", "From", "clientEmail"]);
  });

  it("a helper that forwards its own object onward is followed through", () => {
    const { writers: ws, unfollowable } = analyze(`
      function base(fields: object) { console.error(JSON.stringify(fields)); }
      function mid(detail: Record<string, string>) { base(detail); }
      export function h(manageUrl: string) { mid({ manageUrl }); }`);
    expect(unfollowable).toEqual([]);
    expect(ws.filter((w) => w.via === "mid()").flatMap(sensitive)).toEqual(["manageUrl"]);
  });

  it("a helper that forwards a STRING payload is followed too (Codex P2 4368011462)", () => {
    // The shape of logEmailDiagnostic / logSmsDiagnostic: the payload is typed
    // `string`, so it is serialised before the helper sees it.
    const { writers: ws, unfollowable } = analyze(`
      function logDiag(payload: string): void {
        try { safeLog.error(payload); } catch { /* best effort */ }
      }
      export function f(opts: { error: string }) {
        logDiag(JSON.stringify({ event: "email_send_failed", to: opts.error, link: "https://leak.example.test/x" }));
      }`);
    expect(unfollowable).toEqual([]);
    const call = ws.find((w) => w.via === "logDiag()");
    expect(call?.label).toBe("email_send_failed");
    expect(call && sensitive(call)).toEqual(["to", "link"]);
    expect(call?.errorText).toEqual(["opts.error"]);
    expect(call?.literals.map(literalViolation).filter(Boolean)).toEqual(["a link"]);
  });

  it("an exported helper forwarding any parameter, string or object, is reported", () => {
    const { unfollowable } = analyze(`export function logLine(line: string) { console.error(line); }`);
    expect(unfollowable).toEqual(["logLine(line)"]);
  });

  it("an exported forwarding helper cannot be followed, and is reported", () => {
    const { unfollowable } = analyze(`export function logAny(fields: object) { console.log(fields); }`);
    expect(unfollowable).toEqual(["logAny(fields)"]);
  });

  it("a const payload is read through to what it holds", () => {
    const { writers: ws } = analyze(`
      export function k(phone: string) {
        const payload = JSON.stringify({ event: "y", phone });
        console.error(payload);
      }`);
    expect(sensitive(ws[0])).toEqual(["phone"]);
  });

  it("links, addresses, token paths and phone numbers in literals", () => {
    expect(literalViolation("see https://example.test/x")).toBe("a link");
    expect(literalViolation("sent to someone@example.test")).toBe("an email address");
    expect(literalViolation("/manage/abcdef123456")).toBe("a token-bearing path");
    expect(literalViolation("dialled +1 555 010 0199")).toBe("a phone number");
    expect(literalViolation("+1***99")).toBe("a masked phone number");
    expect(literalViolation("sms_ledger_step_timed_out")).toBeNull();
    expect(literalViolation("twilio_http_429")).toBeNull();
  });

  it("raw error text, and not the error's code", () => {
    const { writers: ws } = analyze(`
      export async function m(db: any) {
        const { error } = await db.from("t").select();
        if (error) console.error(JSON.stringify({ event: "z", code: error.code }));
        try { await db.rpc("x"); } catch (err) {
          console.error(JSON.stringify({ event: "w", message: err instanceof Error ? err.message : String(err) }));
        }
      }`);
    expect(ws[0].errorText).toEqual([]);
    expect(ws[1].errorText).toContain("err.message");
  });

  // --- FAIL CLOSED: one control per branch (Codex P2 4368062287) ---

  it("a constructor other than Date is not trusted, and its arguments are read", () => {
    const { writers: ws } = analyze(`
      export function q() {
        console.error(JSON.stringify({ event: "a", context: new URL("https://leak.example.test/manage/abcdef123456") }));
        console.error(JSON.stringify({ event: "b", at: new Date() }));
        console.error(JSON.stringify({ event: "c", failure: new Error("boom") }));
      }`);
    expect(ws[0].errorText).toEqual(["unresolved new URL"]);
    expect(ws[0].literals.map(literalViolation).filter(Boolean)).toEqual(["a link"]);
    expect(ws[1].errorText).toEqual([]);
    expect(ws[2].errorText).toEqual(["new Error"]);
  });

  it("a call's result is unresolved unless its function is verified", () => {
    const { writers: ws } = analyze(`
      function currentEnvironment(): string { return "x"; }
      export function r(a: string) {
        console.error(JSON.stringify({ event: "a", line: buildLine(a) }));
        console.error(JSON.stringify({ event: "b", environment: currentEnvironment() }));
      }`);
    expect(ws[0].errorText).toEqual(["unresolved call buildLine()"]);
    expect(ws[1].errorText).toEqual([]);
  });

  it("a ForLog-shaped name is not trusted unless verified", () => {
    const { writers: ws } = analyze(`
      export function s(err: Error) { console.error(JSON.stringify({ event: "a", f: madeUpForLog(err.message) })); }`);
    // Its input may be embedded in what it returns, and its result is not known.
    expect(ws[0].errorText).toEqual(["err.message", "unresolved call madeUpForLog()"]);
  });

  it("a container-named value that cannot be followed is unresolved, a descriptive one is judged by name", () => {
    const { writers: ws } = analyze(`
      export async function t(db: any) {
        let detail = await db.read();
        const { data } = await db.rpc("x");
        const { outcome } = await db.rpc("y");
        console.error(JSON.stringify({ event: "a", detail, result: data, code: data.result, outcome }));
      }`);
    expect(ws[0].errorText).toEqual(["unresolved let detail", "unresolved binding data", "unresolved property data.result"]);
  });

  it("a caught value is error text whatever it is called", () => {
    const { writers: ws } = analyze(`
      export async function u(f: () => Promise<void>) { try { await f(); } catch (problem) { console.error(String(problem)); } }`);
    expect(ws[0].errorText).toEqual(["problem"]);
  });

  it("the comma and assignment operators write their right side", () => {
    const { writers: ws } = analyze(`
      export function v(phone: string, n: number) {
        let last = "";
        console.error(JSON.stringify({ event: "a", x: (n++, phone), y: (last = phone) }));
      }`);
    expect(sensitive(ws[0])).toEqual(["phone", "phone"]);
  });

  it("every console method and process stdout/stderr writes are sinks", () => {
    const { writers: ws } = analyze(`
      export function w(phone: string) {
        console.table({ phone });
        process.stderr.write("see https://leak.example.test/x");
      }`);
    expect(ws.map((x) => x.via)).toEqual(["console.table", "process.stderr.write"]);
    expect(sensitive(ws[0])).toEqual(["phone"]);
    expect(ws[1].literals.map(literalViolation).filter(Boolean)).toEqual(["a link"]);
  });

  it("an aliased sink, or a helper passed as a value, is reported", () => {
    const { unfollowable } = analyze(`
      const out = console.log;
      function logEvent(fields: object) { console.error(JSON.stringify(fields)); }
      export function x(items: object[]) { items.forEach(logEvent); out("y"); }`);
    expect(unfollowable).toEqual(["sink used as a value: console.log", "helper used as a value: items.forEach(logEvent)"]);
  });

  it("an OUTER function's parameter reaching the line through a closure is followed", () => {
    const { writers: ws, unfollowable } = analyze(`
      function logLater(detail: object) {
        after(() => console.error(JSON.stringify(detail)));
      }
      export function y(phone: string) { logLater({ phone }); }`);
    expect(unfollowable).toEqual([]);
    expect(ws.filter((x) => x.via === "logLater()").flatMap(sensitive)).toEqual(["phone"]);
  });

  it("a closed sender's result.error is not raw text; any other result's is", () => {
    const src = `
      export async function p(send: any) {
        const closedResult = await sendEmailSafely({ to: "x" });
        if (!closedResult.ok) console.error(JSON.stringify({ event: "a", error: closedResult.error }));
        const other = await sendSomethingElse();
        if (!other.ok) console.error(JSON.stringify({ event: "b", error: other.error }));
        let reassigned = await sendEmailSafely({ to: "x" });
        reassigned = await sendSomethingElse();
        console.error(JSON.stringify({ event: "c", error: reassigned.error }));
      }`;
    const ws = analyzeSource("app/synthetic.ts", src, new Set(["sendEmailSafely"])).writers;
    expect(ws.map((w) => w.errorText)).toEqual([[], ["other.error"], ["reassigned.error"]]);
    // Without the closed set, every one is raw.
    expect(analyzeSource("app/synthetic.ts", src).writers.every((w) => w.errorText.length === 1)).toBe(true);
  });

  it("a digest or a closed log vocabulary is not its input", () => {
    const { writers: ws } = analyze(`
      export function n(email: string, raw: unknown) {
        console.error(JSON.stringify({ event: "v", emailFingerprint: hashFingerprint(email), failure: smsFailureForLog(raw) }));
      }`);
    expect(sensitive(ws[0])).toEqual([]);
    expect(ws[0].errorText).toEqual([]);
  });

  it("names: the thing is sensitive, a word about it is not", () => {
    for (const n of ["phone", "to", "from", "toMasked", "client_email", "manageUrl", "rawToken", "recipient", "messageBody", "address"]) {
      expect(isSensitiveName(n), n).toBe(true);
    }
    for (const n of ["toISOString", "toLowerCase", "fromStatus", "emailType", "smsType", "emailFingerprint", "emailHash", "tokenPresent", "messageSid", "studioId"]) {
      expect(isSensitiveName(n), n).toBe(false);
    }
  });
});
