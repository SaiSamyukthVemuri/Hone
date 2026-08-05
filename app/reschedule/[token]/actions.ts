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
  type ReservationExclusion,
  type Slot,
} from "@/lib/booking/slots";
import { addDays, localTimeString12h, todayInTz } from "@/lib/booking/tz";
import { recordPractitionerNotification } from "@/lib/notifications/practitioner-notifications";
// 0171: `isWithinPublicBookingHorizon` and `localDateString` are deliberately
// NOT imported any more. The submit path used them to pre-check the horizon and
// to build a date string for its own getAvailableSlots re-verification — both of
// which are now owned by reschedule_appointment_v2, under the studio lock. A
// second, unlocked implementation of either could only drift from the
// authoritative one. `horizonRangeInStudioTz` remains for the READ surfaces,
// which still bound the date picker.
import {
  horizonRangeInStudioTz,
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

// 0171. The studio edited its cancellation/no-show policy between this page
// render and the submit, so the box the visitor ticked no longer describes what
// is on file. The command refuses rather than record acceptance of text that
// was never displayed; the visitor is told to look again, not that something
// went wrong.
const POLICY_CHANGED_ERROR =
  "The studio's appointment policies changed while you were on this page. Please refresh, review them again, and confirm.";

// 0171. Rescheduling to the appointment's CURRENT time is a no-op. Excluding
// the original's own reservation makes its start technically free again, so
// without this the command would cancel and recreate the booking purely to
// rotate its token.
const SAME_TIME_ERROR =
  "That's the time this appointment is already booked for. Pick a different time.";

// 0171. The original appointment carries payment state whose reschedule
// semantics are not defined anywhere in the product. The command refuses rather
// than silently move, duplicate or orphan money; the original stays confirmed.
const PAYMENT_STATE_ERROR =
  "This appointment can't be changed online. Please contact the studio and they'll help you reschedule.";

// 0171. The studio runs practitioner capacity and the practitioner this
// appointment was booked with can no longer take it. Public reschedule never
// silently reassigns a client to somebody else, so this is a studio
// conversation.
const PRACTITIONER_UNAVAILABLE_ERROR =
  "This appointment can't be changed online right now. Please contact the studio and they'll help you reschedule.";
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
  // PR #260: the hash to pass to reschedule_appointment_v2 as
  // p_current_cancellation_token_hash. The command matches by hash; this is
  // the hash of the raw URL token (column path) or the row's stored hash
  // (HMAC path), so the command's locked re-verification always resolves the
  // same row the resolver already authenticated.
  rpc_token_hash: string;
  // 0171. THE BOOKED CONTRACT, carried to every slot surface.
  //
  // duration_minutes is the ORIGINAL appointment's stored duration, never the
  // service's current default. A studio that lengthens a service after a
  // client books must not silently relength that client's booking, and the
  // page must not offer 60-minute slots for a 45-minute appointment while the
  // command creates a 45-minute successor. Every reschedule read surface and
  // the command itself now use this one value.
  duration_minutes: number;
  // The preserved practitioner. Public reschedule never reassigns, so this is
  // both the capacity-mode key for slot generation and the assignee the
  // command will keep.
  practitioner_id: string | null;
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
    .select(
      "id, studio_id, client_id, practitioner_id, status, starts_at, duration_minutes",
    )
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
      duration_minutes: data.duration_minutes,
      practitioner_id: data.practitioner_id ?? null,
    },
  };
}

