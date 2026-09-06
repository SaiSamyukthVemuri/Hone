import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// COMMS-01B2 — which number a studio's message leaves from
// ---------------------------------------------------------------------------
//
// Before this module, every studio-scoped SMS left from ONE deployment-global
// sender: `sendSmsSafely` read TWILIO_MESSAGING_SERVICE_SID (or
// TWILIO_FROM_NUMBER) out of `process.env` and no caller could influence it.
// With one pilot studio that was merely imprecise. With a second studio it is
// wrong in a way the recipient can see: their appointment reminder arrives from
// a number belonging to a clinic they have never contacted, and replying STOP
// to it opts them out of the wrong conversation.
//
// COMMS-01B (migration 0191) records what each studio actually owns. This
// module is the one place that turns a studio id into the sender its messages
// must use.
//
// FAIL CLOSED, AND SAY WHICH FAILURE. A studio with no ACTIVE sender does not
// silently fall back to Hone's global number — that is precisely the
// cross-studio identity leak per-studio senders exist to prevent, and it is
// invisible when it happens: nothing errors, the wrong number simply appears on
// someone's phone.
//
// The two failures are kept apart on purpose. "No ACTIVE sender" is a
// configuration fact and cannot be fixed by retrying. "I could not read the
// table" is a statement about the DATABASE and says nothing about whether a
// sender exists. Collapsing them would send an operator to go provision a
// number when the real fault is a failed read — the same unknown-versus-absent
// defect already corrected once in the reminder heartbeat.
//
// WHY AN RPC AND NOT A SELECT. An earlier revision of this file read the table
// directly. It could never have worked: 0191 revokes ALL on
// public.studio_sms_senders from public, anon, authenticated AND service_role,
// and re-grants only a column-level select to `authenticated` that deliberately
// omits messaging_service_sid. The dispatcher runs as service_role, which holds
// no table privilege at all, so the read would have failed at the privilege
// layer -- and, worse, failed in a way this module would have reported as
// `read_failed`, i.e. as a transient fault to retry forever.
//
// 0192 adds the one capability that was missing rather than the grant that
// would have dissolved the boundary: a SECURITY DEFINER lookup that answers
// which messaging service this studio sends from, and returns nothing else.
// service_role still cannot read the table.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not consult the browser, it does
// not accept a caller-supplied SID, and it does not touch provisioning. The
// only input is a server-resolved studio id.

/** The single column outbound sending needs off an ACTIVE sender row. */
export type ResolvedStudioSender = { messagingServiceSid: string };

export type StudioSenderResolution =
  | { ok: true; sender: ResolvedStudioSender }
  // The lookup answered and this studio has no ACTIVE sender. Real evidence
  // about the studio; retrying cannot change it.
  | { ok: false; reason: "none_active" }
  // The lookup could not be performed. Evidence about the database, and none
  // about the studio. Retryable.
  | { ok: false; reason: "read_failed" }
  // The lookup returned more than one ACTIVE sender, which 0191's
  // one-live-per-studio index should make impossible. Refuse rather than pick:
  // sending from an arbitrarily chosen number is worse than not sending.
  | { ok: false; reason: "ambiguous" };

/**
 * Resolve the sender a studio's outbound SMS must leave from.
 *
 * Reads only `status = 'active'`, which migration 0191 makes a PROOF rather
 * than a setting: `studio_sms_senders_active_readiness_check` holds that a row
 * cannot be `active` without `phone_number`, `phone_number_sid`,
 * `messaging_service_sid`, `provisioned_at` AND `last_test_ok_at`. So an active
 * row always carries a provider-tested messaging service, and this function
 * needs no defensive completeness check of its own.
 *
 * At most one such row can exist per studio:
 * `studio_sms_senders_one_live_per_studio` is UNIQUE (studio_id) WHERE
 * status <> 'released'. The `maybeSingle()` below therefore cannot be a
 * pick-first over rivals — if it ever sees more than one row it errors, and an
 * error is reported as `read_failed` rather than resolved arbitrarily.
 */
