"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  limitPublicSlots,
  limitPublicBooking,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit/public";
import { getStudioBySlug } from "@/lib/booking/queries";
import { getAvailableSlots, type Slot } from "@/lib/booking/slots";
import {
  isPubliclyBookable,
  UNAVAILABLE_PUBLIC_BOOKING_MESSAGE,
} from "@/lib/booking/readiness";
import { generateAppointmentToken } from "@/lib/booking/appointment-token";
import { addDays, localDateString, todayInTz } from "@/lib/booking/tz";
import {
  horizonRangeInStudioTz,
  isWithinPublicBookingHorizon,
} from "@/lib/booking/horizon";
import { ensureIntakeForClient } from "@/lib/intake/queries";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";
import {
  logEmailFailure,
  recordEmailAttempt,
  sendBookingConfirmationToClient,
  sendBookingNotificationToPractitioner,
} from "@/lib/email/send-appointment";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Generic public booking error. Returned for all non-success outcomes
// where the underlying error originated from the database, an internal
// dependency, or any condition that an unauthenticated public caller
// has no business probing. Use raw error strings only for caller-input
// validation (e.g. missing email).
const PUBLIC_BOOKING_GENERIC_ERROR =
  "We couldn't complete your booking. Please try again or contact the studio.";

function logInternalBookingError(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({ event, detail, timestamp: new Date().toISOString() }),
    );
  } catch {
    console.error(event, detail);
  }
}

// Match the public.clients.normalized_email generated column rule from
// migration 0032: lower(trim(email)), and treat blanks as null.
function normalizeEmail(raw: string): string | null {
  const norm = raw.trim().toLowerCase();
  return norm.length === 0 ? null : norm;
}

