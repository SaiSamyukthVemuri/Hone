import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  analyzeSource,
  censusOf,
  VERIFIED_FUNCTIONS,
  ALLOWED_SHAPES,
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
// RELATION TO #1138 (MSG-LOG-RAW-ERROR-2, tests/lib/logging/raw-error-log-contract.test.ts).
// The two contracts are different questions and both must hold:
//   #1138 = no raw ERROR TEXT anywhere in app/ and lib/ (an empty allow-list);
//   #1106 = no DESTINATION, CREDENTIAL or CONTENT in a MESSAGING log, and a
//           frozen inventory of what the source cannot prove.
// This census does not re-implement #1138: its classifiers (dbErrorCode,
// safeDbCode, thrownErrorClass, stripeErrorFields, failureCode,
// boundedErrorLabel) are VERIFIED_FUNCTIONS here, so a caught error handed to
// one is clean and ERROR_TEXT_SITES below is what is left of "error text".
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
//   3. no forwarding helper whose callers it cannot follow (an exported one)
//      unless UNFOLLOWABLE lists it. A helper parameter is followed whatever
//      its type: a `string` can be a payload the caller serialised (Codex P2
//      4368011462);
//   4. DEFAULT-DENY: a written value is clean ONLY when it is one of
//      ALLOWED_SHAPES (log-census.ts, pinned below): literals, templates and
//      object/array literals made of allowed parts, Date, a const resolved to an
//      allowed value, a parameter declared as a closed literal union, the
//      result of a VERIFIED_FUNCTIONS entry, a count. EVERYTHING else (a local
//      property read, an unresolved identifier, any other call, a computed
//      member, a constructor) is UNPROVEN, and its writer is an UNPROVEN row.
//
// THE CENSUS is pinned: per file, the number of writers of each kind. Adding a
// writer fails here until it is classified: add it to CENSUS, and if any part
// of it is unproven, to UNPROVEN with its kind. Moving code never fails.
//
// WHY DEFAULT-DENY (Codex P2 4368011462, 4368062287, 4368117155). Three review
// rounds each found one more value shape the analyzer accepted without proof
// (a string payload, a constructor, a local property read). Patching shapes one
// at a time does not converge, so the rule is inverted: nothing is clean unless
// it is on the short, pinned list of shapes that are proved.
//
// THE LIMIT, stated plainly. Rules 1-3 and the allowed shapes are proved from
// the source. UNPROVEN is therefore NOT a safety claim and not a list of leaks:
// it is the complete, frozen INVENTORY of writers that write something the
// source cannot prove (a record id, an error code, a database message, a form
// value), so the set cannot grow without a reviewer seeing it. Its kinds say
// what each row writes; "provider", "input" and "db_result" are the ones to
// reduce first.
// ===========================================================================

