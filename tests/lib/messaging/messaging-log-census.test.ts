import { describe, expect, it } from "vitest";

import {
  analyzeSource,
  censusOf,
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
//      callers it cannot follow (an exported one);
//   4. raw error or provider text only where ERROR_TEXT lists it (below).
//
// THE CENSUS is pinned: per file, the number of writers of each kind. Adding a
// writer fails here until it is classified: add it to CENSUS, and if it writes
// error text, to ERROR_TEXT with its kind. Moving code never fails; changing a
// log line passes as long as it still satisfies rules 1-3.
//
// THE LIMIT, stated plainly. Rules 1-3 are proved from the source. Error text
// is not: a database message, a thrown exception or a provider's error string
// is decided at run time. ERROR_TEXT is therefore not a proof of safety; it is
// the complete, frozen list of writers where that text reaches the log, so the
// set cannot grow without a reviewer seeing it. The "provider" rows are the
// ones to fix first: lib/email/send-appointment.ts returns
// `Invalid recipient: <to>` for a malformed address, and forwards the email
// provider's own message, and those rows log that string.
// ===========================================================================

const CENSUS: Record<string, Record<string, number>> = {
  "app/(app)/calendar/actions.ts": { "console.error": 12, "logPostcare()": 3 },
  "app/(app)/calendar/move-appointment-actions.ts": { "console.error": 3 },
  "app/(app)/calendar/postcare-auto-send.ts": { "console.error": 1, "console.log": 1, "logOutcome()": 8 },
  "app/(app)/clients/[id]/actions.ts": { "safeLog.error": 7 },
  "app/(app)/clients/[id]/intake/actions.ts": { "safeLog.error": 3 },
  "app/(app)/clients/[id]/page.tsx": { "console.error": 1, "logClinicalReadFailure()": 4 },
  "app/(app)/clients/[id]/portal-messages-actions.ts": { "safeLog.error": 6 },
  "app/(app)/settings/team/actions.ts": { "console.error": 3, "console.warn": 1 },
  "app/(app)/settings/waitlist/consent-actions.ts": { "console.error": 1 },
  "app/(app)/settings/waitlist/page.tsx": { "console.error": 5 },
  "app/(app)/settings/waitlist/profile-actions.ts": { "console.error": 1 },
  "app/admin/studios/new/actions.ts": { "console.error": 1 },
  "app/api/cron/calendar-reconcile/route.ts": { "console.error": 1 },
  "app/api/cron/calendar-sync/route.ts": { "console.error": 1 },
  "app/api/cron/materialize-recurring-breaks/route.ts": { "console.error": 2 },
  "app/api/twilio/inbound-sms/route.ts": { "console.error": 1, "console.log": 1, "logError()": 12, "logEvent()": 3 },
  "app/api/twilio/message-status/route.ts": { "console.error": 1, "console.log": 1, "logError()": 4, "logEvent()": 4 },
  "app/book/[slug]/actions.ts": { "console.error": 6, "logInternalBookingError()": 15 },
  "app/book/[slug]/waitlist-actions.ts": { "console.error": 1, "logWaitlistEvent()": 17 },
  "app/cancel/[token]/actions.ts": { "logInternal()": 4, "safeLog.error": 2 },
  "app/intake/[token]/actions.ts": { "console.error": 4, "logInternalIntakeError()": 4 },
  "app/portal/login/actions.ts": { "console.log": 2, "logSanitized()": 6 },
  "app/portal/portal-message-actions.ts": { "console.error": 7 },
  "app/portal/rebook-actions.ts": { "console.error": 1, "logRebookError()": 13 },
  "app/reschedule/[token]/actions.ts": { "console.error": 3, "logInternal()": 11 },
  "lib/billing/payment-receipt.ts": { "console.error": 2, "logInternal()": 4 },
  "lib/email/client.ts": { "console.warn": 1 },
  "lib/email/send-appointment.ts": { "console.error": 1, "safeLog.error": 1 },
  "lib/email/send-welcome.ts": { "console.error": 1 },
  "lib/notifications/practitioner-notifications.ts": { "console.error": 1, "logSilently()": 3 },
  "lib/ops/alert-email.ts": { "console.error": 2, "console.warn": 2 },
  "lib/portal-messages/queries.ts": { "console.error": 1 },
  "lib/portal-messages/replies-queries.ts": { "console.error": 1 },
  "lib/portal/magic-link.ts": { "console.error": 1, "safeLog.error": 1, "safeLog.info": 1 },
  "lib/rate-limit/public.ts": { "console.error": 3, "console.warn": 2 },
  "lib/sms/delivery-ledger.ts": { "console.error": 1, "logLedger()": 17 },
  "lib/sms/send-appointment.ts": { "console.error": 2, "safeLog.error": 2, "safeLog.info": 2 },
  "lib/waitlist/delivery/join-ack-sms.ts": { "console.log": 1, "log()": 4 },
  "lib/waitlist/delivery/sms.ts": { "console.log": 1, "log()": 4 },
  "lib/waitlist/invite-to-book-adapter.ts": { "console.error": 2 },
  "lib/waitlist/operator-queue-presence.ts": { "console.error": 1 },
};

// Kinds:
//   db       a Supabase/PostgREST error's message. Postgres names the constraint,
//            not the row, but "invalid input syntax for type ...: <value>" echoes
//            the value it refused.
//   thrown   a caught exception's message or object.
//   provider an email send result's error, or a raw email-provider error (see
//            THE LIMIT above).
//   closed   a closed vocabulary the analyzer cannot see: sendSmsSafely's error
//            tags (lib/sms/twilio.ts), payment-receipt's sanitiseSafe output.
type ErrorKind = "db" | "thrown" | "provider" | "closed";
const ERROR_TEXT: ReadonlyArray<readonly [key: string, count: number, kind: ErrorKind]> = [
  ["app/(app)/calendar/actions.ts | console.error | practitioner_cancel_rpc_error", 1, "db"],
  ["app/(app)/calendar/actions.ts | console.error | client cancel notification email failed", 1, "provider"],
  ["app/(app)/calendar/actions.ts | console.error | mark_complete_rpc_error", 1, "db"],
  ["app/(app)/calendar/actions.ts | console.error | mark_no_show_rpc_error", 1, "db"],
  ["app/(app)/calendar/actions.ts | console.error | send_postcare_lookup_failed", 1, "db"],
  ["app/(app)/calendar/postcare-auto-send.ts | console.error | postcare_auto_send_threw", 1, "thrown"],
  ["app/(app)/clients/[id]/intake/actions.ts | safeLog.error | {event}", 1, "db"],
  ["app/(app)/clients/[id]/intake/actions.ts | safeLog.error | intake_reissue_email_failed", 2, "provider"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_insert_failed", 1, "db"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_email_send_failed", 1, "provider"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_notification_stamp_failed", 1, "db"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_reply_mark_seen_failed", 1, "db"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_archive_failed", 1, "db"],
  ["app/(app)/settings/team/actions.ts | console.error | Failed to send invitation email:", 2, "provider"],
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
  ["app/intake/[token]/actions.ts | console.error | Failed to look up client for intake sync:", 1, "db"],
  ["app/intake/[token]/actions.ts | console.error | Failed to sync intake to client:", 1, "db"],
  ["app/intake/[token]/actions.ts | logInternalIntakeError() | intake_lookup_error", 2, "db"],
  ["app/intake/[token]/actions.ts | logInternalIntakeError() | intake_save_update_error", 1, "db"],
  ["app/intake/[token]/actions.ts | logInternalIntakeError() | intake_submit_update_error", 1, "db"],
  ["app/portal/login/actions.ts | logSanitized() | portal_login_magic_insert_failed", 1, "db"],
  ["app/portal/login/actions.ts | logSanitized() | portal_login_email_send_failed", 1, "provider"],
  ["app/portal/portal-message-actions.ts | console.error | portal_message_mark_reviewed_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_client_lookup_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_parent_lookup_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_insert_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_studio_lookup_failed", 1, "db"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_email_send_failed", 1, "provider"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_notification_stamp_failed", 1, "db"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_assert_lookup_failed", 1, "db"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_fetch_summary_failed", 1, "db"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_rpc_failed", 1, "db"],
  ["lib/billing/payment-receipt.ts | logInternal() | payment_receipt_pdf_failed", 1, "closed"],
  ["lib/billing/payment-receipt.ts | logInternal() | {args}", 1, "db"],
  ["lib/billing/payment-receipt.ts | logInternal() | payment_receipt_claim_failed", 1, "db"],
  ["lib/billing/payment-receipt.ts | logInternal() | payment_receipt_sent_record_update_failed", 1, "db"],
  ["lib/notifications/practitioner-notifications.ts | logSilently() | practitioner_notification_insert_failed", 1, "db"],
  ["lib/notifications/practitioner-notifications.ts | logSilently() | practitioner_notification_insert_threw", 1, "thrown"],
  ["lib/portal-messages/queries.ts | console.error | portal_messages_for_practitioner_failed", 1, "db"],
  ["lib/portal-messages/replies-queries.ts | console.error | portal_message_replies_for_practitioner_failed", 1, "db"],
  ["lib/rate-limit/public.ts | console.error | ratelimit_backend_unavailable", 1, "thrown"],
  ["lib/waitlist/delivery/join-ack-sms.ts | log() | {outcome}", 1, "closed"],
  ["lib/waitlist/delivery/sms.ts | log() | {outcome}", 1, "closed"],
];

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

  it("every forwarding helper is file-local, so its callers are followed", () => {
    const bad = [...census].flatMap(([file, c]) => c.unfollowable.map((u) => `${file}: ${u}`));
    expect(bad).toEqual([]);
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