// 0171. The one place the reschedule read surfaces build their slot-engine
// arguments, so `fetchRescheduleSlotsAction` and
// `fetchNextAvailableDateForRescheduleAction` cannot drift apart — and cannot
// drift from what the command will accept.
//
// Three things every reschedule slot query needs and none of them used to pass:
//
//   * ORIGINAL-RESERVATION EXCLUSION. The appointment being moved owns a
//     studio_calendar_reservations row. Counting it as a conflict hides
//     otherwise valid moves (every slot adjacent to the original, and the
//     original's own time) and does not model the final transaction, in which
//     the original is cancelled — and its reservation deleted — before the
//     successor is inserted. The exclusion id is derived SERVER-side from the
//     resolved token; the browser never supplies it.
//   * THE PRESERVED PRACTITIONER + the studio's current capacity flag, so a
//     capacity-ON studio generates the practitioner's own timeline exactly as
//     lib/booking/slots.ts does.
//   * THE ORIGINAL DURATION (see ReschedulableOriginal.duration_minutes).
type RescheduleSlotContext = {
  studio: {
    id: string;
    timezone: string;
    default_appointment_duration_minutes: number;
    buffer_minutes: number;
    practitioner_capacity_enabled: boolean;
    public_booking_horizon_months: number;
  };
  durationMinutes: number;
  practitionerId: string | null;
  excludeReservation: ReservationExclusion;
};