const CENSUS: Record<string, Record<string, number>> = {
  "app/(app)/calendar/actions.ts": { "console.error": 11, "logBookingDbError()": 5, "logPostcare()": 3, "safeLog.error": 1 },
  "app/(app)/calendar/move-appointment-actions.ts": { "console.error": 3 },
  "app/(app)/calendar/postcare-auto-send.ts": { "console.error": 1, "console.log": 1, "logOutcome()": 8 },
  "app/(app)/clients/[id]/actions.ts": { "safeLog.error": 7 },
  "app/(app)/clients/[id]/intake/actions.ts": { "logIntakeActionFailure()": 19, "safeLog.error": 3 },
  "app/(app)/clients/[id]/page.tsx": { "console.error": 1, "logClinicalReadFailure()": 4 },
  "app/(app)/clients/[id]/portal-messages-actions.ts": { "safeLog.error": 6 },
  "app/(app)/settings/team/actions.ts": { "console.error": 1, "console.warn": 1, "safeLog.error": 2 },
  "app/(app)/settings/waitlist/consent-actions.ts": { "console.error": 1, "logRefusal()": 5 },
  "app/(app)/settings/waitlist/page.tsx": { "console.error": 5 },
  "app/(app)/settings/waitlist/profile-actions.ts": { "console.error": 1, "logRefusal()": 4 },
  "app/admin/studios/new/actions.ts": { "console.error": 1 },
  "app/api/cron/calendar-reconcile/route.ts": { "console.error": 1 },
  "app/api/cron/calendar-sync/route.ts": { "console.error": 1 },
  "app/api/cron/materialize-recurring-breaks/route.ts": { "console.error": 2 },
  "app/api/twilio/inbound-sms/route.ts": { "console.error": 1, "console.log": 1, "logError()": 12, "logEvent()": 3 },
  "app/api/twilio/message-status/route.ts": { "console.error": 1, "console.log": 1, "logError()": 4, "logEvent()": 4 },
  "app/book/[slug]/actions.ts": { "console.error": 6, "invitationBookingIndeterminate()": 1, "invitationConsumedWithoutBooking()": 6, "logInternalBookingError()": 16, "postCommit()": 11 },
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
//   provider the `.error` of an EMAIL or SMS send result. By type it is a closed
//            tag (EmailSendFailure; sendSmsSafely's twilio_* tags), but the
//            analyzer reads an `.error` property as error-like, so these rows
//            are the ERROR_TEXT_SITES pinned below and nothing else is.
//   closed   a closed vocabulary the analyzer cannot see (the same send-result
//            tags, written next to a settle outcome).
//   input    (fail closed) a request or form value written as given
//            (formDataStr(...), formData.get(...), a slug): the browser decides it.
//   db_result (fail closed) a field of a database or RPC reply (`row.result`,
//            a destructured `data`): SQL decides it, the source cannot show it.
//   value    (default-deny) a property, identifier or call result the source
//            does not resolve to an allowed shape: most often a record id
//            (studio.id), an error or status code (error.code), a flag
//            (result.retryable) or a count. Not known to be unsafe; not proven.
// There is no "db" or "thrown" kind any more: since #1138 a database error or a
// caught exception reaches a log line only as dbErrorCode() / thrownErrorClass(),
// both in VERIFIED_FUNCTIONS, and a test below fails if one is written whole.
type UnprovenKind = "provider" | "closed" | "input" | "db_result" | "value";
const UNPROVEN: ReadonlyArray<readonly [key: string, count: number, kind: UnprovenKind]> = [
  ["app/(app)/calendar/actions.ts | console.error | booking_slot_collision", 1, "value"],
  ["app/(app)/calendar/actions.ts | console.error | booking_action_post_commit_error:dispatch:", 1, "value"],
  ["app/(app)/calendar/actions.ts | console.error | practitioner_cancel_rpc_error", 1, "value"],
  ["app/(app)/calendar/actions.ts | console.error | mark_complete_rpc_error", 1, "value"],
  ["app/(app)/calendar/actions.ts | console.error | mark_no_show_rpc_error", 1, "value"],
  ["app/(app)/calendar/actions.ts | console.error | send_postcare_lookup_failed", 1, "value"],
  ["app/(app)/calendar/actions.ts | console.error | send_postcare_email_failed", 1, "input"],
  ["app/(app)/calendar/actions.ts | console.error | send_postcare_success_write_failed", 1, "input"],
  ["app/(app)/calendar/actions.ts | logPostcare() | send_postcare_claim_command_failed", 1, "input"],
  ["app/(app)/calendar/actions.ts | logPostcare() | send_postcare_claim_empty", 1, "input"],
  ["app/(app)/calendar/actions.ts | logPostcare() | send_postcare_settle_failure_unpersisted", 1, "input"],
  ["app/(app)/calendar/postcare-auto-send.ts | console.error | postcare_auto_send_threw", 1, "value"],
  ["app/(app)/calendar/postcare-auto-send.ts | logOutcome() | load_error", 2, "value"],
  ["app/(app)/calendar/postcare-auto-send.ts | logOutcome() | {appointmentId}", 1, "value"],
  ["app/(app)/calendar/postcare-auto-send.ts | logOutcome() | not_claimed", 1, "value"],
  ["app/(app)/calendar/postcare-auto-send.ts | logOutcome() | settle_failed", 2, "value"],
  ["app/(app)/calendar/postcare-auto-send.ts | logOutcome() | failed", 1, "value"],
  ["app/(app)/calendar/postcare-auto-send.ts | logOutcome() | sent", 1, "value"],
  ["app/(app)/clients/[id]/actions.ts | safeLog.error | client_update_possible_duplicate_lookup_failed", 1, "value"],
  ["app/(app)/clients/[id]/actions.ts | safeLog.error | client_update_failed", 1, "input"],
  ["app/(app)/clients/[id]/actions.ts | safeLog.error | client_archive_audit_failed", 1, "input"],
  ["app/(app)/clients/[id]/actions.ts | safeLog.error | client_unarchive_audit_failed", 1, "input"],
  ["app/(app)/clients/[id]/intake/actions.ts | safeLog.error | {code}", 1, "value"],
  ["app/(app)/clients/[id]/intake/actions.ts | safeLog.error | intake_reissue_email_failed", 2, "provider"],
  ["app/(app)/clients/[id]/page.tsx | logClinicalReadFailure() | client_profile_recent_blocks_read_failed", 2, "value"],
  ["app/(app)/clients/[id]/page.tsx | logClinicalReadFailure() | client_profile_intelligence_blocks_read_failed", 2, "value"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_email_send_failed", 1, "provider"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_notification_stamp_failed", 1, "value"],
  ["app/(app)/clients/[id]/portal-messages-actions.ts | safeLog.error | portal_message_archive_failed", 1, "value"],
  ["app/(app)/settings/team/actions.ts | console.error | team_action_db_error:remove_practitioner:", 1, "db_result"],
  ["app/(app)/settings/waitlist/consent-actions.ts | logRefusal() | entry_read_failed", 1, "value"],
  ["app/(app)/settings/waitlist/consent-actions.ts | logRefusal() | phone_not_textable", 1, "value"],
  ["app/(app)/settings/waitlist/consent-actions.ts | logRefusal() | suppression_read_failed", 1, "value"],
  ["app/(app)/settings/waitlist/consent-actions.ts | logRefusal() | phone_suppressed", 1, "value"],
  ["app/(app)/settings/waitlist/consent-actions.ts | logRefusal() | unknown", 1, "db_result"],
  ["app/(app)/settings/waitlist/page.tsx | console.error | waitlist_capacity_impossible_shape", 1, "value"],
  ["app/(app)/settings/waitlist/page.tsx | console.error | waitlist_queue_load_failed", 1, "value"],
  ["app/(app)/settings/waitlist/page.tsx | console.error | waitlist_preferences_load_failed", 1, "value"],
  ["app/(app)/settings/waitlist/page.tsx | console.error | waitlist_composer_services_read_failed", 1, "value"],
  ["app/(app)/settings/waitlist/page.tsx | console.error | waitlist_invitation_window_read_failed", 1, "value"],
  ["app/(app)/settings/waitlist/profile-actions.ts | logRefusal() | waitlist_availability_failed", 1, "db_result"],
  ["app/(app)/settings/waitlist/profile-actions.ts | logRefusal() | waitlist_manual_entry_failed", 1, "db_result"],
  ["app/(app)/settings/waitlist/profile-actions.ts | logRefusal() | waitlist_legacy_import_failed", 2, "db_result"],
  ["app/admin/studios/new/actions.ts | console.error | new_studio_orphan_cleanup_failed", 1, "value"],
  ["app/api/cron/materialize-recurring-breaks/route.ts | console.error | recurring_break_materialization_conflict", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logEvent() | twilio_inbound_non_stop", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logEvent() | twilio_inbound_stop_no_digits", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logEvent() | twilio_inbound_stop_processed", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_client_scan_failed", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_client_optout_failed", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_prospect_scan_failed", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_prospect_optout_failed", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_audit_insert_failed", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_prospect_audit_insert_failed", 1, "value"],
  ["app/api/twilio/inbound-sms/route.ts | logError() | twilio_inbound_stop_partial_optout_failed", 1, "value"],
  ["app/api/twilio/message-status/route.ts | logEvent() | twilio_status_recorded", 1, "db_result"],
  ["app/book/[slug]/actions.ts | console.error | waitlist_invitation_booking_outcome_indeterminate", 1, "value"],
  ["app/book/[slug]/actions.ts | console.error | waitlist_invitation_consumed_without_booking", 1, "value"],
  ["app/book/[slug]/actions.ts | console.error | booking_slot_rejected", 1, "db_result"],
  ["app/book/[slug]/actions.ts | console.error | booking_slot_collision", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_slots_service_lookup_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_slots_availability_read_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_next_available_service_lookup_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_next_available_range_read_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_advisory_read_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_client_lookup_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_sms_consent_update_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_app_origin_unresolved", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_archived_client_collision", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_client_not_resolved", 1, "db_result"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_command_refused", 1, "db_result"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_insert_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | unknown", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_practitioner_lookup_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_marketing_consent_insert_failed", 1, "value"],
  ["app/book/[slug]/actions.ts | invitationConsumedWithoutBooking() | created", 1, "db_result"],
  ["app/book/[slug]/actions.ts | logInternalBookingError() | public_booking_identity_unconfirmed", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_client_email_not_accepted", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_client_email_threw", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_join_ack_sms_threw", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_admin_client_unavailable", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_command_not_deployed", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_command_threw", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_duplicate_submission", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_command_refused", 1, "db_result"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_no_studio_recipient", 2, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_studio_email_not_accepted", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_studio_email_threw", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_joined", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_admission_changed_before_send", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_studio_email_unconfirmed", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_studio_email_rejected", 1, "value"],
  ["app/book/[slug]/waitlist-actions.ts | logWaitlistEvent() | new_client_waitlist_studio_lookup_failed", 1, "input"],
  ["app/portal/login/actions.ts | logSanitized() | portal_login_request_no_match", 1, "input"],
  ["app/portal/login/actions.ts | logSanitized() | portal_login_multiple_matches_needs_review", 1, "input"],
  ["app/portal/login/actions.ts | logSanitized() | portal_login_email_send_failed", 1, "provider"],
  ["app/portal/login/actions.ts | logSanitized() | portal_login_request_match", 1, "value"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_email_send_failed", 1, "provider"],
  ["app/portal/portal-message-actions.ts | console.error | portal_reply_notification_stamp_failed", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_client_lookup_failed", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_studio_lookup_failed", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_readiness_read_failed", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_service_read_failed", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_slot_read_failed", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_next_available_read_failed", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_advisory_read_failed", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_app_origin_unresolved", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_slot_rejected", 1, "db_result"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_commit_refused", 1, "db_result"],
  ["app/portal/rebook-actions.ts | logRebookError() | unknown", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_practitioner_lookup_failed", 1, "value"],
  ["app/portal/rebook-actions.ts | logRebookError() | portal_rebook_no_client_email_on_file", 1, "value"],
  ["app/reschedule/[token]/actions.ts | console.error | booking_slot_collision", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_assert_lookup_failed", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_fetch_summary_failed", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_slots_read_failed", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_studio_lookup_failed", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_client_metadata_unavailable", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_app_origin_unresolved", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_rpc_failed", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_command_unmapped_code", 1, "db_result"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_malformed_success_row", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | unknown", 1, "value"],
  ["app/reschedule/[token]/actions.ts | logInternal() | public_reschedule_practitioner_lookup_failed", 1, "value"],
  ["lib/billing/payment-receipt.ts | logInternal() | payment_receipt_pdf_failed", 1, "closed"],
  ["lib/billing/payment-receipt.ts | logInternal() | {args}", 1, "value"],
  ["lib/billing/payment-receipt.ts | logInternal() | payment_receipt_claim_failed", 1, "value"],
  ["lib/billing/payment-receipt.ts | logInternal() | payment_receipt_sent_record_update_failed", 1, "value"],
  ["lib/notifications/practitioner-notifications.ts | logSilently() | practitioner_notification_invalid_event_type", 1, "value"],
  ["lib/notifications/practitioner-notifications.ts | logSilently() | practitioner_notification_insert_failed", 1, "value"],
  ["lib/notifications/practitioner-notifications.ts | logSilently() | practitioner_notification_insert_threw", 1, "value"],
  ["lib/ops/alert-email.ts | console.error | ops_alert_email_send_failed", 1, "value"],
  ["lib/ops/alert-email.ts | console.error | ops_alert_email_threw", 1, "value"],
  ["lib/portal/magic-link.ts | console.error | portal_magic_link_email_failed", 1, "value"],
  ["lib/portal/magic-link.ts | safeLog.info | portal_magic_link_sent", 1, "value"],
  ["lib/rate-limit/public.ts | logBackendUnavailable() | {args}", 1, "value"],
  ["lib/rate-limit/public.ts | logRateLimitExceeded() | public_book", 2, "value"],
  ["lib/rate-limit/public.ts | logRateLimitExceeded() | {args}", 1, "value"],
  ["lib/rate-limit/public.ts | logRateLimitExceeded() | ip", 1, "value"],
  ["lib/rate-limit/public.ts | logRateLimitExceeded() | email", 1, "value"],
  ["lib/rate-limit/public.ts | logRateLimitExceeded() | new_client_waitlist", 2, "value"],
  ["lib/rate-limit/public.ts | logRateLimitExceeded() | portal_login", 2, "value"],
  ["lib/rate-limit/public.ts | logRateLimitExceeded() | waitlist_proof", 2, "value"],
  ["lib/sms/delivery-ledger.ts | logLedger() | sms_ledger_begin_failed", 2, "value"],
  ["lib/sms/delivery-ledger.ts | logLedger() | sms_ledger_settle_failed", 3, "value"],
  ["lib/sms/delivery-ledger.ts | logLedger() | sms_ledger_settle_refused", 1, "db_result"],
  ["lib/sms/send-appointment.ts | safeLog.info | sms_sent", 2, "value"],
  ["lib/waitlist/delivery/join-ack-sms.ts | log() | not_claimed", 1, "db_result"],
  ["lib/waitlist/delivery/join-ack-sms.ts | log() | {outcome}", 1, "closed"],
  ["lib/waitlist/delivery/sms.ts | log() | not_claimed", 1, "db_result"],
  ["lib/waitlist/delivery/sms.ts | log() | {outcome}", 1, "closed"],
  ["lib/waitlist/operator-queue-presence.ts | console.error | waitlist_nav_presence_failed", 1, "value"],
];

// The only error-like values still on the line, per file: the `.error` of an
// EMAIL or SMS send result. By type it is a closed tag (EmailSendFailure in
// lib/email/send-appointment.ts; the twilio_* tags of sendSmsSafely), not a
// caught error, so #1138 rightly leaves it. The analyzer reads any `.error`
// property as error-like, so the sites are pinned: a new one fails here until a
// reviewer has seen that it is a send result and not a database error.
const ERROR_TEXT_SITES: Record<string, string[]> = {
  "app/(app)/clients/[id]/intake/actions.ts": ["result.error", "result.error"],
  "app/(app)/clients/[id]/portal-messages-actions.ts": ["sendResult.error"],
  "app/portal/login/actions.ts": ["sendResult.error"],
  "app/portal/portal-message-actions.ts": ["sendResult.error"],
  "lib/waitlist/delivery/join-ack-sms.ts": ["result.error"],
  "lib/waitlist/delivery/sms.ts": ["result.error"],
};

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

  it("a writer with any unproven part is listed in UNPROVEN, and only those are", () => {
    const actual = new Map<string, number>();
    for (const w of writers) if (w.unproven.length > 0) actual.set(keyOf(w), (actual.get(keyOf(w)) ?? 0) + 1);
    const pinned = new Map(UNPROVEN.map(([key, count]) => [key, count]));
    const drift: string[] = [];
    for (const key of new Set([...actual.keys(), ...pinned.keys()])) {
      if (actual.get(key) !== pinned.get(key)) {
        const sites = writers.filter((w) => keyOf(w) === key).map((w) => `${where(w)}  [${w.unproven.join(", ")}]`);
        drift.push(`${key}: pinned ${pinned.get(key) ?? 0}, found ${actual.get(key) ?? 0}\n    ${sites.join("\n    ")}`);
      }
    }
    expect(drift, `unproven writers not in UNPROVEN (or a listed row is gone):\n${drift.join("\n")}`).toEqual([]);
  });

  it("every writer with raw error text is an UNPROVEN row", () => {
    const missing = writers.filter((w) => w.errorText.length > 0 && w.unproven.length === 0).map(where);
    expect(missing).toEqual([]);
  });

  it("ERROR_TEXT_SITES is exactly the error-like values still written, and every one is a send result's closed tag", () => {
    const actual: Record<string, string[]> = {};
    for (const w of writers) for (const e of w.errorText) (actual[w.file] ??= []).push(e);
    expect(Object.fromEntries(Object.entries(actual).map(([f, es]) => [f, es.sort()]))).toEqual(ERROR_TEXT_SITES);
    // Not a database error and not a caught value: only `<send result>.error`.
    for (const es of Object.values(actual)) for (const e of es) expect(e, e).toMatch(/^(result|sendResult)\.error$/);
  });

  it("no writer writes a database error, a caught value or a message whole (the #1138 classifiers are the only way in)", () => {
    const raw = writers.flatMap((w) =>
      w.errorText.filter((e) => !/^(result|sendResult)\.error$/.test(e)).map((e) => `${e} in ${where(w)}`),
    );
    expect(raw).toEqual([]);
  });

  it("UNPROVEN has no duplicate rows", () => {
    const keys = UNPROVEN.map(([key]) => key);
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

  it("every forwarding helper is file-local, so its callers are followed, or is listed in UNFOLLOWABLE", () => {
    const found = [...census].flatMap(([file, c]) => c.unfollowable.map((u) => `${file}: ${u}`)).sort();
    expect(found).toEqual(Object.keys(UNFOLLOWABLE).sort());
  });
});

describe("MSG-007 log census: the default-deny allowlist is pinned", () => {
  it("ALLOWED_SHAPES is exactly this list: adding a shape is a deliberate change", () => {
    expect(Object.keys(ALLOWED_SHAPES)).toEqual([
      "string-literal",
      "number-literal",
      "boolean-literal",
      "nullish",
      "template",
      "object-literal",
      "array-literal",
      "conditional",
      "pass-operator",
      "right-operator",
      "scalar-operator",
      "date",
      "stringify",
      "const-resolved",
      "closed-type",
      "verified-function",
      "array-length",
    ]);
  });

  it("VERIFIED_FUNCTIONS is exactly this list", () => {
    expect(Object.keys(VERIFIED_FUNCTIONS).sort()).toEqual([
      "Math.min", "boundedErrorLabel", "boundedErrorName", "currentEnvironment", "dbErrorCode", "eligibilitySkip",
      "emailAttemptForLog", "emailTypeForLog", "environmentLabel", "errorCodeOf", "failureCode", "hashFingerprint",
      "hashId", "invitationEmailFailure", "missingSuccessFields", "normalizeTwilioMessageStatus", "retryAfterSeconds",
      "safeDbCode", "smsAttemptForLog", "smsFailureForLog", "smsTypeForLog", "stripeErrorFields", "thrownErrorClass",
    ]);
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

  // --- DEFAULT-DENY (Codex P2 4368062287, 4368117155) ---

  it("a local property read is resolved to its initializer, or is unproven (Codex P2 4368117155)", () => {
    const { writers: ws } = analyze(`
      export function z(input: { reason: string }) {
        const diagnostic = { reason: "https://leak.example.test/manage/abcdef123456" };
        const fixed = { stage: "claim" };
        console.error(JSON.stringify({ event: "a", reason: diagnostic.reason }));
        console.error(JSON.stringify({ event: "b", stage: fixed.stage }));
        console.error(JSON.stringify({ event: "c", reason: input.reason }));
      }`);
    // Resolved: the URL it holds is read as written and the literal rule catches it.
    expect(ws[0].literals.map(literalViolation).filter(Boolean)).toEqual(["a link"]);
    expect(ws[1].unproven).toEqual([]);
    expect(ws[2].unproven).toEqual(["property input.reason"]);
  });

  it("a constructor other than Date is unproven, and its arguments are read", () => {
    const { writers: ws } = analyze(`
      export function q() {
        console.error(JSON.stringify({ event: "a", context: new URL("https://leak.example.test/manage/abcdef123456") }));
        console.error(JSON.stringify({ event: "b", at: new Date(), ts: new Date().toISOString() }));
        console.error(JSON.stringify({ event: "c", failure: new Error("boom") }));
      }`);
    expect(ws[0].unproven).toEqual(["new URL"]);
    expect(ws[0].literals.map(literalViolation).filter(Boolean)).toEqual(["a link"]);
    expect(ws[1].unproven).toEqual([]);
    expect(ws[2].unproven).toEqual(["new Error"]);
    expect(ws[2].errorText).toEqual(["new Error"]);
  });

  it("a call's result is unproven unless its function is verified", () => {
    const { writers: ws } = analyze(`
      import { currentEnvironment } from "@/lib/rate-limit/public";
      export function r(a: string) {
        console.error(JSON.stringify({ event: "a", line: buildLine(a) }));
        console.error(JSON.stringify({ event: "b", environment: currentEnvironment() }));
      }`);
    expect(ws[0].unproven).toEqual(["call buildLine()"]);
    expect(ws[1].unproven).toEqual([]);
  });

  it("a ForLog-shaped name is not trusted unless verified", () => {
    const { writers: ws } = analyze(`
      export function s(err: Error) { console.error(JSON.stringify({ event: "a", f: madeUpForLog(err.message) })); }`);
    // Its input may be embedded in what it returns, and its result is not known.
    expect(ws[0].errorText).toEqual(["err.message"]);
    expect(ws[0].unproven).toEqual(["call madeUpForLog()"]);
  });

  it("any identifier not resolved to an allowed shape is unproven, whatever its name", () => {
    const { writers: ws } = analyze(`
      export async function t(db: any, smsType: "confirmation" | "reminder_24h", studioId: string) {
        let detail = await db.read();
        const { outcome } = await db.rpc("y");
        const code = "fixed_code";
        console.error(JSON.stringify({ event: "a", detail, outcome, studioId, smsType, code }));
      }`);
    expect(ws[0].unproven).toEqual(["let detail", "binding outcome", "param studioId"]);
  });

  it("a caught value is error text whatever it is called", () => {
    const { writers: ws } = analyze(`
      export async function u(f: () => Promise<void>) { try { await f(); } catch (problem) { console.error(String(problem)); } }`);
    expect(ws[0].errorText).toEqual(["problem"]);
    expect(ws[0].unproven).toEqual(["caught problem"]);
  });

  it("a #1138 classifier makes a caught value clean, and its own name is not read as a destination (a bare one still is not)", () => {
    const { writers: ws } = analyzeSource("app/(app)/settings/team/actions.ts", `
      import { dbErrorCode, thrownErrorClass } from "@/lib/logging/error-class";
      function invitationEmailFailure(kind: string, e: unknown): string { return kind + String(e); }
      export async function c(f: () => Promise<void>, rpcErr: unknown) {
        try { await f(); } catch (problem) {
          console.error(JSON.stringify({ event: "x", code: dbErrorCode(rpcErr), cls: thrownErrorClass(problem) }));
          console.error(invitationEmailFailure("transport_threw", problem));
          console.error(JSON.stringify({ event: "y", raw: problem }));
        }
      }`);
    expect(ws).toHaveLength(3);
    for (const w of ws.slice(0, 2)) {
      expect(w.errorText, where(w)).toEqual([]);
      expect(w.unproven, where(w)).toEqual([]);
      expect(sensitive(w), where(w)).toEqual([]);
    }
    expect(ws[2].errorText).toEqual(["problem"]);
  });

  it("a sanitizer's pass-through argument is judged: a fallback that is a link, or not provable, is caught (Codex P2 4370118061)", () => {
    const decl = `
      import { failureCode, dbErrorCode, boundedErrorLabel } from "@/lib/logging/error-class";
      function invitationEmailFailure(kind: string, e: unknown): string { return kind + String(e); }`;
    const { writers: ws } = analyzeSource("app/(app)/settings/team/actions.ts", `${decl}
      export function p(err: unknown, res: unknown, fb: string) {
        console.error(JSON.stringify({ a: failureCode(err, res) }));
        console.error(JSON.stringify({ a: failureCode(err, res, "settle_unpersisted") }));
        console.error(JSON.stringify({ a: failureCode(err, res, "https://example.test/manage/abcdef123") }));
        console.error(JSON.stringify({ a: failureCode(err, res, fb) }));
        console.error(JSON.stringify({ a: dbErrorCode(err, ["https://example.test/x"]) }));
        console.error(JSON.stringify({ a: boundedErrorLabel(err, "https://example.test/y") }));
        console.error(JSON.stringify({ a: invitationEmailFailure("https://example.test/z", err) }));
      }`);
    expect(ws).toHaveLength(7);
    const link = (w: Writer) => w.literals.map(literalViolation).filter(Boolean);
    expect(link(ws[0]).concat(link(ws[1]))).toEqual([]);
    expect(ws[0].unproven.concat(ws[1].unproven)).toEqual([]);
    for (const i of [2, 4, 5, 6]) expect(link(ws[i]), `writer ${i}`).toEqual(["a link"]);
    expect(ws[3].unproven).toEqual(["param fb"]);
  });

  it("only JSON.stringify and the built-in String are stringify; any other method of that name is an ordinary call (Codex P2 4370118063)", () => {
    const { writers: ws } = analyze(`
      export function s(diagnostic: { stringify(): string }, v: unknown) {
        console.error(JSON.stringify({ a: "ok" }));
        console.error(String("ok"));
        console.error(diagnostic.stringify());
        console.error(JSON.stringify({ a: diagnostic.stringify() }));
        console.error(util.String(v));
      }`);
    expect(ws).toHaveLength(5);
    expect(ws[0].unproven).toEqual([]);
    expect(ws[1].unproven).toEqual([]);
    expect(ws[2].unproven).toEqual(["call diagnostic.stringify()"]);
    expect(ws[3].unproven).toEqual(["call diagnostic.stringify()"]);
    expect(ws[4].unproven).toEqual(["call util.String()"]);
  });

  it("logical assignment yields the left OR the right, so both are judged (Codex P2 4370163184)", () => {
    const { writers: ws } = analyze(`
      export function la(maybe: string | undefined) {
        let held = "https://example.test/manage/abcdef123";
        console.error(JSON.stringify({ a: (held ??= "unknown") }));
        console.error(JSON.stringify({ b: (held ||= "unknown") }));
        console.error(JSON.stringify({ c: (held &&= "unknown") }));
        console.error(JSON.stringify({ d: (maybe ??= "fixed") }));
        console.error(JSON.stringify({ e: (held = "fixed") }));
      }`);
    expect(ws).toHaveLength(5);
    // `held` is a let: its value is not shown, so each of the first three is unproven.
    for (const i of [0, 1, 2]) expect(ws[i].unproven, `writer ${i}`).toEqual(["let held"]);
    expect(ws[3].unproven).toEqual(["param maybe"]);
    expect(ws[4].unproven).toEqual([]);
    const lit = analyze(`export function lb(u: string) { console.error(JSON.stringify({ a: (u ??= "https://example.test/x") })); }`).writers[0];
    expect(lit.literals.map(literalViolation)).toEqual(["a link"]);
    expect(lit.unproven).toEqual(["param u"]);
  });

  it("a verified name must resolve to the verified declaration: a same-named local, a shadow or a foreign import stays unproven (Codex P2 4370163186)", () => {
    const cases: Array<[label: string, file: string, source: string, unproven: string[]]> = [
      ["the genuine import", "lib/email/x.ts",
        `import { currentEnvironment } from "@/lib/rate-limit/public";
         export function f() { console.error(currentEnvironment()); }`, []],
      ["a relative import of the same module", "lib/rate-limit/x.ts",
        `import { currentEnvironment } from "./public";
         export function f() { console.error(currentEnvironment()); }`, []],
      ["a same-named local in another file", "lib/email/x.ts",
        `function currentEnvironment() { return "https://example.test/manage/abcdef123"; }
         export function f() { console.error(currentEnvironment()); }`, ["call currentEnvironment()"]],
      ["a same-named nested function in the right file", "lib/rate-limit/public.ts",
        `export function currentEnvironment() { return "x"; }
         export function f() { function currentEnvironment() { return "https://example.test/y"; } console.error(currentEnvironment()); }`, ["call currentEnvironment()"]],
      ["the right file, top level", "lib/rate-limit/public.ts",
        `export function currentEnvironment() { return "x"; }
         export function f() { console.error(currentEnvironment()); }`, []],
      ["a shadowing parameter", "lib/rate-limit/public.ts",
        `export function currentEnvironment() { return "x"; }
         export function f(currentEnvironment: () => string) { console.error(currentEnvironment()); }`, ["call currentEnvironment()"]],
      ["an import from another module", "lib/email/x.ts",
        `import { currentEnvironment } from "@/lib/elsewhere";
         export function f() { console.error(currentEnvironment()); }`, ["call currentEnvironment()"]],
      ["an aliased import of another function", "lib/email/x.ts",
        `import { somethingElse as currentEnvironment } from "@/lib/rate-limit/public";
         export function f() { console.error(currentEnvironment()); }`, ["call currentEnvironment()"]],
      ["a namespace member", "lib/email/x.ts",
        `import * as rl from "@/lib/rate-limit/public";
         export function f() { console.error(rl.currentEnvironment()); }`, ["call rl.currentEnvironment()"]],
      ["Math.min, the builtin", "lib/email/x.ts",
        `export function f(a: number, b: number) { console.error(Math.min(a, b)); }`, []],
      ["a shadowed Math", "lib/email/x.ts",
        `const Math = { min: () => "https://example.test/z" };
         export function f(a: number) { console.error(Math.min(a)); }`, ["call Math.min()"]],
    ];
    for (const [label, file, source, unproven] of cases) {
      const w = analyzeSource(file, source).writers;
      expect(w, label).toHaveLength(1);
      expect(w[0].unproven, label).toEqual(unproven);
    }
  });

  it("the builtins JSON.stringify and String must be the globals", () => {
    const { writers: ws } = analyze(`
      const String = (v: unknown) => "https://example.test/manage/abcdef123" + v;
      export function g(v: unknown) { console.error(String(v)); }`);
    expect(ws[0].unproven).toEqual(["call String()"]);
  });

  it("SWEEP: every expression kind that can carry a value is judged on every operand it can return", () => {
    const hot = "https://example.test/manage/abcdef123";
    const src = (expr: string) =>
      analyze(`export async function w(c: boolean, p: string, o: { a?: string }, list: string[], f: () => Promise<string>) {
        let held = "x";
        console.error(${expr});
      }`).writers[0];
    const cases: Array<[kind: string, expr: string, sees: "link" | "unproven"]> = [
      ["conditional, true arm", `c ? "${hot}" : "ok"`, "link"],
      ["conditional, false arm", `c ? "ok" : "${hot}"`, "link"],
      ["nullish, left", `"${hot}" ?? "ok"`, "link"],
      ["nullish, right", `p ?? "${hot}"`, "link"],
      ["or / and", `(p || "${hot}") && "ok"`, "link"],
      ["comma", `(p, "${hot}")`, "link"],
      ["comma left is discarded, right is judged", `("${hot}", p)`, "unproven"],
      ["template", `\`id=\${p} ${hot}\``, "link"],
      ["template span", `\`id=\${"${hot}"}\``, "link"],
      ["object spread", `JSON.stringify({ ...{ a: "${hot}" } })`, "link"],
      ["object spread of an unproven value", `JSON.stringify({ ...o })`, "unproven"],
      ["array element", `JSON.stringify(["${hot}"])`, "link"],
      ["array spread", `JSON.stringify([...list])`, "unproven"],
      ["await", `await "${hot}"`, "link"],
      ["await of a call", `await f()`, "unproven"],
      ["optional chain", `o?.a`, "unproven"],
      ["optional call", `f?.()`, "unproven"],
      ["optional element", `o?.["a"]`, "unproven"],
      ["as / non-null", `(p as string)!`, "unproven"],
      ["satisfies", `("${hot}" satisfies string)`, "link"],
      ["plus", `p + "${hot}"`, "link"],
      ["tagged template", `tag\`\${p}\``, "unproven"],
      ["postfix increment", `held++`, "unproven"],
      ["a quoted key", `JSON.stringify({ "${hot}": 1 })`, "link"],
      ["a phone number as a number", `JSON.stringify({ a: 15550100123 })`, "link"],
    ];
    for (const [kind, expr, sees] of cases) {
      const w = src(expr);
      const links = w.literals.map(literalViolation).filter(Boolean);
      if (sees === "link") expect(links.length, kind).toBeGreaterThan(0);
      else expect(w.unproven.length, kind).toBeGreaterThan(0);
    }
  });

  it("a const object is its initializer only while nothing writes to it or hands it on", () => {
    const run = (body: string) =>
      analyze(`export function k() {
        const cfg = { reason: "fixed" };
        ${body}
        console.error(JSON.stringify({ a: cfg.reason }));
      }`).writers[0];
    expect(run("").unproven).toEqual([]);
    expect(run(`cfg.reason = "https://example.test/x";`).unproven.length).toBeGreaterThan(0);
    expect(run(`Object.assign(cfg, JSON.parse("{}"));`).unproven.length).toBeGreaterThan(0);
    expect(run(`const alias = cfg; alias.reason = "https://example.test/x";`).unproven.length).toBeGreaterThan(0);
    expect(run(`delete cfg.reason;`).unproven.length).toBeGreaterThan(0);
  });

  it("an element access, a computed key and a spread of an unproven value are unproven", () => {
    const { writers: ws } = analyze(`
      export function k2(rows: string[], key: string, extra: object) {
        console.error(JSON.stringify({ event: "a", first: rows[0], [key]: 1, ...extra }));
      }`);
    expect(ws[0].unproven).toEqual(["element rows[0]", "object member [key]: 1", "param extra"]);
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

  it("a digest or a closed log vocabulary is not its input", () => {
    const { writers: ws } = analyze(`
      import { hashFingerprint } from "@/lib/portal/tokens";
      import { smsFailureForLog } from "@/lib/sms/send-appointment";
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