export async function resolveActiveStudioSender(
  admin: SupabaseClient,
  studioId: string,
): Promise<StudioSenderResolution> {
  if (!studioId) return { ok: false, reason: "none_active" };
  try {
    const { data, error } = await admin.rpc("resolve_active_studio_sms_sender", {
      p_studio_id: studioId,
    });
    // A driver or privilege error is a failure to OBSERVE, never a finding
    // about the studio. Reporting it as "no sender" would send an operator to
    // provision a number they already have.
    if (error) return { ok: false, reason: "read_failed" };

    // The function returns a SET. Zero rows is genuine absence; more than one
    // means 0191's one-live-per-studio invariant has been violated, and this
    // module refuses to manufacture a winner from row order.
    const rows = Array.isArray(data)
      ? (data as Array<{ messaging_service_sid?: string | null }>)
      : [];
    if (rows.length === 0) return { ok: false, reason: "none_active" };
    if (rows.length > 1) return { ok: false, reason: "ambiguous" };

    const sid = rows[0]?.messaging_service_sid;
    // An active row cannot lack its SID -- 0191's readiness CHECK makes that
    // unreachable -- so this is a shape guard, not an expected branch. It is
    // still refused rather than passed to the provider as an empty sender.
    if (typeof sid !== "string" || sid.length === 0) {
      return { ok: false, reason: "ambiguous" };
    }
    return { ok: true, sender: { messagingServiceSid: sid } };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}

/**
 * The stable outcome tags the send path reports for each resolution failure.
 * Exported so the send path and its tests share one vocabulary rather than
 * restating strings.
 */
export const SENDER_NOT_ACTIVE_ERROR = "sms_sender_not_active_for_studio";
export const SENDER_READ_FAILED_ERROR = "sms_sender_read_failed";
/** A violated one-live-per-studio invariant. Fail closed, never pick a row. */
export const SENDER_AMBIGUOUS_ERROR = "sms_sender_ambiguous";

// ---------------------------------------------------------------------------
// The operator signal for a routing failure — durable, and not one per cron pass
// ---------------------------------------------------------------------------
//
// TWO PROBLEMS THIS CLOSES, both consequences of routing failing BEFORE the
// claim (which is itself correct — a missing sender must not burn one of the
// row's three send attempts).
//
// 1. DURABILITY. The general SMS failure logger persists its ops alert from an
//    unawaited async IIFE. For a transient provider error that is fine: the row
//    will be retried and re-logged. For a TERMINAL routing failure it is not —
//    a serverless invocation can return, and be frozen or torn down, before the
//    insert lands, so the one signal an operator gets is the one most likely to
//    be lost. The terminal path therefore AWAITS the persistence attempt.
//
// 2. REPETITION. Because no attempt is consumed, the appointment stays eligible
//    and the every-15-minute reminder cron re-selects it forever. Un-deduped,
//    one unprovisioned studio produces ~96 identical unresolved alerts a day and
//    the ops list becomes unreadable — which is the same as having no alert.
//
//    The fix is NOT to consume a fake send attempt to quiet it: that would be a
//    false statement about the provider, and it would permanently strand the
//    appointment after three passes even once the sender went live.
//
// DEDUPE SCOPE IS THE ACTIONABLE CONDITION, WHICH IS THE STUDIO, NOT THE
// APPOINTMENT. An operator fixes "this studio has no active sender" once; being
// told about it per appointment is noise, not information. So one unresolved
// alert per (studio, reason).
//
// It reuses the repository's existing mechanism rather than inventing one: an
// unresolved `ops_alerts` row for the same event suppresses a new insert, the
// same shape recordReminderSchedulerHealthAlert uses. Resolution therefore
// re-arms it — a recurrence after an operator resolves the row creates a new
// alert, so nothing is suppressed forever.
//
// FAIL-OPEN, ALWAYS. Alerting is not the business transaction. If the alert
// read or insert fails, the send still returns its ordinary routing failure and
// booking/reschedule are untouched. An operator notification must never be able
// to take down a booking.

// EVERY routing failure is actionable, including the retryable one.
//
// An earlier revision alerted only on the two TERMINAL reasons and left
// `read_failed` log-only, reasoning that a transient read alerting every fifteen
// minutes would be spam. That reasoning was obsolete the moment the (studio,
// reason) dedupe below existed: a sustained read failure now produces ONE
// unresolved alert, not ~96 a day. The mitigation had outlived its own
// justification.
//
// And the gap it left was the worst-shaped one available. A missing 0192 RPC or
// a privilege regression makes EVERY lookup fail, so every send returns
// read_failed — no claim, no Twilio call, no attempted/failed movement, and
// under the old rule no durable row either. SMS would stop completely for every
// studio while the only trace was a stderr line. Silent and total is precisely
// the combination an operator signal exists to prevent.
//
// RETRYABLE IS NOT THE SAME AS UNIMPORTANT. `read_failed` keeps every one of its
// runtime semantics — retryable, pre-provider, zero attempts consumed, no
// provider contact, excluded from provider metrics. Only its VISIBILITY changes.
type ActionableRoutingReason = "none_active" | "ambiguous" | "read_failed";

const ROUTING_ALERT_EVENT: Record<ActionableRoutingReason, string> = {
  none_active: SENDER_NOT_ACTIVE_ERROR,
  ambiguous: SENDER_AMBIGUOUS_ERROR,
  // Its own event, so a broken lookup is never deduped away by an open
  // no-sender alert for the same studio — they need different operator actions.
  read_failed: SENDER_READ_FAILED_ERROR,
};

export type RoutingAlertOutcome =
  | { alerted: true }
  | { alerted: false; reason: "deduped" | "alert_failed" };

export async function recordRoutingFailureAlert(
  admin: SupabaseClient,
  input: {
    studioId: string | null;
    appointmentId: string;
    reason: "none_active" | "ambiguous" | "read_failed";
    smsType: string;
  },
): Promise<RoutingAlertOutcome> {
  // The synchronous operator line, plus a durable deduped alert, for EVERY
  // routing failure. `terminal` still distinguishes the two classes in the log,
  // because it drives whether a retry can help — it no longer decides whether
  // anyone is told.
  console.error(
    JSON.stringify({
      event: "sms_routing_failed",
      appointmentId: input.appointmentId,
      studioId: input.studioId,
      smsType: input.smsType,
      reason: input.reason,
      terminal: input.reason !== "read_failed",
      timestamp: new Date().toISOString(),
    }),
  );
  const event = ROUTING_ALERT_EVENT[input.reason];
  try {
    // Dedupe on the ACTIONABLE CONDITION: one unresolved alert per studio per
    // reason. A null studio cannot be scoped, so it is never deduped away.
    if (input.studioId) {
      const { data: open, error: readErr } = await admin
        .from("ops_alerts")
        .select("id")
        .eq("event", event)
        .eq("studio_id", input.studioId)
        .is("resolved_at", null)
        .limit(1);
      // A failed read must not silently suppress the alert. Falling through and
      // recording a possible duplicate is strictly better than dropping the only
      // notice that a studio cannot send.
      if (!readErr && (open ?? []).length > 0) {
        return { alerted: false, reason: "deduped" };
      }
    }
    const { recordOpsAlert } = await import("@/lib/ops/alerts");
    await recordOpsAlert({
      severity: "warning",
      event,
      message:
        input.reason === "none_active"
          ? "This studio has no ACTIVE SMS sender, so its messages cannot be routed and are not being sent."
          : input.reason === "ambiguous"
            ? "This studio resolved MORE THAN ONE active SMS sender; sending is refused rather than choosing a number."
            : "The studio SMS sender lookup could not be performed, so messages are not being routed or sent. This is a fault in the lookup itself, not evidence about the studio's sender.",
      studioId: input.studioId,
      appointmentId: input.appointmentId,
      route: "lib/sms/sender-routing:recordRoutingFailureAlert",
      safeDetails: { reason: input.reason, sms_type: input.smsType },
    });
    return { alerted: true };
  } catch {
    // Fail-open. The caller still returns its routing failure; booking and
    // reschedule are unaffected by an alerting fault.
    return { alerted: false, reason: "alert_failed" };
  }
}