async function loadRescheduleSlotContext(
  admin: ReturnType<typeof createAdminClient>,
  original: ReschedulableOriginal,
): Promise<RescheduleSlotContext | null> {
  const { data: studio } = await admin
    .from("studios")
    .select(
      "id, timezone, default_appointment_duration_minutes, buffer_minutes, practitioner_capacity_enabled, public_booking_horizon_months",
    )
    .eq("id", original.studio_id)
    .maybeSingle();
  if (!studio) return null;
  return {
    studio: {
      id: studio.id,
      timezone: studio.timezone,
      default_appointment_duration_minutes:
        studio.default_appointment_duration_minutes,
      buffer_minutes: studio.buffer_minutes,
      practitioner_capacity_enabled:
        studio.practitioner_capacity_enabled === true,
      public_booking_horizon_months: studio.public_booking_horizon_months,
    },
    durationMinutes: original.duration_minutes,
    practitionerId: original.practitioner_id,
    excludeReservation: {
      sourceKind: "appointment",
      sourceId: original.appointment_id,
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
  // change.
  cancellationPolicyText: string | null;
  noShowPolicyText: string | null;
  // 0171. THE HASH OF THE POLICY TEXT THIS RENDER ACTUALLY SHOWED.
  //
  // Server-generated, never round-tripped as text. The form posts it back
  // unchanged alongside the checkbox and reschedule_appointment_v2 re-derives
  // the CURRENT hash from the studio row and compares: a studio that edits its
  // policy between this render and the submit gets `policy_changed`, and no
  // acknowledgement of unseen text is ever recorded.
  //
  // null when the studio has no policy on file — there is nothing to
  // acknowledge, so the command requires neither the checkbox nor the hash.
  presentedPolicyHash: string | null;
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

  // 0171. Hash exactly what this render is about to display. buildPolicySnapshot
  // is the same canonical function the command's SQL reproduces byte-for-byte
  // (coalesce each side to '', join with "\n---\n", SHA-256 hex, NO trim).
  const requiresAck = hasAnyPolicy({
    cancellationPolicyText: studio.cancellation_policy_text,
    noShowPolicyText: studio.no_show_policy_text,
  });
  const presentedPolicyHash = requiresAck
    ? buildPolicySnapshot({
        cancellationPolicyText: studio.cancellation_policy_text,
        noShowPolicyText: studio.no_show_policy_text,
      }).policySnapshotHash
    : null;

  return {
    ok: true,
    summary: {
      appointmentId: row.id,
      serviceId: service.id,
      serviceName: service.name,
      // The ORIGINAL appointment's stored duration — what the client booked —
      // not service.default_duration_minutes.
      durationMinutes: row.duration_minutes,
      studioId: studio.id,
      studioName: studio.name,
      studioTimezone: studio.timezone,
      studioPublicBookingHorizonMonths: studio.public_booking_horizon_months,
      startsAt: row.starts_at,
      status: row.status,
      cancellationPolicyText: studio.cancellation_policy_text,
      noShowPolicyText: studio.no_show_policy_text,
      presentedPolicyHash,
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
  const ctx = await loadRescheduleSlotContext(admin, asserted.original);
  if (!ctx) return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };

  const horizon = horizonRangeInStudioTz(
    ctx.studio.timezone,
    ctx.studio.public_booking_horizon_months,
  );
  if (params.date < horizon.minDateStr || params.date > horizon.maxDateStr) {
    return { ok: false, error: "Date is outside the booking window." };
  }

  // 0171. Duration is the ORIGINAL appointment's, never the service's current
  // default — this call used to pass `svc?.default_duration_minutes ??
  // r.duration_minutes`, so a studio that edited the service after the booking
  // made the page offer slots at one length while the submit path used another.
  // The exclusion and the practitioner are passed for the first time here.
  const slots = await getAvailableSlots(
    admin,
    ctx.studio,
    params.date,
    ctx.durationMinutes,
    ctx.excludeReservation,
    ctx.practitionerId,
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
  const ctx = await loadRescheduleSlotContext(admin, asserted.original);
  if (!ctx) return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };

  const today = todayInTz(ctx.studio.timezone);
  const horizon = horizonRangeInStudioTz(
    ctx.studio.timezone,
    ctx.studio.public_booking_horizon_months,
  );

  // Start at max(fromDate, today). A past fromDate from a stale client
  // is already rejected upstream by the horizon check.
  const startDate = params.fromDate < today ? today : params.fromDate;
  if (startDate > horizon.maxDateStr) {
    return { ok: true, date: null };
  }

  // PR #149: single clock reading shared across every scan iteration
  // so filterFutureSlots sees a consistent "now" through the loop.
  const nowRef = new Date();
  let cursor = startDate;
  let scans = 0;
  while (cursor <= horizon.maxDateStr && scans < MAX_NEXT_AVAILABLE_SCAN_DAYS) {
    scans += 1;
    // 0171: same original duration, same exclusion, same practitioner as
    // fetchRescheduleSlotsAction. A scan that used different arguments would
    // land the visitor on a date whose slot list then came back empty.
    const slots = await getAvailableSlots(
      admin,
      ctx.studio,
      cursor,
      ctx.durationMinutes,
      ctx.excludeReservation,
      ctx.practitionerId,
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
  // 0171. The hash of the policy text the PAGE ACTUALLY RENDERED, generated by
  // the server in fetchAppointmentForRescheduleAction and posted back
  // unchanged. It is a proof-of-display token, not policy content: the command
  // re-derives the current hash from the studio row itself, so a tampered or
  // stale value can only ever cause a refusal, never a false acknowledgement.
  // Policy TEXT is never accepted from the form.
  const presentedPolicyHash = stringOrEmpty(
    formData.get("presented_policy_hash"),
  );
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

  const start = new Date(newStartsAt);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: "Invalid time." };
  }

  // 0171. METADATA IS LOADED BEFORE THE COMMAND, NEVER AFTER IT.
  //
  // Everything needed to send the confirmation is read here, while a failure
  // can still be reported honestly — because once the command commits, the
  // reschedule HAS happened and no later read may turn that into a failure.
  // The old code loaded these AFTER the RPC and had a branch that returned
  // {ok:false} when the post-commit successor SELECT failed; that branch both
  // lied to the visitor and destroyed the only copy of the raw successor token.
  const { data: studioRow, error: studioErr } = await admin
    .from("studios")
    .select("*")
    .eq("id", asserted.original.studio_id)
    .maybeSingle();
  if (studioErr || !studioRow) {
    logInternal("public_reschedule_studio_lookup_failed", {
      code: studioErr?.code,
      studioId: asserted.original.studio_id,
      appointmentId: asserted.original.appointment_id,
    });
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }

  // =========================================================================
  // THE TOKEN-DELIVERY GATE. This MUST run before the token is minted and
  // before the command is called.
  // =========================================================================
  //
  // The successor's raw management token is a ONE-TIME IN-MEMORY SECRET. Only
  // its SHA-256 is persisted (`cancellation_token_hash`), the old token is not
  // reused, and no token can be regenerated after the commit — so the
  // confirmation email is the ONLY carrier of the credential the client needs
  // to cancel or reschedule the successor.
  //
  // The command independently re-verifies that the client exists and is active,
  // so a transient failure of THIS read does not stop the mutation. That is
  // precisely the hazard: an errored or empty client lookup would let the
  // command commit, skip the email path (which is gated on `clientRow?.email`),
  // and drop the raw token when this function returns. The reschedule would
  // succeed while the client was left holding links they can never use — the
  // exact token-loss failure this PR exists to close, reintroduced one layer up.
  //
  // So the rule is: HONE DOES NOT COMMIT A PUBLIC RESCHEDULE IT CANNOT DELIVER
  // THE REPLACEMENT CREDENTIAL FOR. A failed read, a missing row, or a missing
  // email all refuse BEFORE any mutation, while refusing is still honest.
  //
  // Scoped by (id, studio_id): the client must belong to the SAME studio as the
  // appointment, so a cross-tenant id cannot satisfy the gate.
  const { data: clientRow, error: clientErr } = await admin
    .from("clients")
    .select("name, email, phone, sms_consent_at, sms_opted_out_at")
    .eq("id", asserted.original.client_id)
    .eq("studio_id", asserted.original.studio_id)
    .maybeSingle();
  if (clientErr || !clientRow || !clientRow.email || clientRow.email.trim() === "") {
    // Safe operator signal only: no name, no email, no phone, no token, no raw
    // Postgres message (which can echo row values on a public surface).
    logInternal("public_reschedule_client_metadata_unavailable", {
      code: clientErr?.code,
      studioId: asserted.original.studio_id,
      appointmentId: asserted.original.appointment_id,
      reason: clientErr ? "lookup_failed" : !clientRow ? "missing_row" : "missing_email",
    });
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }

  // The raw successor token is minted only AFTER the delivery gate passes, and
  // only its SHA-256 crosses the boundary. The raw value lives in this closure
  // and nowhere else — never stored, never logged, and the ONLY thing that can
  // build the client's cancel/reschedule/manage links.
  const newToken = generateAppointmentToken();

  // ONE AUTHORITATIVE MUTATION. The command owns the cancellation, the
  // successor, both lineage directions, both audits and the policy
  // acknowledgement. It takes no end time, no duration, no studio/client/
  // service/practitioner, no status and no lineage id — every one of those is
  // derived from the LOCKED original inside the transaction.
  const { data: rpcData, error: rpcErr } = await admin.rpc(
    "reschedule_appointment_v2",
    {
      p_original_appointment_id: asserted.original.appointment_id,
      p_current_cancellation_token_hash: asserted.original.rpc_token_hash,
      p_new_starts_at: start.toISOString(),
      p_new_cancellation_token_hash: hashAppointmentToken(newToken),
      p_acknowledged_policy: acknowledged === "true",
      p_presented_policy_snapshot_hash: presentedPolicyHash || null,
    },
  );

  if (rpcErr) {
    if (rpcErr.code === "23P01" || rpcErr.code === "HB001") {
      console.error(
        JSON.stringify({
          event: "booking_slot_collision",
          studioId: asserted.original.studio_id,
          startsAt: start.toISOString(),
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
      studioId: asserted.original.studio_id,
      appointmentId: asserted.original.appointment_id,
    });
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }

  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  if (!row || typeof row.result !== "string") {
    return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
  }

  if (row.result !== "success") {
    switch (row.result) {
      // Token state and appointment state collapse to ONE string so a probing
      // caller cannot distinguish "unknown token" from "valid token, wrong
      // state" — this is the same collapse every read surface applies.
      case "appointment_not_found":
      case "appointment_not_reschedulable":
        return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
      case "policy_ack_required":
        return { ok: false, error: POLICY_ACK_REQUIRED_ERROR };
      case "policy_changed":
        return { ok: false, error: POLICY_CHANGED_ERROR };
      case "same_time":
        return { ok: false, error: SAME_TIME_ERROR };
      case "outside_horizon":
        return { ok: false, error: "That date is outside the booking window." };
      case "invalid_time":
        return { ok: false, error: "Invalid time." };
      // Every "that time will not work" verdict maps to the one actionable
      // string, exactly as the public booking route does.
      case "studio_closed":
      case "outside_availability":
      case "time_unavailable":
      case "not_a_public_slot":
        return {
          ok: false,
          error: "That time is no longer available. Please choose another time.",
          code: "slot_taken",
        };
      case "payment_state_requires_studio":
        return { ok: false, error: PAYMENT_STATE_ERROR };
      case "practitioner_unavailable":
        return { ok: false, error: PRACTITIONER_UNAVAILABLE_ERROR };
      default:
        logInternal("public_reschedule_command_unmapped_code", {
          code: row.result,
          studioId: asserted.original.studio_id,
        });
        return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
    }
  }

  // =========================================================================
  // COMMITTED. THE RESCHEDULE HAS HAPPENED.
  // =========================================================================
  //
  // From here to the final `return`, NOTHING may report failure and NOTHING may
  // throw past this function. Everything below is a post-commit side effect: a
  // read, a provider call or a bookkeeping write. The database transaction is
  // already durable, so an exception escaping to the framework here would
  // surface to the visitor as a failed reschedule that actually succeeded —
  // and would take the raw successor token with it.
  //
  // Structural rule pinned by tests/security/public-reschedule-command-guard:
  // every post-commit statement lives inside the ONE try below. An earlier
  // revision opened its try only after the practitioner lookup, the service
  // lookup and the notification call, all of which can reject.
  const parsed = parseRescheduleSuccessRow(row);
  if (!parsed) {
    // The command said `success`, so the mutation IS committed — this is an
    // internal command-contract violation, not a visitor-facing failure, and it
    // must NOT be reported as a failed reschedule. The SQL return is
    // structurally non-null for `success` (pinned by
    // tests/migrations/0171-* and tests/db/public-reschedule-command.db), so
    // reaching here means the contract broke and an operator needs to know.
    logInternal("public_reschedule_malformed_success_row", {
      studioId: asserted.original.studio_id,
      appointmentId: asserted.original.appointment_id,
      // Field PRESENCE only — never the payload, which carries ids and times.
      missing: missingSuccessFields(row).join(","),
    });
    const salvagedId =
      typeof row.new_appointment_id === "string" ? row.new_appointment_id : null;
    if (!salvagedId) {
      // Without an id there is nothing truthful to return; the reschedule is
      // still committed, so this stays a generic failure with an operator log
      // rather than a claim that nothing happened.
      return { ok: false, error: PUBLIC_RESCHEDULE_GENERIC_ERROR };
    }
    return { ok: true, newAppointmentId: salvagedId };
  }

  const newAppointmentId = parsed.newAppointmentId;

  try {
    // The successor payload is built from the COMMAND'S OWN RETURN, not from a
    // re-read. The confirmation/notification senders read only id / starts_at /
    // ends_at / duration_minutes / created_at, and every one of those comes
    // back authoritative and non-null. No post-commit SELECT can fail the
    // reschedule any more.
    const created = {
      id: parsed.newAppointmentId,
      starts_at: parsed.startsAt,
      ends_at: parsed.endsAt,
      duration_minutes: parsed.durationMinutes,
      created_at: parsed.createdAt,
    } as unknown as import("@/lib/types/database").Appointment;

    // AUTHORITATIVE PRACTITIONER — the one the command preserved, resolved by
    // EXACT (id, studio_id).
    //
    // This route used to select "the current active owner with role = 'owner'"
    // for the practitioner name shown to the client and for the practitioner
    // email. That is not the appointment's practitioner: at a studio with a
    // different assignee, or one whose ownership changed, the client was told a
    // name that had nothing to do with their booking. Public reschedule never
    // reassigns, so the only correct source is the command's return.
    const assignedPractitionerId = parsed.practitionerId;
    let assignedPractitioner: {
      display_name: string | null;
      email: string | null;
    } | null = null;
    if (assignedPractitionerId) {
      const { data: pr, error: prErr } = await admin
        .from("practitioners")
        .select("display_name, email")
        .eq("id", assignedPractitionerId)
        .eq("studio_id", asserted.original.studio_id)
        .maybeSingle();
      if (prErr || !pr) {
        // Safe, non-PII operational signal. Downstream degrades to the
        // studio-name fallback rather than naming a stale practitioner.
        logInternal("public_reschedule_practitioner_lookup_failed", {
          code: prErr?.code,
          studioId: asserted.original.studio_id,
        });
      } else {
        assignedPractitioner = pr;
      }
    }

    const { data: serviceRow } = parsed.serviceId
      ? await admin
          .from("services")
          .select("name, default_duration_minutes, pre_care_instructions")
          .eq("id", parsed.serviceId)
          .maybeSingle()
      : { data: null };

    // Client-facing practitioner label. Falls back to the studio name exactly
    // as before when there is no assigned practitioner or the metadata read
    // failed.
    const practitionerDisplayName =
      assignedPractitioner?.display_name?.trim() ||
      assignedPractitioner?.email ||
      studioRow.name;

    // PR #164. Fire-and-forget practitioner notification. The command already
    // committed atomically by this point. The practitioner id is the COMMAND'S,
    // so the notification lands on the appointment's real assignee and never on
    // an arbitrary current owner.
    recordPractitionerNotification({
      studioId: asserted.original.studio_id,
      practitionerId: assignedPractitionerId,
      eventType: "appointment_rescheduled",
      title: "Appointment rescheduled",
      body: `${clientRow.name} rescheduled from ${formatDayTime(new Date(parsed.originalStartsAt), studioRow.timezone)} to ${formatDayTime(new Date(created.starts_at), studioRow.timezone)}.`,
      appointmentId: created.id,
      clientId: asserted.original.client_id,
      href: `/calendar/${created.id}`,
    });

    if (studioRow.send_confirmation_emails) {
      // Single helper call up front; downstream lines share the same origin.
      const appOrigin = getRequiredAppOrigin();
      const cancellationUrl = `${appOrigin}/cancel/${newToken}`;
      const rescheduleUrl = `${appOrigin}/reschedule/${newToken}`;
      // SMS uses the single neutral manage entry point. The email path keeps
      // the explicit cancel + reschedule URLs because email has room for both
      // labelled links; SMS does not, and the pilot direction is to keep SMS
      // from actively inviting cancel/reschedule.
      const manageUrl = `${appOrigin}/manage/${newToken}`;
      const intake = await ensureIntakeForClient({
        studioId: asserted.original.studio_id,
        clientId: asserted.original.client_id,
        appOrigin,
      });
      const treatmentTimeLine = studioRow.show_treatment_time_to_clients
        ? buildTreatmentTimeLine({
            enabled: true,
            clientFirstName: clientRow.name.split(/\s+/)[0] || clientRow.name,
            context: await getTreatmentTimeContextForEmail(
              asserted.original.studio_id,
              asserted.original.client_id,
            ),
          })
        : null;
      // Truthful reporting: stamp confirmation_sent_at only when Resend
      // actually delivered, not just when we called it.
      const result = await sendBookingConfirmationToClient({
        appointment: created,
        service: serviceRow,
        studio: studioRow,
        practitionerDisplayName,
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

      // SMS confirmation for the rescheduled appointment. The successor is a
      // fresh appointments.id so the SMS claim and tracking columns are clean
      // (no carry-over from the cancelled prior row). All gates — studio
      // toggle, consent_at, opted_out_at, phone normalisation, the claim race
      // guard — live inside the helper, which never throws.
      await sendBookingConfirmationSmsToClient({
        admin,
        appointmentId: created.id,
        startsAt: new Date(created.starts_at),
        timezone: studioRow.timezone,
        studio: studioRow,
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
    // The ONLY catch for the whole post-commit region. It swallows by design:
    // a practitioner-lookup rejection, a service-lookup rejection, an origin
    // resolver throw, an intake or treatment-time failure, a provider outage,
    // an email-attempt write failure, or an SMS helper that throws despite its
    // documented never-throw contract — none of them may change a committed
    // reschedule into a reported failure.
    //
    // Non-PII only: the successor id and a message. No client name/email/phone,
    // no token, no token hash.
    logInternal("public_reschedule_post_commit_side_effect_failed", {
      appointmentId: newAppointmentId,
      studioId: asserted.original.studio_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // THE RESCHEDULE SUCCEEDED. A failed email, a failed SMS, a failed
  // notification or a failed metadata read cannot change that — the database
  // transaction committed and the visitor's appointment has moved.
  return { ok: true, newAppointmentId };
}

// ---------------------------------------------------------------------------
// Command result-row parsing (0171 amendment)
// ---------------------------------------------------------------------------
//
// `reschedule_appointment_v2` returns a nullable RETURNS TABLE because refusal
// rows carry nulls in every field but `result`. For `result = 'success'` the
// command populates all of them by construction, and both the migration
// structural test and a DB test pin that.
//
// This parser converts that guarantee into a runtime one so the action never
// does `row.new_appointment_id as string` and silently threads `null` into a
// URL, an email payload or a notification href. It NEVER throws and NEVER
// echoes the payload — a malformed row becomes `null` plus a field-name list.

/** Fields that must be non-null on a `success` row. */
const REQUIRED_SUCCESS_FIELDS = [
  "new_appointment_id",
  "studio_id",
  "client_id",
  "starts_at",
  "ends_at",
  "duration_minutes",
  "created_at",
  "original_starts_at",
] as const;

type RescheduleSuccess = {
  newAppointmentId: string;
  studioId: string;
  clientId: string;
  serviceId: string | null;
  practitionerId: string | null;
  originalStartsAt: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  createdAt: string;
};

/** Names of the required fields that are missing/blank. Never the values. */
function missingSuccessFields(row: Record<string, unknown>): string[] {
  return REQUIRED_SUCCESS_FIELDS.filter((f) => {
    const v = row?.[f];
    if (v === null || v === undefined) return true;
    if (f === "duration_minutes") {
      return typeof v !== "number" || !Number.isFinite(v) || v <= 0;
    }
    return typeof v !== "string" || v.trim() === "";
  });
}

/**
 * Returns the fully-typed success payload, or `null` when the row violates the
 * command contract. `service_id` and `practitioner_id` stay nullable: a studio
 * with no service on the original, or a capacity-OFF booking with no
 * practitioner, are both legitimate.
 */
function parseRescheduleSuccessRow(
  row: Record<string, unknown>,
): RescheduleSuccess | null {
  if (missingSuccessFields(row).length > 0) return null;
  return {
    newAppointmentId: row.new_appointment_id as string,
    studioId: row.studio_id as string,
    clientId: row.client_id as string,
    serviceId: (row.service_id as string | null) ?? null,
    practitionerId: (row.practitioner_id as string | null) ?? null,
    originalStartsAt: row.original_starts_at as string,
    startsAt: row.starts_at as string,
    endsAt: row.ends_at as string,
    durationMinutes: row.duration_minutes as number,
    createdAt: row.created_at as string,
  };
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
