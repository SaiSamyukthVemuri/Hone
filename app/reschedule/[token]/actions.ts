"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  generateAppointmentToken,
  hashAppointmentToken,
} from "@/lib/booking/appointment-token";
import { verifyCancellationToken } from "@/lib/booking/tokens";
import { limitTokenRoute, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";
import {
  filterFutureSlots,
  getAvailableSlots,
  type Slot,
} from "@/lib/booking/slots";
import { addDays, localDateString, localTimeString12h, todayInTz } from "@/lib/booking/tz";
import { recordPractitionerNotification } from "@/lib/notifications/practitioner-notifications";
import {
  horizonRangeInStudioTz,
  isWithinPublicBookingHorizon,
  maxPublicBookingHorizonDays,
} from "@/lib/booking/horizon";
import {
  logEmailFailure,
  recordEmailAttempt,
  sendBookingConfirmationToClient,
} from "@/lib/email/send-appointment";
import {
  buildPolicySnapshot,
  hasAnyPolicy,
} from "@/lib/booking/policy-acknowledgement";

const POLICY_ACK_REQUIRED_ERROR =
  "Please review and acknowledge the appointment policies before rescheduling.";
import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";
import { ensureIntakeForClient } from "@/lib/intake/queries";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";
import { getRequiredAppOrigin } from "@/lib/app-origin";

// Public reschedule collapse string. Returned for every user-facing
// outcome that depends on the appointment's existence or state —
// token didn't resolve, appointment row missing post-resolve,
// appointment data malformed, appointment in a non-reschedulable
// status (cancelled / completed / no_show), or starts_at in the
// past. ALL of these collapse to a single message so the public
// surface cannot distinguish "valid token, appointment now in X
// state" from "unknown token". Matches the page-layer copy in
// app/reschedule/[token]/page.tsx so the visitor sees the same
// generic string regardless of whether the leak path was the
// initial GET (collapsed by the page render) or a mid-flow
// fetch/submit (collapsed here). Internal infra errors and user-
// input errors (slot conflicts, invalid time format, date out of
// horizon) are NOT collapsed — they have actionable meaning and
// don't expose appointment/token state.
const PUBLIC_RESCHEDULE_GENERIC_ERROR =
  "This reschedule link can't be used right now.";

// PR #260: appointment tokens are hashed at rest. Hash the incoming raw
// URL token and match appointments.cancellation_token_hash. The reschedule
// surface now ALSO accepts the stateless HMAC fallback (cancel/manage
// already did): the portal Manage button, reminder emails, and internal
// booking confirmations can no longer read a raw column token at render
// time (new rows store only the hash), so they mint the HMAC token
// instead, and its /reschedule link must resolve. The RPC re-verifies by
// hash, so we surface the hash to pass: the hash of the raw URL token for
// the column path, or the row's stored hash for an HMAC-resolved row.
async function resolveAppointmentIdFromToken(
  token: string,
): Promise<
  | { ok: true; appointment_id: string; rpc_token_hash: string }
  | { ok: false; error: "invalid" }
> {
  if (!token) return { ok: false, error: "invalid" };
  const admin = createAdminClient();
  const tokenHash = hashAppointmentToken(token);
  const { data } = await admin
    .from("appointments")
    .select("id")
    .eq("cancellation_token_hash", tokenHash)
    .maybeSingle();
  if (data) {
    return { ok: true, appointment_id: data.id, rpc_token_hash: tokenHash };
  }
  const v = verifyCancellationToken(token);
  if (v.ok) {
    const { data: row } = await admin
      .from("appointments")
      .select("cancellation_token_hash")
      .eq("id", v.appointment_id)
      .maybeSingle();
    if (row?.cancellation_token_hash) {
      return {
        ok: true,
        appointment_id: v.appointment_id,
        rpc_token_hash: row.cancellation_token_hash,
      };
    }
  }
  return { ok: false, error: "invalid" };
}

// PR #149: sanitized server-side log helper for the reschedule
// surface. Logs structured JSON with the event + sanitized fields;
// NEVER includes the raw token, raw PII, or raw Stripe ids. The
// public action layer collapses the matching outcome to the generic
// public copy.
function logInternal(event: string, detail: Record<string, unknown>): void {
  try {
    console.error(
      JSON.stringify({
        event,
        ...detail,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    console.error(event, detail);
  }
}

// PR #149: shared "is this token usable for a public reschedule?" check.
// Every public reschedule action (fetch summary, fetch slots, find next
// available date, submit) must refuse unless the resolved original
// appointment is in BOTH:
//   * status = 'confirmed'
//   * starts_at  > now()
//
// Any other combination (cancelled / completed / no_show / past starts)
// collapses to the same generic public error so a probing caller cannot
// distinguish state. The DB RPC re-enforces the same invariants
// independently (migration 0066) for defence in depth.
type ReschedulableOriginal = {
  appointment_id: string;
  studio_id: string;
  client_id: string;
  // PR #260: the hash to pass to reschedule_appointment as
  // p_current_cancellation_token. The RPC matches by hash; this is the
  // hash of the raw URL token (column path) or the row's stored hash
  // (HMAC path), so the RPC's locked re-verification always resolves the
  // same row the resolver already authenticated.
  rpc_token_hash: string;
};
async function assertReschedulableOriginal(
  token: string,
): Promise<
  { ok: true; original: ReschedulableOriginal } | { ok: false; error: string }
> {
  const resolved = await resolveAppointmentIdFromToken(token);
  if (!resolved.ok) {
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointments")
    .select("id, studio_id, client_id, status, starts_at")
    .eq("id", resolved.appointment_id)
    .maybeSingle();
  if (error) {
    logInternal("public_reschedule_assert_lookup_failed", {
      code: error.code,
      message: error.message,
      appointmentId: resolved.appointment_id,
    });
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }
  if (!data) {
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }
  if (data.status !== "confirmed") {
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }
  if (new Date(data.starts_at).getTime() <= Date.now()) {
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }
  return {
    ok: true,
    original: {
      appointment_id: data.id,
      studio_id: data.studio_id,
      client_id: data.client_id,
      rpc_token_hash: resolved.rpc_token_hash,
    },
  };
}

export type RescheduleSummary = {
  appointmentId: string;
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  studioId: string;
  studioName: string;
  studioTimezone: string;
  // Migration 0036: per-studio public booking horizon (3, 4, or 6
  // months). The reschedule date picker uses this so it shows the same
  // window the server-side check enforces.
  studioPublicBookingHorizonMonths: number;
  startsAt: string;
  status: "confirmed" | "cancelled" | "completed" | "no_show";
  // Studio-authored policies shown on the reschedule page so the
  // client sees the cancellation/no-show rules before committing to a
  // change. Reminder/display only; the reschedule mutation does not
  // consult these fields and is not blocked when either is empty.
  cancellationPolicyText: string | null;
  noShowPolicyText: string | null;
};

export type FetchRescheduleResult =
  | { ok: true; summary: RescheduleSummary }
  | { ok: false; error: string };

export async function fetchAppointmentForRescheduleAction(
  token: string,
): Promise<FetchRescheduleResult> {
  // Rate limit the view fetch (looser than submit). Token never consumed.
  const gate = await limitTokenRoute({
    routeClass: "reschedule_view",
    token,
    headers: await headers(),
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  // PR #149: every reschedule read path must refuse non-confirmed
  // or past originals. The shared helper collapses every failure
  // (token mismatch / cancelled / completed / no_show / past) to
  // the generic public error.
  const asserted = await assertReschedulableOriginal(token);
  if (!asserted.ok) {
    return { ok: false, error: asserted.error };
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointments")
    .select(
      "id, status, starts_at, duration_minutes, service_id, service:services(id, name, default_duration_minutes), studio:studios(id, name, timezone, public_booking_horizon_months, cancellation_policy_text, no_show_policy_text)",
    )
    .eq("id", asserted.original.appointment_id)
    .maybeSingle();
  if (error) {
    // PR #149: never surface raw DB error text to the public client.
    logInternal("public_reschedule_fetch_summary_failed", {
      code: error.code,
      message: error.message,
      appointmentId: asserted.original.appointment_id,
    });
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }
  if (!data) return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };

  type Joined = {
    id: string;
    status: "confirmed" | "cancelled" | "completed" | "no_show";
    starts_at: string;
    duration_minutes: number;
    service_id: string | null;
    service:
      | { id: string; name: string; default_duration_minutes: number }
      | Array<{ id: string; name: string; default_duration_minutes: number }>
      | null;
    studio:
      | {
          id: string;
          name: string;
          timezone: string;
          public_booking_horizon_months: number;
          cancellation_policy_text: string | null;
          no_show_policy_text: string | null;
        }
      | Array<{
          id: string;
          name: string;
          timezone: string;
          public_booking_horizon_months: number;
          cancellation_policy_text: string | null;
          no_show_policy_text: string | null;
        }>
      | null;
  };
  const row = data as unknown as Joined;
  const pick = <T>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;
  const service = pick(row.service);
  const studio = pick(row.studio);
  if (!service || !studio) {
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }

  return {
    ok: true,
    summary: {
      appointmentId: row.id,
      serviceId: service.id,
      serviceName: service.name,
      durationMinutes: row.duration_minutes,
      studioId: studio.id,
      studioName: studio.name,
      studioTimezone: studio.timezone,
      studioPublicBookingHorizonMonths: studio.public_booking_horizon_months,
      startsAt: row.starts_at,
      status: row.status,
      cancellationPolicyText: studio.cancellation_policy_text,
      noShowPolicyText: studio.no_show_policy_text,
    },
  };
}

export async function fetchRescheduleSlotsAction(params: {
  token: string;
  date: string;
}): Promise<{ ok: true; slots: Slot[] } | { ok: false; error: string }> {
  // Rate limit the slot fetch (generous; date-switching is bursty). Runs
  // before resolve + the heavy getAvailableSlots. Token never consumed.
  const gate = await limitTokenRoute({
    routeClass: "reschedule_slots",
    token: params.token,
    headers: await headers(),
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  // PR #149: refuse non-confirmed / past originals on the slot
  // fetch surface; collapse every failure to the generic public
  // copy.
  const asserted = await assertReschedulableOriginal(params.token);
  if (!asserted.ok) {
    return { ok: false, error: asserted.error };
  }
  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select(
      "id, duration_minutes, service:services(default_duration_minutes), studio:studios(id, timezone, default_appointment_duration_minutes, buffer_minutes, public_booking_horizon_months)",
    )
    .eq("id", asserted.original.appointment_id)
    .maybeSingle();
  if (!appt) return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };

  type J = {
    id: string;
    duration_minutes: number;
    service:
      | { default_duration_minutes: number }
      | { default_duration_minutes: number }[]
      | null;
    studio:
      | {
          id: string;
          timezone: string;
          default_appointment_duration_minutes: number;
          buffer_minutes: number;
          public_booking_horizon_months: number;
        }
      | {
          id: string;
          timezone: string;
          default_appointment_duration_minutes: number;
          buffer_minutes: number;
          public_booking_horizon_months: number;
        }[]
      | null;
  };
  const r = appt as unknown as J;
  const pick = <T>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;
  const svc = pick(r.service);
  const stu = pick(r.studio);
  if (!stu) return { ok: false, error: "Studio missing." };

  const horizon = horizonRangeInStudioTz(
    stu.timezone,
    stu.public_booking_horizon_months,
  );
  if (params.date < horizon.minDateStr || params.date > horizon.maxDateStr) {
    return { ok: false, error: "Date is outside the booking window." };
  }

  const slots = await getAvailableSlots(
    admin,
    {
      id: stu.id,
      timezone: stu.timezone,
      default_appointment_duration_minutes:
        stu.default_appointment_duration_minutes,
      buffer_minutes: stu.buffer_minutes,
    },
    params.date,
    svc?.default_duration_minutes ?? r.duration_minutes,
  );
  // PR #149: hide same-day past slots. Shared filterFutureSlots
  // helper is the single source of truth for public booking and
  // public reschedule so the two surfaces cannot drift apart on
  // what "future slot" means.
  return { ok: true, slots: filterFutureSlots(slots) };
}

// ---------------------------------------------------------------------------
// fetchNextAvailableDateForRescheduleAction
// ---------------------------------------------------------------------------
// "Next available" lookup for the reschedule page. Mirrors the public-
// booking action in app/book/[slug]/actions.ts: one server roundtrip,
// bounded linear scan from `fromDate` (clamped to today) through the
// studio's public booking horizon, returns the first date with a
// non-empty future-slot list for the appointment's service. Same past-
// time filter, same MAX_NEXT_AVAILABLE_SCAN_DAYS cap, same rate-limit
// class as the existing reschedule slot fetch. No booking engine or
// conflict logic changes; just reuses getAvailableSlots.
//
// Worst case: O(N) getAvailableSlots calls where N = horizon days
// (~92 for 3-month, ~123 for 4-month, ~184 for 6-month), hard-capped
// at MAX_NEXT_AVAILABLE_SCAN_DAYS = 200. The original token is never
// consumed; reschedule only consumes a token on confirm.
// ---------------------------------------------------------------------------

// Matches the public booking scan cap: derived from the largest configurable
// horizon (12 months = 372 days) + a small margin, so a wider horizon never
// truncates the next-available scan.
const MAX_NEXT_AVAILABLE_SCAN_DAYS = maxPublicBookingHorizonDays() + 14;

export async function fetchNextAvailableDateForRescheduleAction(params: {
  token: string;
  fromDate: string;
}): Promise<
  { ok: true; date: string | null } | { ok: false; error: string }
> {
  const gate = await limitTokenRoute({
    routeClass: "reschedule_slots",
    token: params.token,
    headers: await headers(),
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  // PR #149: refuse non-confirmed / past originals on the next-
  // available surface too.
  const asserted = await assertReschedulableOriginal(params.token);
  if (!asserted.ok) {
    return { ok: false, error: asserted.error };
  }
  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select(
      "id, duration_minutes, service:services(default_duration_minutes), studio:studios(id, timezone, default_appointment_duration_minutes, buffer_minutes, public_booking_horizon_months)",
    )
    .eq("id", asserted.original.appointment_id)
    .maybeSingle();
  if (!appt) return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };

  type J = {
    id: string;
    duration_minutes: number;
    service:
      | { default_duration_minutes: number }
      | { default_duration_minutes: number }[]
      | null;
    studio:
      | {
          id: string;
          timezone: string;
          default_appointment_duration_minutes: number;
          buffer_minutes: number;
          public_booking_horizon_months: number;
        }
      | {
          id: string;
          timezone: string;
          default_appointment_duration_minutes: number;
          buffer_minutes: number;
          public_booking_horizon_months: number;
        }[]
      | null;
  };
  const r = appt as unknown as J;
  const pick = <T>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v;
  const svc = pick(r.service);
  const stu = pick(r.studio);
  if (!stu) return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };

  const today = todayInTz(stu.timezone);
  const horizon = horizonRangeInStudioTz(
    stu.timezone,
    stu.public_booking_horizon_months,
  );

  // Start at max(fromDate, today). A past fromDate from a stale client
  // is already rejected upstream by the horizon check.
  const startDate = params.fromDate < today ? today : params.fromDate;
  if (startDate > horizon.maxDateStr) {
    return { ok: true, date: null };
  }

  const durationMinutes = svc?.default_duration_minutes ?? r.duration_minutes;
  // PR #149: single clock reading shared across every scan iteration
  // so filterFutureSlots sees a consistent "now" through the loop.
  const nowRef = new Date();
  let cursor = startDate;
  let scans = 0;
  while (cursor <= horizon.maxDateStr && scans < MAX_NEXT_AVAILABLE_SCAN_DAYS) {
    scans += 1;
    const slots = await getAvailableSlots(
      admin,
      {
        id: stu.id,
        timezone: stu.timezone,
        default_appointment_duration_minutes:
          stu.default_appointment_duration_minutes,
        buffer_minutes: stu.buffer_minutes,
      },
      cursor,
      durationMinutes,
    );
    const futureSlots = filterFutureSlots(slots, nowRef);
    if (futureSlots.length > 0) {
      return { ok: true, date: cursor };
    }
    cursor = addDays(cursor, 1);
  }
  return { ok: true, date: null };
}

export type RescheduleResult =
  | { ok: true; newAppointmentId: string }
  | { ok: false; error: string; code?: "slot_taken" };

export async function rescheduleAppointmentViaTokenAction(formData: FormData): Promise<
  RescheduleResult
> {
  const token = stringOrEmpty(formData.get("token"));
  const newStartsAt = stringOrEmpty(formData.get("starts_at"));
  // PR #132 / #133. The acknowledgement field is read up front but
  // the require / skip decision happens AFTER we load the studio
  // row because requiring acknowledgement of a non-existent policy
  // is confusing. A studio with no policy on file can reschedule
  // without the field. The server-side decision is the source of
  // truth; the page hint just keeps the UI honest.
  const acknowledged = stringOrEmpty(formData.get("acknowledged_policy"));
  if (!token) return { ok: false, error: "Missing token." };
  if (!newStartsAt) return { ok: false, error: "Pick a time." };

  // Rate limit before token verification, the reschedule RPC, and the
  // confirmation email. Independent of token validity, fails open. No
  // reschedule/email occurs when limited.
  const gate = await limitTokenRoute({
    routeClass: "reschedule_submit",
    token,
    headers: await headers(),
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  // PR #149: gate the submit through the same shared assert helper
  // every read path uses. If the token doesn't resolve, or the
  // original is not confirmed + future, we collapse to the generic
  // public error. The detailed lookup below is still needed for the
  // fields the RPC will consume, but it is now defended in depth.
  const asserted = await assertReschedulableOriginal(token);
  if (!asserted.ok) {
    return { ok: false, error: asserted.error };
  }

  const admin = createAdminClient();
  const { data: existing, error: lookupErr } = await admin
    .from("appointments")
    .select(
      "id, studio_id, practitioner_id, client_id, service_id, status, starts_at, duration_minutes",
    )
    .eq("id", asserted.original.appointment_id)
    .maybeSingle();
  if (lookupErr) {
    // PR #149: never surface raw DB error text. The structured log
    // keeps the operator's debugging power without leaking
    // table/function names to the public client.
    logInternal("public_reschedule_submit_lookup_failed", {
      code: lookupErr.code,
      message: lookupErr.message,
      appointmentId: asserted.original.appointment_id,
    });
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }
  if (!existing) return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  // Belt-and-braces: the helper already enforced confirmed + future,
  // but a tiny race window between the helper and this lookup could
  // in theory show a flipped row. The action re-checks here so the
  // RPC call never runs against a stale "confirmed + future" snapshot
  // and the DB CHECK in migration 0066 still enforces it last.
  if (existing.status !== "confirmed") {
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }
  if (new Date(existing.starts_at).getTime() <= Date.now()) {
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }

  const start = new Date(newStartsAt);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: "Invalid time." };
  }
  // PR #149: the submitted new start must be strictly in the future.
  // The slot list is already past-filtered, but a forged form (or a
  // visitor who submitted a stale slot) cannot bypass that filter to
  // cancel-and-recreate an appointment in the past. The DB RPC
  // (migration 0066) enforces the same invariant.
  if (start.getTime() <= Date.now()) {
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }
  const end = new Date(start.getTime() + existing.duration_minutes * 60_000);

  // Re-verify the new slot is still free.
  //
  // PR #132. cancellation_policy_text and no_show_policy_text are
  // added to the select so the policy snapshot row below can be
  // computed from the same studio row the rest of this action uses.
  // Server-resolved; never trusts a client-supplied snapshot.
  const { data: studioRow } = await admin
    .from("studios")
    .select(
      "id, timezone, default_appointment_duration_minutes, buffer_minutes, name, send_confirmation_emails, public_booking_horizon_months, cancellation_policy_text, no_show_policy_text",
    )
    .eq("id", existing.studio_id)
    .maybeSingle();
  if (!studioRow) return { ok: false, error: "Studio missing." };

  // PR #133. Decide acknowledgement requirement from the resolved
  // studio row. A studio with no policy text on file accepts the
  // reschedule without the field; one with at least one of
  // cancellation_policy_text or no_show_policy_text requires the
  // visitor to have ticked the box. The acknowledgement insert
  // below is gated on the same flag so the table only carries
  // meaningful rows.
  const requiresAck = hasAnyPolicy({
    cancellationPolicyText: studioRow.cancellation_policy_text,
    noShowPolicyText: studioRow.no_show_policy_text,
  });
  if (requiresAck && acknowledged !== "true") {
    return { ok: false, error: POLICY_ACK_REQUIRED_ERROR };
  }

  if (
    !isWithinPublicBookingHorizon(
      start,
      studioRow.timezone,
      studioRow.public_booking_horizon_months,
    )
  ) {
    return { ok: false, error: "That date is outside the booking window." };
  }

  const dateStr = localDateString(start, studioRow.timezone);
  const slots = await getAvailableSlots(
    admin,
    {
      id: studioRow.id,
      timezone: studioRow.timezone,
      default_appointment_duration_minutes:
        studioRow.default_appointment_duration_minutes,
      buffer_minutes: studioRow.buffer_minutes,
    },
    dateStr,
    existing.duration_minutes,
  );
  const free = slots.some(
    (s) => new Date(s.start).getTime() === start.getTime(),
  );
  if (!free) {
    return {
      ok: false,
      error: "That time is no longer available. Please choose another time.",
    };
  }

  // Single-transaction reschedule via the reschedule_appointment RPC
  // (migration 0029). Cancels the original row, inserts the
  // replacement, and writes both audit rows atomically. If anything
  // fails, including the exclusion constraint catching a slot race,
  // Postgres rolls back the entire transaction and the original
  // appointment stays confirmed.
  const newToken = generateAppointmentToken();
  // PR #260: the RPC matches/stores hashes. p_current is the hash the
  // resolver authenticated this request with (hash of the URL token, or
  // the row's stored hash for an HMAC link). p_new is the hash of the
  // freshly-generated raw token; the new row is stored hash-only and the
  // raw newToken is used in-memory below to build the confirmation links.
  const { data: rpcData, error: rpcErr } = await admin.rpc(
    "reschedule_appointment",
    {
      p_original_appointment_id: existing.id,
      p_current_cancellation_token: asserted.original.rpc_token_hash,
      p_new_starts_at: start.toISOString(),
      p_new_ends_at: end.toISOString(),
      p_new_duration_minutes: existing.duration_minutes,
      p_new_cancellation_token: hashAppointmentToken(newToken),
    },
  );

  if (rpcErr) {
    if (rpcErr.code === "23P01" || rpcErr.code === "HB001") {
      console.error(
        JSON.stringify({
          event: "booking_slot_collision",
          studioId: existing.studio_id,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          source: "reschedule",
          timestamp: new Date().toISOString(),
        }),
      );
      return {
        ok: false,
        error: "That time is no longer available. Please choose another time.",
        code: "slot_taken",
      };
    }
    // PR #149: never surface raw RPC error text. Structured log
    // keeps the operator's debugging power; public copy stays
    // generic so a token-bearing public route cannot reveal
    // internal function names or Postgres error strings.
    logInternal("public_reschedule_rpc_failed", {
      code: rpcErr.code,
      message: rpcErr.message,
      studioId: existing.studio_id,
      appointmentId: existing.id,
    });
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }

  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  if (!row || typeof row.result !== "string") {
    return { ok: false, error: "Unexpected response from server." };
  }

  if (row.result !== "success") {
    switch (row.result) {
      case "appointment_not_found":
        return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
      case "appointment_not_reschedulable":
        return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
      case "invalid_time_range":
        return { ok: false, error: "Invalid time." };
      default:
        return { ok: false, error: "Unexpected error." };
    }
  }

  const newAppointmentId = row.new_appointment_id as string;

  // PR #132. Write the policy acknowledgement row scoped to the
  // server-resolved (studio_id, client_id, appointment_id=ORIGINAL).
  // We link to the ORIGINAL existing.id (the appointment the token
  // resolved to) rather than the new appointment id because the
  // acknowledgement is "client accepted policies before they
  // rescheduled appointment X", and X is what the token referenced.
  // The audit_logs row the RPC stamps already ties the new
  // appointment back to the original.
  //
  // Failure to write this row does NOT roll back the reschedule: the
  // RPC committed atomically. We log server-side and proceed.
  //
  // PR #133. Acknowledgement is only written when the studio has
  // policy text on file. A studio with no policy never produced an
  // acknowledgement on the UI side either; we mirror that here so
  // the table only carries meaningful rows.
  if (requiresAck) {
    const snapshot = buildPolicySnapshot({
      cancellationPolicyText: studioRow.cancellation_policy_text,
      noShowPolicyText: studioRow.no_show_policy_text,
    });
    const { error: ackErr } = await admin
      .from("appointment_policy_acknowledgements")
      .insert({
        studio_id: existing.studio_id,
        appointment_id: existing.id,
        client_id: existing.client_id,
        action: "reschedule",
        cancellation_policy_text_snapshot:
          snapshot.cancellationPolicyTextSnapshot,
        no_show_policy_text_snapshot: snapshot.noShowPolicyTextSnapshot,
        policy_snapshot_hash: snapshot.policySnapshotHash,
      });
    if (ackErr) {
      console.error(
        JSON.stringify({
          event: "public_reschedule_policy_ack_insert_failed",
          code: ackErr.code,
          message: ackErr.message,
          originalAppointmentId: existing.id,
          newAppointmentId,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  // Re-fetch the newly inserted row so the email-builder has the
  // complete appointment shape. The RPC returns only the id.
  const { data: created, error: fetchErr } = await admin
    .from("appointments")
    .select("*")
    .eq("id", newAppointmentId)
    .single();
  if (fetchErr || !created) {
    // PR #155: this branch previously leaked the raw DB error text
    // via `error: fetchErr?.message ?? "..."`. Optional-chaining
    // tricked the PR #149 regex which only caught `fetchErr.message`.
    // The reschedule RPC has already committed atomically at this
    // point; the post-create fetch failure means the email/SMS
    // confirmation step cannot run, but the appointment itself is
    // confirmed in the database. Collapse to the generic public copy
    // so a probing caller does not see "row not found" vs raw Postgres
    // error text; keep structured server-side detail for the operator.
    logInternal("public_reschedule_post_create_fetch_failed", {
      code: fetchErr?.code,
      message: fetchErr?.message ?? "created appointment not found",
      newAppointmentId,
    });
    return {
      ok: false,
      error: PUBLIC_RESCHEDULE_GENERIC_ERROR,
    };
  }

  // Send a fresh confirmation email for the new appointment. Phone +
  // SMS consent fields are selected so the SMS attempt below has the
  // data it needs without a second roundtrip; the SMS path does not
  // modify either field.
  const { data: clientRow } = await admin
    .from("clients")
    .select("name, email, phone, sms_consent_at, sms_opted_out_at")
    .eq("id", existing.client_id)
    .maybeSingle();
  const { data: serviceRow } = existing.service_id
    ? await admin
        .from("services")
        .select("name, default_duration_minutes, pre_care_instructions")
        .eq("id", existing.service_id)
        .maybeSingle()
    : { data: null };
  const { data: ownerRow } = await admin
    .from("practitioners")
    .select("display_name, email")
    .eq("studio_id", existing.studio_id)
    .eq("active", true)
    .eq("role", "owner")
    .maybeSingle();

  // PR #164. Fire-and-forget practitioner notification. The
  // reschedule RPC already committed atomically by this point; this
  // helper never throws to the caller. Body composes the client
  // name (fallback to "A client" if the lookup above missed) and
  // both the old and new times in 12h AM/PM format so the
  // practitioner can read the shift at a glance. href links to the
  // appointment detail page for the NEW appointment id.
  recordPractitionerNotification({
    studioId: existing.studio_id,
    practitionerId: existing.practitioner_id ?? null,
    eventType: "appointment_rescheduled",
    title: "Appointment rescheduled",
    body: `${clientRow?.name ?? "A client"} rescheduled from ${formatDayTime(new Date(existing.starts_at), studioRow.timezone)} to ${formatDayTime(new Date(created.starts_at), studioRow.timezone)}.`,
    appointmentId: created.id,
    clientId: existing.client_id,
    href: `/calendar/${created.id}`,
  });

  if (clientRow?.email && studioRow.send_confirmation_emails) {
    // Single helper call up front; downstream lines share the same origin.
    const appOrigin = getRequiredAppOrigin();
    const cancellationUrl = `${appOrigin}/cancel/${newToken}`;
    const rescheduleUrl = `${appOrigin}/reschedule/${newToken}`;
    // SMS uses the single neutral manage entry point. The email
    // path above keeps the explicit cancel + reschedule URLs because
    // email has the room for both labelled links; SMS does not, and
    // the pilot direction is to keep SMS from actively inviting
    // cancel/reschedule.
    const manageUrl = `${appOrigin}/manage/${newToken}`;
    const intake = await ensureIntakeForClient({
      studioId: existing.studio_id,
      clientId: existing.client_id,
      appOrigin,
    });
    try {
      const { data: studioFull } = await admin
        .from("studios")
        .select("*")
        .eq("id", existing.studio_id)
        .single();
      if (studioFull) {
        const treatmentTimeLine = studioFull.show_treatment_time_to_clients
          ? buildTreatmentTimeLine({
              enabled: true,
              clientFirstName:
                clientRow.name.split(/\s+/)[0] || clientRow.name,
              context: await getTreatmentTimeContextForEmail(
                existing.studio_id,
                existing.client_id,
              ),
            })
          : null;
        // Truthful reporting: stamp confirmation_sent_at only when Resend
        // actually delivered, not just when we called it.
        const result = await sendBookingConfirmationToClient({
          appointment: created,
          service: serviceRow,
          studio: studioFull,
          practitionerDisplayName:
            ownerRow?.display_name?.trim() || ownerRow?.email || studioFull.name,
          clientName: clientRow.name,
          clientEmail: clientRow.email,
          cancellationUrl,
          rescheduleUrl,
          intakeUrl: intake?.url ?? null,
          treatmentTimeLine,
          appBaseUrl: appOrigin,
        });
        await recordEmailAttempt(admin, created.id, "confirmation", result.ok);
        if (!result.ok) {
          logEmailFailure({
            appointmentId: created.id,
            emailType: "confirmation",
            error: result.error,
            retryable: result.retryable,
            attemptNumber: 1,
          });
        }

        // SMS confirmation for the rescheduled appointment. The new
        // appointment row is a fresh appointments.id so the SMS claim
        // and tracking columns are clean (no carry-over from the
        // cancelled prior row). All gates and timeouts live inside
        // the helper; failure here cannot break reschedule.
        await sendBookingConfirmationSmsToClient({
          admin,
          appointmentId: created.id,
          startsAt: new Date(created.starts_at),
          timezone: studioFull.timezone,
          studio: studioFull,
          client: {
            phone: clientRow.phone,
            sms_consent_at: clientRow.sms_consent_at ?? null,
            sms_opted_out_at: clientRow.sms_opted_out_at ?? null,
          },
          intakeUrl: intake?.url ?? null,
          manageUrl,
        });
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "reschedule_confirmation_unexpected_error",
          appointmentId: created.id,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  return { ok: true, newAppointmentId: created.id };
}

function stringOrEmpty(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

// PR #164. Short "weekday, Month day at H:MM AM/PM" label used in
// the practitioner notification body for a reschedule
// ("rescheduled from <old> to <new>"). Composed locally so the
// notification helper does not have to import every template
// helper; localTimeString12h delivers the AM/PM clock per PR #157.
function formatDayTime(d: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
  return `${day} at ${localTimeString12h(d, tz)}`;
}
