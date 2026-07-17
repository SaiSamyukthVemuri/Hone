"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyCancellationToken } from "@/lib/booking/tokens";
import { hashAppointmentToken } from "@/lib/booking/appointment-token";
import { sendCancellationEmail } from "@/lib/email/send-appointment";
import { recordPractitionerNotification } from "@/lib/notifications/practitioner-notifications";
import { limitTokenRoute, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";
import {
  buildPolicySnapshot,
  hasAnyPolicy,
} from "@/lib/booking/policy-acknowledgement";
import {
  CANCELLATION_NOTE_MAX_LENGTH,
  getCancellationReasonLabel,
  isCancellationReasonValue,
  type CancellationReasonValue,
} from "@/lib/booking/cancellation-reasons";

const POLICY_ACK_REQUIRED_ERROR =
  "Please review and acknowledge the appointment policies before cancelling.";

// Validation messages for the new structured cancellation insight
// fields. These are surfaced to the client only when their input
// fails the server check; the disabled-submit and option-list rendering
// in CancelForm prevents the legitimate UI from sending an out-of-set
// value. The strings are deliberately neutral and never echo the bad
// input.
const NOTE_TOO_LONG_ERROR =
  "Your note is too long. Please keep it under " +
  CANCELLATION_NOTE_MAX_LENGTH +
  " characters.";
const INVALID_REASON_ERROR =
  "Please pick one of the suggested reasons or leave the field blank.";

// Generic public-facing message. Returned for any non-success outcome
// on BOTH the mutation surface (`publicCancelAppointmentAction`) AND
// the fetch surface (`fetchAppointmentForCancelAction`) so the
// existence of a real appointment row cannot be probed via
// shape-of-error comparisons or via the initial-page-load surface.
// Internal errors are logged server-side.
const PUBLIC_CANCEL_GENERIC_ERROR =
  "This cancellation link is no longer valid. Please contact the studio if you need assistance.";

function logInternal(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({
        event,
        detail,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    console.error(event, detail);
  }
}

// Resolves a cancel/reschedule URL token to an appointment id. PR #260:
// appointment tokens are hashed at rest, so we hash the incoming raw URL
// token and match appointments.cancellation_token_hash. Older in-flight
// emails carry the stateless HMAC token from generateCancellationToken();
// try the hash path first, fall back to HMAC verification. The migration
// 0090 backfill + trigger guarantee every row has a hash, so no raw-column
// lookup is needed. `column_token` carries the raw URL token (or null for
// the HMAC path) so the caller can hash it for the RPC re-verification.
async function resolveAppointmentIdFromToken(
  token: string,
): Promise<
  | { ok: true; appointment_id: string; column_token: string | null }
  | { ok: false; error: "expired" | "invalid" }
> {
  if (!token) return { ok: false, error: "invalid" };

  const admin = createAdminClient();
  const { data: byColumn } = await admin
    .from("appointments")
    .select("id")
    .eq("cancellation_token_hash", hashAppointmentToken(token))
    .maybeSingle();
  if (byColumn) {
    return { ok: true, appointment_id: byColumn.id, column_token: token };
  }

  const v = verifyCancellationToken(token);
  if (v.ok) return { ok: true, appointment_id: v.appointment_id, column_token: null };
  return { ok: false, error: v.error === "expired" ? "expired" : "invalid" };
}

// Public mutation result. The collapse rule (see callers below) means
// only a genuine new-cancellation produces `{ ok: true }`. Every other
// outcome - including `already_cancelled` - is returned as
// `{ ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR }` so the public
// surface cannot distinguish "valid token, already cancelled" from
// "unknown token".
export type PublicCancelResult =
  | { ok: true }
  | { ok: false; error: string };

export async function publicCancelAppointmentAction(
  formData: FormData,
): Promise<PublicCancelResult> {
  const token = strOrEmpty(formData.get("token"));
  // PR #144. The reason field is now a structured machine value drawn
  // from CANCELLATION_REASONS (or null/blank when the client opted to
  // cancel without picking a reason). The free-form textarea that used
  // to feed this field is gone; the optional note has moved to its
  // own field below.
  const rawReason = strOrNull(formData.get("reason"));
  const rawNote = strOrEmpty(formData.get("note"));
  const rawFollowUpAllowed = strOrEmpty(formData.get("follow_up_allowed"));
  // PR #132 / #133. The acknowledgement field is read up front but
  // the require / skip decision happens AFTER we resolve the studio
  // because requiring an acknowledgement of a non-existent policy
  // is confusing. A studio with no policy text on file can cancel
  // without the field. The server-side decision is the source of
  // truth; the page hint just keeps the UI honest.
  const acknowledged = strOrEmpty(formData.get("acknowledged_policy"));
  if (!token) {
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }

  // PR #144. Validate the structured insight fields up front so the
  // server never trusts client input for them.
  //
  //   * Reason: if present, MUST be one of CANCELLATION_REASONS.value.
  //     The label that gets snapshotted is derived server-side from
  //     this map; we never store a client-supplied label string.
  //   * Note: optional, trimmed, length-capped. Stored only on the
  //     successful cancellation branch via the audit row.
  //   * follow_up_allowed: optional boolean. The form posts the literal
  //     "true" when the checkbox is checked; anything else (missing,
  //     "false", "1", "on", "yes") collapses to false. The DB row's
  //     follow_up_allowed default is false.
  let reasonValue: CancellationReasonValue | null = null;
  let reasonLabel: string | null = null;
  if (rawReason !== null) {
    if (!isCancellationReasonValue(rawReason)) {
      return { ok: false, error: INVALID_REASON_ERROR };
    }
    reasonValue = rawReason;
    reasonLabel = getCancellationReasonLabel(rawReason);
  }
  if (rawNote.length > CANCELLATION_NOTE_MAX_LENGTH) {
    return { ok: false, error: NOTE_TOO_LONG_ERROR };
  }
  const noteValue = rawNote.length > 0 ? rawNote : null;
  const followUpAllowed = rawFollowUpAllowed === "true";

  // Rate limit before token verification, the cancel RPC, and the owner
  // email. Runs independent of token validity, so a 429 reveals nothing.
  // Fails open when Upstash is unconfigured or down. No cancel/email occurs
  // when limited.
  const gate = await limitTokenRoute({
    routeClass: "cancel_submit",
    token,
    headers: await headers(),
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  const resolved = await resolveAppointmentIdFromToken(token);
  if (!resolved.ok) {
    // Public collapse rule (Blocker 2): ALL token-resolution failures
    // — malformed / unknown / expired — return the same generic
    // message. The previous distinct "This cancellation link has
    // expired." string was itself a bearer-token validity signal
    // (an attacker who saw it learned that the token was a
    // structurally-valid HMAC token that had merely aged out).
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }

  const admin = createAdminClient();

  // PR #133. Cheap pre-RPC lookup of just the studio's policy text so
  // we can decide whether to require acknowledgement. Studios with no
  // policy text on file accept the cancel without the field and skip
  // the acknowledgement row insert below. This lookup goes against
  // the appointments + joined studios row by resolved appointment id;
  // it does not consume any token, does not mutate, and is bounded.
  // If the lookup fails we collapse to the generic public error
  // because something is structurally off with the resolved row.
  const { data: policyCheck, error: policyErr } = await admin
    .from("appointments")
    .select(
      "studio:studios(cancellation_policy_text, no_show_policy_text)",
    )
    .eq("id", resolved.appointment_id)
    .maybeSingle();
  if (policyErr) {
    logInternal("public_cancel_policy_lookup_failed", {
      code: policyErr.code,
      message: policyErr.message,
    });
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }
  type PolicyJoin = {
    studio:
      | {
          cancellation_policy_text: string | null;
          no_show_policy_text: string | null;
        }
      | Array<{
          cancellation_policy_text: string | null;
          no_show_policy_text: string | null;
        }>
      | null;
  };
  const policyRow = (policyCheck ?? null) as PolicyJoin | null;
  const policyStudio = Array.isArray(policyRow?.studio)
    ? (policyRow?.studio[0] ?? null)
    : (policyRow?.studio ?? null);
  const requiresAck = hasAnyPolicy({
    cancellationPolicyText: policyStudio?.cancellation_policy_text,
    noShowPolicyText: policyStudio?.no_show_policy_text,
  });
  if (requiresAck && acknowledged !== "true") {
    return { ok: false, error: POLICY_ACK_REQUIRED_ERROR };
  }

  // P0-3: route the actual status mutation through the SECURITY DEFINER
  // RPC public_cancel_appointment_with_token. The RPC is terminal-safe
  // (rejects any non-confirmed source state), locks the row FOR UPDATE,
  // and writes the audit row in the same transaction.
  //
  // PR #260: the RPC matches the stored hash. For the normal column
  // path we pass the hash of the raw URL token (re-verified against the
  // row's stored hash inside the RPC). For an HMAC-fallback token we
  // re-load the appointment's persisted cancellation_token_hash and pass
  // THAT, since the HMAC string itself does not hash to the stored value.
  let rpcToken = resolved.column_token
    ? hashAppointmentToken(resolved.column_token)
    : null;
  if (!rpcToken) {
    const { data: row } = await admin
      .from("appointments")
      .select("cancellation_token_hash")
      .eq("id", resolved.appointment_id)
      .maybeSingle();
    if (!row?.cancellation_token_hash) {
      return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
    }
    rpcToken = row.cancellation_token_hash;
  }

  // PR #144. Switched to the 5-arg variant of the RPC (migration
  // 0063). The new signature accepts the machine value, the label
  // snapshot, the optional note, and the follow-up flag, and writes
  // them into appointment_audit.details inside the same transaction
  // as the status flip. The 2-arg variant remains in the DB during
  // the deploy window and is no longer called from this action.
  const { data: rpcRows, error: rpcErr } = await admin.rpc(
    "public_cancel_appointment_with_token",
    {
      p_token: rpcToken,
      p_reason: reasonValue,
      p_reason_label: reasonLabel,
      p_note: noteValue,
      p_follow_up_allowed: followUpAllowed,
    },
  );
  if (rpcErr) {
    logInternal("public_cancel_rpc_error", { code: rpcErr.code, message: rpcErr.message });
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }
  const outcome = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  if (!outcome) {
    logInternal("public_cancel_rpc_empty", {});
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }
  if (outcome.result !== "cancelled") {
    // Public-facing collapse rule (Blocker 2): 'invalid_token',
    // 'not_cancelable', AND 'already_cancelled' ALL return the same
    // generic public error. The fetch surface
    // (fetchAppointmentForCancelAction below) applies the same
    // collapse: it returns the generic error for every non-future
    // non-confirmed token state, and does NOT render an "already
    // cancelled" banner.
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }

  // Notify studio owner. Read the joined view for the email body
  // separately to avoid coupling the mutation surface to the
  // notification surface. Supabase types joined relations as arrays,
  // so we normalize below.
  //
  // PR #132. client_id is added to the select so the policy
  // acknowledgement row below can be scoped to the server-resolved
  // client without trusting any client-supplied id.
  const { data: apptRaw } = await admin
    .from("appointments")
    .select(
      "studio_id, client_id, practitioner_id, starts_at, duration_minutes, service:services(name), studio:studios(*), client:clients(name)",
    )
    .eq("id", resolved.appointment_id)
    .maybeSingle();
  type CancelAppt = {
    studio_id: string;
    client_id: string;
    // PR #164. practitioner_id + client name added so the
    // practitioner notification helper can stamp the assigned
    // practitioner + render a body like "<Client name> cancelled
    // their appointment." Studio_id is the load-bearing scope; the
    // helper requires it.
    practitioner_id: string | null;
    starts_at: string;
    duration_minutes: number;
    service: { name: string } | { name: string }[] | null;
    studio: import("@/lib/types/database").Studio | import("@/lib/types/database").Studio[] | null;
    client: { name: string } | { name: string }[] | null;
  };
  const apptRow = apptRaw as CancelAppt | null;
  if (apptRow) {
    const pickOne = <T,>(v: T | T[] | null): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : v;
    const apptStudio = pickOne(apptRow.studio);
    const apptService = pickOne(apptRow.service);
    const apptClient = pickOne(apptRow.client);

    // PR #164. Fire-and-forget practitioner notification. The
    // RPC already committed the cancellation; this helper never
    // throws to the caller. Body composes the client name + the
    // optional reason label that was already validated above and
    // is studio-member-safe to display. href links to the
    // appointment detail page where the full cancellation
    // insight + audit row live.
    recordPractitionerNotification({
      studioId: apptRow.studio_id,
      practitionerId: apptRow.practitioner_id,
      eventType: "appointment_cancelled",
      title: "Appointment cancelled",
      body: reasonLabel
        ? `${apptClient?.name ?? "A client"} cancelled their appointment. Reason: ${reasonLabel}.`
        : `${apptClient?.name ?? "A client"} cancelled their appointment.`,
      appointmentId: resolved.appointment_id,
      clientId: apptRow.client_id,
      href: `/calendar/${resolved.appointment_id}`,
    });

    // PR #132. Write the policy acknowledgement row. studio_id,
    // client_id, and appointment_id are all server-resolved from the
    // token via apptRow; the snapshot text is read from the joined
    // studio row, which is the canonical source the cancel page
    // rendered to the client. policy_snapshot_hash is built by the
    // shared buildPolicySnapshot helper so the reschedule action
    // produces an identical hash format for the same inputs.
    //
    // Failure to write this row does NOT roll back the cancel: the
    // appointment is already cancelled atomically inside the RPC.
    // We log the failure server-side; the practitioner-side audit
    // continues to live in appointments.cancellation_reason + the
    // audit_logs row the RPC stamped. Re-running the action with
    // the same token is a no-op (the RPC rejects non-confirmed
    // source state), so we cannot retry the ack here.
    //
    // PR #133. Acknowledgement is only written when the studio has
    // policy text on file. A studio with no policy never produced
    // an acknowledgement on the UI side either; we mirror that
    // here so the table only carries meaningful rows.
    if (apptStudio && requiresAck) {
      const snapshot = buildPolicySnapshot({
        cancellationPolicyText: apptStudio.cancellation_policy_text,
        noShowPolicyText: apptStudio.no_show_policy_text,
      });
      const { error: ackErr } = await admin
        .from("appointment_policy_acknowledgements")
        .insert({
          studio_id: apptRow.studio_id,
          appointment_id: resolved.appointment_id,
          client_id: apptRow.client_id,
          action: "cancel",
          cancellation_policy_text_snapshot:
            snapshot.cancellationPolicyTextSnapshot,
          no_show_policy_text_snapshot:
            snapshot.noShowPolicyTextSnapshot,
          policy_snapshot_hash: snapshot.policySnapshotHash,
        });
      if (ackErr) {
        logInternal("public_cancel_policy_ack_insert_failed", {
          code: ackErr.code,
          message: ackErr.message,
          appointmentId: resolved.appointment_id,
        });
      }
    }

    const { data: owner } = await admin
      .from("practitioners")
      .select("display_name, email")
      .eq("studio_id", apptRow.studio_id)
      .eq("active", true)
      .eq("role", "owner")
      .maybeSingle();
    if (owner?.email && apptStudio) {
      try {
        await sendCancellationEmail({
          to: owner.email,
          recipientName: owner.display_name?.trim() || owner.email,
          // Actor + client are one and the same here: a public token
          // cancellation is ALWAYS performed by the appointment's own
          // client. Both names are the server-resolved client record
          // (apptClient.name) — never anything from the request body.
          clientName: apptClient?.name ?? null,
          actorName: apptClient?.name ?? null,
          actorRole: "client",
          studio: apptStudio,
          serviceName: apptService?.name ?? "Appointment",
          durationMinutes: apptRow.duration_minutes,
          startsAt: new Date(apptRow.starts_at),
          // The owner notification continues to receive the same
          // free-form reason string it always has. PR #144 sends the
          // human label (e.g. "Schedule changed") when the client
          // picked one; null when they cancelled without selecting
          // anything. The richer note + follow-up flag live in the
          // audit row and the practitioner-facing appointment detail
          // page rather than the email body.
          reason: reasonLabel,
          isClient: false,
        });
      } catch (emailErr) {
        logInternal("public_cancel_owner_email_failed", { emailErr });
      }
    }
  }

  return { ok: true };
}

// P0 (cancel-flow collapse): the fetch surface now exposes appointment
// details ONLY for a valid token that maps to a future appointment
// with status='confirmed'. Every other outcome - unknown token, empty
// token, expired token, cancelled, completed, no-show, past start,
// internal DB error - returns the same generic public payload. The
// existence of a real cancelled / completed / no-show appointment is
// not leaked to a token-probing caller via the initial page load.
//
// The summary deliberately omits any field that could identify the
// appointment, the client, or the appointment id. Only studio name,
// studio timezone, service name, and appointment start time are
// returned, and only when a cancellation is structurally possible.
export type AppointmentSummary = {
  studioName: string;
  studioTimezone: string;
  serviceName: string;
  startsAt: string;
  // Studio-authored policies surfaced on the cancel page so the
  // client sees the cancellation/no-show rules before they commit.
  // Reminder/display only; the cancel mutation does not consult
  // these fields and is not blocked when either is empty.
  cancellationPolicyText: string | null;
  noShowPolicyText: string | null;
};

export async function fetchAppointmentForCancelAction(
  token: string,
): Promise<{ ok: true; summary: AppointmentSummary } | { ok: false; error: string }> {
  // Rate limit the view fetch (looser than submit). Token never consumed.
  const gate = await limitTokenRoute({
    routeClass: "cancel_view",
    token,
    headers: await headers(),
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  const resolved = await resolveAppointmentIdFromToken(token);
  if (!resolved.ok) {
    // Public collapse rule (Blocker 2): ALL token-resolution failures
    // — malformed / unknown / expired — return the same generic
    // public message. No distinct "expired" string is exposed; an
    // attacker cannot learn that a token was a real HMAC that
    // merely aged out.
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointments")
    .select(
      "id, status, starts_at, studio:studios(name, timezone, cancellation_policy_text, no_show_policy_text), service:services(name)",
    )
    .eq("id", resolved.appointment_id)
    .maybeSingle();
  if (error) {
    logInternal("public_cancel_fetch_error", { code: error.code, message: error.message });
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }
  if (!data) return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };

  // The relation shape from Supabase types as array; pick first.
  type Joined = {
    id: string;
    status: string;
    starts_at: string;
    studio:
      | {
          name: string;
          timezone: string;
          cancellation_policy_text: string | null;
          no_show_policy_text: string | null;
        }
      | Array<{
          name: string;
          timezone: string;
          cancellation_policy_text: string | null;
          no_show_policy_text: string | null;
        }>
      | null;
    service: { name: string } | { name: string }[] | null;
  };
  const row = data as unknown as Joined;

  // Public-facing fetch collapse rule: ONLY a future confirmed
  // appointment may flow through to the success branch. Any other
  // status (cancelled / completed / no_show / unknown) and any
  // past-start time collapse to the same generic public payload.
  const startsAtMs = new Date(row.starts_at).getTime();
  const isCancellable =
    row.status === "confirmed"
    && Number.isFinite(startsAtMs)
    && startsAtMs > Date.now();
  if (!isCancellable) {
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }

  const pick = <T>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;
  const studio = pick(row.studio);
  const service = pick(row.service);

  return {
    ok: true,
    summary: {
      studioName: studio?.name ?? "studio",
      studioTimezone: studio?.timezone ?? "UTC",
      serviceName: service?.name ?? "Appointment",
      startsAt: row.starts_at,
      cancellationPolicyText: studio?.cancellation_policy_text ?? null,
      noShowPolicyText: studio?.no_show_policy_text ?? null,
    },
  };
}

function strOrEmpty(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}
function strOrNull(v: FormDataEntryValue | null): string | null {
  const s = strOrEmpty(v);
  return s.length === 0 ? null : s;
}
