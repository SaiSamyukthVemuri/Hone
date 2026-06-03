"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyCancellationToken } from "@/lib/booking/tokens";
import { sendCancellationEmail } from "@/lib/email/send-appointment";
import { limitTokenRoute, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";

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

// Resolves a cancel/reschedule URL token to an appointment id. New emails
// use the column-based token in appointments.cancellation_token; older
// in-flight emails use the HMAC token from generateCancellationToken().
// Try the column path first, fall back to HMAC verification.
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
    .eq("cancellation_token", token)
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
  const reason = strOrNull(formData.get("reason"));
  if (!token) {
    return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
  }

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

  // P0-3: route the actual status mutation through the SECURITY DEFINER
  // RPC public_cancel_appointment_with_token. The RPC is terminal-safe
  // (rejects any non-confirmed source state), locks the row FOR UPDATE,
  // and writes the audit row in the same transaction.
  //
  // The RPC accepts only the column-based token. If the caller arrived
  // with an HMAC fallback token, we re-look up the appointment to load
  // its persisted cancellation_token and pass THAT into the RPC. We do
  // not relax the RPC's token requirement to keep its surface narrow.
  let rpcToken = resolved.column_token;
  if (!rpcToken) {
    const { data: row } = await admin
      .from("appointments")
      .select("cancellation_token")
      .eq("id", resolved.appointment_id)
      .maybeSingle();
    if (!row?.cancellation_token) {
      return { ok: false, error: PUBLIC_CANCEL_GENERIC_ERROR };
    }
    rpcToken = row.cancellation_token;
  }

  const { data: rpcRows, error: rpcErr } = await admin.rpc(
    "public_cancel_appointment_with_token",
    { p_token: rpcToken, p_reason: reason },
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
  const { data: apptRaw } = await admin
    .from("appointments")
    .select("studio_id, starts_at, service:services(name), studio:studios(*)")
    .eq("id", resolved.appointment_id)
    .maybeSingle();
  type CancelAppt = {
    studio_id: string;
    starts_at: string;
    service: { name: string } | { name: string }[] | null;
    studio: import("@/lib/types/database").Studio | import("@/lib/types/database").Studio[] | null;
  };
  const apptRow = apptRaw as CancelAppt | null;
  if (apptRow) {
    const pickOne = <T,>(v: T | T[] | null): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : v;
    const apptStudio = pickOne(apptRow.studio);
    const apptService = pickOne(apptRow.service);
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
          studio: apptStudio,
          serviceName: apptService?.name ?? "Appointment",
          startsAt: new Date(apptRow.starts_at),
          cancelledBy: "client",
          reason,
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
