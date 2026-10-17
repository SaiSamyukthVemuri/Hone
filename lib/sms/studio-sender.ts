import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// WAIT S3 — WHICH IDENTITY DOES A STUDIO'S SMS LEAVE FROM?
//
// Resolves the messaging service a studio's OUTBOUND SMS must send from, by
// calling migration 0194's `resolve_active_studio_sms_sender`. Thin by design,
// in the same shape as `provisioning-store.ts`: every decision about which
// sender is active belongs to 0191/0194's commands. This file translates and
// refuses; it never decides, and it never sends.
//
// ---------------------------------------------------------------------------
// WHY A COMMAND AND NOT A TABLE READ
// ---------------------------------------------------------------------------
//
// 0191 closed the table to everyone:
//
//     revoke all on public.studio_sms_senders
//       from public, anon, authenticated, service_role;
//
// `service_role` holds NO privilege on that table, so a direct select could
// never have worked — it would surface as a permanent read failure that looks
// exactly like an application bug. 0194 exists precisely to answer this one
// question through a SECURITY DEFINER function without widening the boundary,
// and it returns the ACTIVE sender's `messaging_service_sid` and nothing else:
// no claim key, no lease, no phone_number_sid, no other studio, no historical
// row.
//
// ---------------------------------------------------------------------------
// WHY THIS FAILS CLOSED, AND WHAT IT REFUSES TO FALL BACK TO
// ---------------------------------------------------------------------------
//
// `lib/sms/twilio.ts` currently picks its sender from PLATFORM-WIDE
// environment (`TWILIO_MESSAGING_SERVICE_SID`, else `TWILIO_FROM_NUMBER`), so
// every studio's message leaves from one shared identity. That is the inverse
// of the S3 product law: a studio's messages must come from the STUDIO's own
// number, never from Hone's.
//
// So the one outcome this module must never produce is a usable sender it did
// not get from the database. There is deliberately NO env fallback here, not
// even as a last resort: a caller that cannot resolve a studio's sender must
// not send at all. Sending from the wrong identity is worse than not sending —
// the recipient sees a number that is not their clinic's, replies to it, and
// STOP lands against the wrong sender.
//
// ---------------------------------------------------------------------------
// WHY AMBIGUITY IS A REFUSAL RATHER THAN A CHOICE
// ---------------------------------------------------------------------------
//
// 0194 returns a SET, not a scalar, and says why: one live row per studio is
// already guaranteed by `studio_sms_senders_one_live_per_studio`, so returning
// a set means a violated invariant "surfaces as ambiguity for the caller to
// refuse rather than as a silently chosen first row". This file is that
// caller. Two active senders is a broken invariant, and picking either one
// would send from an identity nobody chose while hiding the breakage.
//
// Zero rows is NOT an error. 0194 is explicit: no ACTIVE sender is "a
// configuration fact, never an error" — a studio that has not finished
// provisioning simply cannot send yet.

/** Why a studio has no usable sending identity. Every value is a refusal. */
export type StudioSenderRefusal =
  /** No ACTIVE sender row. A configuration fact, not a failure. */
  | "no_active_sender"
  /** More than one ACTIVE sender: a violated invariant. Never guess. */
  | "ambiguous_active_sender"
  /** The command errored, or returned a shape this file does not recognise. */
  | "read_failed";

export type StudioSenderResolution =
  | { ok: true; messagingServiceSid: string }
  | { ok: false; reason: StudioSenderRefusal };

type SenderRow = { messaging_service_sid: string | null };

/**
 * Resolve the messaging service this studio's outbound SMS must leave from.
 *
 * Returns a REFUSAL rather than throwing, because "this studio cannot send
 * yet" is an ordinary operational state that callers must handle, not an
 * exception. No caller may substitute its own sender for a refusal.
 */
export async function resolveStudioSmsSender(
  admin: SupabaseClient,
  studioId: string,
): Promise<StudioSenderResolution> {
  // A missing studio id is a caller bug, and asking the database about it would
  // turn that bug into a confident "no active sender" — which reads as a
  // configuration fact and would be acted on as one.
  if (typeof studioId !== "string" || studioId.trim().length === 0) {
    return { ok: false, reason: "read_failed" };
  }

  const { data, error } = await admin.rpc("resolve_active_studio_sms_sender", {
    p_studio_id: studioId,
  });

  if (error) return { ok: false, reason: "read_failed" };

  // A set-returning function arrives as an array. Anything else is a shape this
  // file does not understand, and an unrecognised shape must never be read as
  // "no sender" — that is the reading a caller could talk itself into sending
  // on.
  if (!Array.isArray(data)) return { ok: false, reason: "read_failed" };

  if (data.length === 0) return { ok: false, reason: "no_active_sender" };
  if (data.length > 1) return { ok: false, reason: "ambiguous_active_sender" };

  const sid = (data[0] as SenderRow | null)?.messaging_service_sid;

  // A row whose sid is null, blank, or not a string is not a sending identity.
  // Treated as a read failure rather than as "no sender": the row EXISTS and is
  // active, so the honest report is that its identity could not be read, not
  // that the studio has not provisioned one.
  if (typeof sid !== "string" || sid.trim().length === 0) {
    return { ok: false, reason: "read_failed" };
  }

  return { ok: true, messagingServiceSid: sid };
}

/**
 * True only for a resolution that may be sent on.
 *
 * Exists so a caller cannot accidentally treat a refusal as sendable by
 * checking a truthy object, which is the mistake that would reintroduce the
 * platform-wide identity this module exists to replace.
 */
export function studioSenderAllowsSend(
  resolution: StudioSenderResolution,
): resolution is { ok: true; messagingServiceSid: string } {
  return resolution.ok === true;
}
