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
// WHAT THIS DELIBERATELY DOES NOT DO. It does not consult the browser, it does
// not accept a caller-supplied SID, and it does not touch provisioning. The
// only input is a server-resolved studio id.

/** The single column outbound sending needs off an ACTIVE sender row. */
export type ResolvedStudioSender = { messagingServiceSid: string };

export type StudioSenderResolution =
  | { ok: true; sender: ResolvedStudioSender }
  // The table answered and this studio has no ACTIVE sender. Real evidence.
  | { ok: false; reason: "none_active" }
  // The table could not be read. Evidence about the store, not the studio.
  | { ok: false; reason: "read_failed" };

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
    const { data, error } = await admin
      .from("studio_sms_senders")
      .select("messaging_service_sid")
      .eq("studio_id", studioId)
      .eq("status", "active")
      .maybeSingle();
    // A driver error is a failure to observe, never a finding about the studio.
    if (error) return { ok: false, reason: "read_failed" };
    const sid = (data as { messaging_service_sid?: string | null } | null)
      ?.messaging_service_sid;
    if (typeof sid !== "string" || sid.length === 0) {
      return { ok: false, reason: "none_active" };
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