export async function fetchPublicSlotsAction(params: {
  slug: string;
  serviceId: string;
  date: string;
}): Promise<{ ok: true; slots: Slot[] } | { ok: false; error: string }> {
  // Rate limit (v1) before any DB read or the heavy getAvailableSlots call.
  // Generous per (IP, slug). Fails open when Upstash is unconfigured or down.
  const slotGate = await limitPublicSlots({
    headers: await headers(),
    slug: params.slug,
  });
  if (!slotGate.allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  const studio = await getStudioBySlug(params.slug);
  if (!studio) return { ok: false, error: "Studio not found." };

  const horizon = horizonRangeInStudioTz(
    studio.timezone,
    studio.public_booking_horizon_months,
  );
  if (params.date < horizon.minDateStr || params.date > horizon.maxDateStr) {
    return { ok: false, error: "Date is outside the booking window." };
  }

  const admin = createAdminClient();

  // Self-serve publish soft-gate: refuse slot probes for studios that
  // aren't publicly bookable yet (no active services OR no open
  // availability day). Identical sanitized message regardless of which
  // piece is missing — never disclose internal setup state to a public
  // caller. Public page renders the same copy in app/book/[slug]/page.tsx.
  const ready = await loadPublicReadiness(admin, studio.id);
  if (!ready.bookable) {
    return { ok: false, error: UNAVAILABLE_PUBLIC_BOOKING_MESSAGE };
  }

  const { data: service, error } = await admin
    .from("services")
    .select("default_duration_minutes")
    .eq("id", params.serviceId)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (error) {
    // P0 (Blocker 5): public booking surfaces never return raw
    // Postgres error text. Log internally and surface the
    // sanitized generic constant.
    logInternalBookingError("public_slots_service_lookup_failed", {
      code: error.code,
      message: error.message,
    });
    return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
  }
  if (!service) return { ok: false, error: "Service not found." };

  const slots = await getAvailableSlots(
    admin,
    {
      id: studio.id,
      timezone: studio.timezone,
      default_appointment_duration_minutes:
        studio.default_appointment_duration_minutes,
      buffer_minutes: studio.buffer_minutes,
    },
    params.date,
    service.default_duration_minutes,
  );
  // Public-only past-time guard: never offer a slot whose start instant is
  // already in the past (today's earlier hours). Absolute UTC comparison —
  // slot.start is an ISO instant — so a slot starting even a minute from now
  // still shows; only start <= now is dropped. No lead-time buffer here.
  // The shared getAvailableSlots() is untouched, so the internal calendar
  // quick-book drawer (app/(app)/calendar/actions.ts) is unaffected.
  const nowMs = Date.now();
  const futureSlots = slots.filter((s) => new Date(s.start).getTime() > nowMs);
  return { ok: true, slots: futureSlots };
}

// ---------------------------------------------------------------------------
// fetchNextAvailableDateAction
// ---------------------------------------------------------------------------
// Server-side "Next available" lookup for the public booking page. Walks
// forward from `fromDate` (inclusive, clamped to today) through the studio's
// public booking horizon and returns the first date that has at least one
// future-instant slot for the requested service.
//
// Why server-side: avoids 90 sequential client roundtrips for a 3-month
// horizon. One client call -> one server action -> bounded server loop.
//
// Algorithm: linear day-by-day scan from `from` to horizon.maxDateStr,
// calling getAvailableSlots per day and applying the same past-time filter
// fetchPublicSlotsAction uses. Returns the first date with a non-empty
// future-slot list, or `date: null` if the horizon is exhausted.
//
// Worst case: horizon days (3-month = ~92, 4-month = ~123, 6-month = ~184)
// getAvailableSlots calls, hard-capped by MAX_NEXT_AVAILABLE_SCAN_DAYS as a
// belt-and-braces safety. Each getAvailableSlots is a single bounded
// admin-scoped read of the day's overrides/blockouts/appointments; total
// cost is O(N) cheap queries within one server roundtrip.
//
// Boundaries preserved: same rate limiter as fetchPublicSlotsAction;
// same soft-gate (loadPublicReadiness); same past-time filter; no booking
// engine / conflict logic changes.
// ---------------------------------------------------------------------------

const MAX_NEXT_AVAILABLE_SCAN_DAYS = 200;

export async function fetchNextAvailableDateAction(params: {
  slug: string;
  serviceId: string;
  fromDate: string;
}): Promise<
  { ok: true; date: string | null } | { ok: false; error: string }
> {
  const slotGate = await limitPublicSlots({
    headers: await headers(),
    slug: params.slug,
  });
  if (!slotGate.allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  const studio = await getStudioBySlug(params.slug);
  if (!studio) return { ok: false, error: "Studio not found." };

  const admin = createAdminClient();

  // Soft-gate: same predicate the page + other actions use.
  const ready = await loadPublicReadiness(admin, studio.id);
  if (!ready.bookable) {
    return { ok: false, error: UNAVAILABLE_PUBLIC_BOOKING_MESSAGE };
  }

  const { data: service, error: svcErr } = await admin
    .from("services")
    .select("default_duration_minutes")
    .eq("id", params.serviceId)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (svcErr) {
    logInternalBookingError("public_next_available_service_lookup_failed", {
      code: svcErr.code,
      message: svcErr.message,
    });
    return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
  }
  if (!service) return { ok: false, error: "Service not found." };

  const today = todayInTz(studio.timezone);
  const horizon = horizonRangeInStudioTz(
    studio.timezone,
    studio.public_booking_horizon_months,
  );

  // Start at max(fromDate, today). A past fromDate (e.g. from a stale
  // client) would otherwise scan dates that fetchPublicSlotsAction
  // already rejects via the horizon check.
  const startDate =
    params.fromDate < today ? today : params.fromDate;
  if (startDate > horizon.maxDateStr) {
    return { ok: true, date: null };
  }

  const nowMs = Date.now();
  let cursor = startDate;
  let scans = 0;
  while (cursor <= horizon.maxDateStr && scans < MAX_NEXT_AVAILABLE_SCAN_DAYS) {
    scans += 1;
    const slots = await getAvailableSlots(
      admin,
      {
        id: studio.id,
        timezone: studio.timezone,
        default_appointment_duration_minutes:
          studio.default_appointment_duration_minutes,
        buffer_minutes: studio.buffer_minutes,
      },
      cursor,
      service.default_duration_minutes,
    );
    const futureSlots = slots.filter(
      (s) => new Date(s.start).getTime() > nowMs,
    );
    if (futureSlots.length > 0) {
      return { ok: true, date: cursor };
    }
    cursor = addDays(cursor, 1);
  }
  return { ok: true, date: null };
}

export type PublicBookResult =
  | { ok: true; appointmentId: string }
  | { ok: false; error: string; code?: "slot_taken" };

export async function publicBookAppointmentAction(formData: FormData): Promise<PublicBookResult> {
  const slug = trimmed(formData.get("slug"));
  const serviceId = trimmed(formData.get("service_id"));
  const startsAtRaw = trimmed(formData.get("starts_at"));
  const name = trimmed(formData.get("name"));
  const email = trimmed(formData.get("email")).toLowerCase();
  const phone = nullable(formData.get("phone"));
  const notes = nullable(formData.get("notes"));

  if (!slug || !serviceId || !startsAtRaw)
    return { ok: false, error: "Missing booking details." };
  if (!name) return { ok: false, error: "Your name is required." };
  if (!EMAIL_RE.test(email))
    return { ok: false, error: "Enter a valid email address." };
  // Phone required for new public booking submissions. The existing-
  // client lookup below intentionally never writes the submitted phone
  // back onto an existing clients row (security: prevents a public
  // booker from injecting a phone into someone else's record), so this
  // requirement does NOT retroactively break legacy clients whose
  // stored phone is null. Internal practitioner booking goes through a
  // separate code path and is not affected.
  if (!phone) {
    return { ok: false, error: "Please enter a phone number." };
  }

  // Rate limit (v1) BEFORE any DB read/write or email send. Stricter than
  // slot fetch: 5/10min per (IP, slug) + 3/hour per (email, slug). Fails
  // open when Upstash is unconfigured or down — a limiter outage must never
  // block a real booking. No appointment is created and no email is sent
  // when limited.
  const bookGate = await limitPublicBooking({
    headers: await headers(),
    slug,
    email,
  });
  if (!bookGate.allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  const studio = await getStudioBySlug(slug);
  if (!studio) return { ok: false, error: "Studio not found." };

  const start = new Date(startsAtRaw);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: "Invalid time." };
  }
  if (
    !isWithinPublicBookingHorizon(
      start,
      studio.timezone,
      studio.public_booking_horizon_months,
    )
  ) {
    return { ok: false, error: "That date is outside the booking window." };
  }

  // Public-only past-time guard: reject a start instant at or before now,
  // before any DB write or email. Absolute UTC comparison (start is parsed
  // from the submitted ISO). The horizon check above allows "today", so a
  // today-but-already-passed slot is caught here. Existing slot
  // re-verification and DB conflict handling below are unchanged.
  if (start.getTime() <= Date.now()) {
    return {
      ok: false,
      error: "That time is no longer available. Please choose another time.",
    };
  }

  const admin = createAdminClient();

  // Self-serve publish soft-gate (defense in depth): refuse booking
  // submissions to studios that aren't publicly bookable yet. The
  // /book/[slug] page renders a calm equivalent message when this is
  // true, so a UI submission only reaches here if the caller bypassed
  // the rendered surface. Same sanitized copy as the slot probe.
  const ready = await loadPublicReadiness(admin, studio.id);
  if (!ready.bookable) {
    return { ok: false, error: UNAVAILABLE_PUBLIC_BOOKING_MESSAGE };
  }

  const { data: service } = await admin
    .from("services")
    .select("*")
    .eq("id", serviceId)
    .eq("studio_id", studio.id)
    .eq("active", true)
    .maybeSingle();
  if (!service) return { ok: false, error: "Service no longer available." };

  // Re-verify slot is free. Use the studio's local date, not the
  // UTC date: a 10pm Toronto booking would otherwise look up slots
  // for the next calendar day.
  const dateStr = localDateString(start, studio.timezone);
  const slots = await getAvailableSlots(
    admin,
    {
      id: studio.id,
      timezone: studio.timezone,
      default_appointment_duration_minutes:
        studio.default_appointment_duration_minutes,
      buffer_minutes: studio.buffer_minutes,
    },
    dateStr,
    service.default_duration_minutes,
  );
  const free = slots.some((s) => new Date(s.start).getTime() === start.getTime());
  if (!free) {
    return {
      ok: false,
      error: "That time is no longer available. Please choose another time.",
    };
  }

  const end = new Date(start.getTime() + service.default_duration_minutes * 60_000);

  // P0-5: match existing client by EXACT normalized_email equality on
  // the clients.normalized_email generated column installed by migration
  // 0032. ILIKE matching is unsafe for payment / identity flows because
  // it folds whitespace + casing inconsistently and can return the
  // wrong row in the presence of near-duplicates. The unique index
  // clients_studio_normalized_email_uniq backs this lookup.
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const { data: existingClient, error: lookupErr } = await admin
    .from("clients")
    .select("id, name, email, phone")
    .eq("studio_id", studio.id)
    .eq("normalized_email", normalizedEmail)
    .maybeSingle();
  if (lookupErr) {
    logInternalBookingError("public_booking_client_lookup_failed", {
      code: lookupErr.code,
      message: lookupErr.message,
    });
    return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
  }

  let clientId: string;
  let clientName: string;
  let clientPhone: string | null;
  if (existingClient) {
    // P0 hardening: an unauthenticated public booking MUST NOT
    // modify the existing client's clinical/profile record. The
    // previous "backfill phone if newly provided" code allowed a
    // public booker who knows a real client's email to inject a
    // phone number into that client's record without proving
    // ownership of the account.
    //
    // We use the existing client's stored name + phone exactly as
    // they are on file. The submitted public `name` / `phone`
    // values are NOT written back to the clients row. They are
    // still allowed to flow into the appointment / notes for THIS
    // appointment (so a re-typed display name in a confirmation
    // email reflects what the booker entered), but the stored
    // identity record is left intact.
    //
    // To update a client's stored demographics, an authenticated
    // practitioner must edit the record from the in-app client
    // page. A future verified-account-ownership flow (e.g. a
    // signed magic-link to claim or merge a client identity) is
    // a separate, scoped change that has NOT been made in this
    // branch.
    clientId = existingClient.id;
    clientName = existingClient.name;
    clientPhone = existingClient.phone;
  } else {
    const { data: createdClient, error: clientErr } = await admin
      .from("clients")
      .insert({
        studio_id: studio.id,
        name,
        email,
        phone,
      })
      .select("id, name, email, phone")
      .single();
    if (clientErr || !createdClient) {
      // Race-safe path: a concurrent booking from the same email may
      // have inserted between our SELECT above and this INSERT. The
      // clients_studio_normalized_email_uniq partial unique index
      // raises sqlstate 23505. Re-read the winning row and continue.
      if (clientErr?.code === "23505") {
        const { data: winner } = await admin
          .from("clients")
          .select("id, name, email, phone")
          .eq("studio_id", studio.id)
          .eq("normalized_email", normalizedEmail)
          .maybeSingle();
        if (winner) {
          clientId = winner.id;
          clientName = winner.name;
          clientPhone = winner.phone ?? phone;
        } else {
          logInternalBookingError("public_booking_unique_race_unresolved", {
            studioId: studio.id,
            normalizedEmail,
            code: clientErr.code,
            message: clientErr.message,
          });
          return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
        }
      } else {
        logInternalBookingError("public_booking_client_insert_failed", {
          code: clientErr?.code,
          message: clientErr?.message,
        });
        return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
      }
    } else {
      clientId = createdClient.id;
      clientName = createdClient.name;
      clientPhone = createdClient.phone;
    }
  }

  // Find the owner practitioner to attribute the appointment to + notify.
  const { data: owner } = await admin
    .from("practitioners")
    .select("id, display_name, email")
    .eq("studio_id", studio.id)
    .eq("active", true)
    .eq("role", "owner")
    .maybeSingle();

  const appointmentToken = generateAppointmentToken();
  const { data: created, error: insertErr } = await admin
    .from("appointments")
    .insert({
      studio_id: studio.id,
      practitioner_id: owner?.id ?? null,
      client_id: clientId,
      service_id: serviceId,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      duration_minutes: service.default_duration_minutes,
      status: "confirmed",
      notes,
      cancellation_token: appointmentToken,
    })
    .select("*")
    .single();
  if (insertErr || !created) {
    // sqlstate 23P01 = exclusion_violation. Fires when the
    // no_overlapping_active_appointments_per_studio constraint
    // catches a race the UI-layer slot check could not. A rejected
    // booking must NOT trigger a confirmation email, so we return
    // before any send path.
    if (insertErr?.code === "23P01") {
      console.error(
        JSON.stringify({
          event: "booking_slot_collision",
          studioId: studio.id,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          source: "public_booking",
          timestamp: new Date().toISOString(),
        }),
      );
      return {
        ok: false,
        error: "That time is no longer available. Please choose another time.",
        code: "slot_taken",
      };
    }
    logInternalBookingError("public_booking_insert_failed", {
      code: insertErr?.code,
      message: insertErr?.message,
    });
    return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
  }

  await admin.from("appointment_audit").insert({
    appointment_id: created.id,
    actor_type: "client",
    actor_id: null,
    action: "created",
    details: { source: "public_booking", email, notes },
  });

  // Emails. New confirmation + reminder + reschedule URLs use the random
  // appointment_token column; legacy /cancel/[hmac] route still validates
  // older in-flight links.
  const cancellationUrl = `${APP_ORIGIN}/cancel/${appointmentToken}`;
  const rescheduleUrl = `${APP_ORIGIN}/reschedule/${appointmentToken}`;
  // Note: the HMAC-fallback generateCancellationToken() call previously
  // sat here purely to keep the import "used". It has been removed; the
  // public booking flow now depends exclusively on
  // generateAppointmentToken() above (writing the column-based token
  // onto appointments.cancellation_token). Legacy HMAC links remain
  // verifiable on the /cancel/[token] route via verifyCancellationToken
  // inside the resolver, but no new HMAC links are minted here.

  // Ensure an in-progress intake exists for this client and attach the link
  // to the confirmation email. Returns null if they already have a submitted
  // or reviewed intake on file, in which case the email omits the section.
  const intake = await ensureIntakeForClient({
    studioId: studio.id,
    clientId,
    appOrigin: APP_ORIGIN,
  });

  // Studio toggle: skip the confirmation email entirely if disabled.
  // Email reporting is truthful: recordEmailAttempt atomically increments
  // confirmation_send_attempts AND stamps confirmation_sent_at only when
  // the Resend call actually succeeded. The old code path stamped the
  // timestamp unconditionally, which falsely advertised delivery.
  if (studio.send_confirmation_emails) {
    const treatmentTimeLine = studio.show_treatment_time_to_clients
      ? buildTreatmentTimeLine({
          enabled: true,
          clientFirstName: clientName.split(/\s+/)[0] || clientName,
          context: await getTreatmentTimeContextForEmail(studio.id, clientId),
        })
      : null;
    const result = await sendBookingConfirmationToClient({
      appointment: created,
      service,
      studio,
      practitionerDisplayName:
        owner?.display_name?.trim() || owner?.email || studio.name,
      clientName,
      clientEmail: email,
      cancellationUrl,
      rescheduleUrl,
      intakeUrl: intake?.url ?? null,
      treatmentTimeLine,
      appBaseUrl: APP_ORIGIN,
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
  }
  // Migration 0047: studio owners can opt out of the practitioner
  // new-booking notification. Default true preserves existing
  // behavior. Client confirmation email above is gated separately
  // via send_confirmation_emails and is NOT affected by this toggle.
  if (owner?.email && studio.notify_practitioner_on_new_booking !== false) {
    await sendBookingNotificationToPractitioner({
      appointment: created,
      service,
      studio,
      practitionerName:
        owner.display_name?.trim() || owner.email || "Practitioner",
      practitionerEmail: owner.email,
      clientName,
      clientEmail: email,
      clientPhone,
      notes,
      appointmentUrl: `${APP_ORIGIN}/calendar/${created.id}`,
    });
  }

  revalidatePath("/calendar");
  revalidatePath("/calendar/upcoming");
  return { ok: true, appointmentId: created.id };
}

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
function nullable(value: FormDataEntryValue | null): string | null {
  const t = trimmed(value);
  return t.length === 0 ? null : t;
}

// Public booking readiness probe. Two small admin-scoped reads:
//   * head:true exact count on services where active=true
//   * the day-of-week defaults marked is_open with both times present
// Mirrors the dashboard checklist and the /book/[slug] page gate, so
// every public surface enforces the same predicate.
async function loadPublicReadiness(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
): Promise<{ bookable: boolean }> {
  const [{ count: activeServicesCount }, { data: availabilityRows }] =
    await Promise.all([
      admin
        .from("services")
        .select("id", { count: "exact", head: true })
        .eq("studio_id", studioId)
        .eq("active", true),
      admin
        .from("studio_availability_default")
        .select("is_open,open_time,close_time")
        .eq("studio_id", studioId)
        .eq("is_open", true),
    ]);
  const openAvailabilityDaysCount = (availabilityRows ?? []).filter(
    (d) =>
      d.is_open === true &&
      typeof d.open_time === "string" &&
      typeof d.close_time === "string",
  ).length;
  return {
    bookable: isPubliclyBookable({
      activeServicesCount: activeServicesCount ?? 0,
      openAvailabilityDaysCount,
    }),
  };
}
