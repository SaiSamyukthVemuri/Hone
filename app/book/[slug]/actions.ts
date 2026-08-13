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
import {
  filterFutureSlots,
  getAvailableSlots,
  type Slot,
} from "@/lib/booking/slots";
import {
  isPubliclyBookable,
  UNAVAILABLE_PUBLIC_BOOKING_MESSAGE,
} from "@/lib/booking/readiness";
import {
  generateAppointmentToken,
  hashAppointmentToken,
} from "@/lib/booking/appointment-token";
import type { ConfirmationEmailStatus } from "@/lib/booking/confirmation-presentation";
import {
  parseReferralSource,
  referralSourceLabel,
} from "@/lib/booking/referral-source";
import { localTimeString12h } from "@/lib/booking/tz";
import { recordPractitionerNotification } from "@/lib/notifications/practitioner-notifications";
import { addDays, localDateString, todayInTz } from "@/lib/booking/tz";
import {
  horizonRangeInStudioTz,
  isWithinPublicBookingHorizon,
  maxPublicBookingHorizonDays,
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
import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";
import { normalizePhoneForMatch } from "@/lib/sms/twilio";
import { isConsultationService } from "@/lib/booking/consultation";
import {
  buildBookingMarketingConsentRow,
  MARKETING_CONSENT_FIELD,
  parseMarketingConsent,
} from "@/lib/booking/marketing-consent";
import { dispatchBookingConversion } from "@/lib/conversion/dispatch";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { captureServerEvent } from "@/lib/analytics/server";
// PR #261: salted SHA-256 fingerprint helper reused for public booking
// error logs so a raw client email never lands in server logs while
// repeated failures stay correlatable. Same helper + salt the portal
// magic-link logs already use (app/portal/login/actions.ts), so the
// same email yields the same fingerprint across surfaces.
import { hashFingerprint } from "@/lib/portal/tokens";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Generic public booking error. Returned for all non-success outcomes
// where the underlying error originated from the database, an internal
// dependency, or any condition that an unauthenticated public caller
// has no business probing. Use raw error strings only for caller-input
// validation (e.g. missing email).
const PUBLIC_BOOKING_GENERIC_ERROR =
  "We couldn't complete your booking. Please try again or contact the studio.";

// Returned when an unauthenticated public booking attempts to use an
// email address that is owned by a client the studio has archived
// (migration 0050 + PR #113). We deliberately do NOT reveal that an
// archived client exists or invite the booker to retry with different
// details that would unmask the archive: that would re-introduce a
// soft enumeration channel. The wording matches the spec and stays
// generic. studio.name is interpolated at call time.
function archivedClientCollisionError(studioName: string): string {
  return `We couldn't complete this booking with those details. Please contact ${studioName} or use a different email.`;
}

// Returned when an unauthenticated public booking with
// client_type=existing cannot find an ACTIVE client by normalized
// email in the studio. Same message regardless of whether the email
// is unknown OR belongs to an archived client; the archived path
// naturally falls through to "no active match" because the lookup
// already filters archived_at IS NULL. Keeping a single generic
// string preserves the no-enumeration guarantee.
const EXISTING_CLIENT_NO_MATCH_ERROR =
  "We couldn't match this as an existing client. Please book a consultation as a new client or contact the studio.";

// Returned when client_type=new attempts to book a service that is
// not a consultation. Explicit phrasing so the visitor understands
// the constraint without exposing any record state.
const NEW_CLIENT_MUST_BOOK_CONSULTATION_ERROR =
  "New clients must book a consultation first.";

// Returned when client_type is missing, unknown, or otherwise not in
// the {new, existing} set. The new UI always sends one of those two;
// any other value should be treated as a stale/forged request and get
// the same generic error a missing field would produce. A no-
// consultation-service condition is surfaced at the UI layer instead
// of here because the existing isConsultationService guard below
// already rejects any forged new-client submit that picked a
// non-consultation service id, which is the only way a no-
// consultation studio could reach this action with client_type=new.
const MISSING_CLIENT_TYPE_ERROR =
  "Please choose whether you are a new or existing client.";

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
    // PR #261: keep the sqlstate code (non-PII ops signal) + studioId
    // for correlation; drop the raw Postgres message (can echo
    // submitted values on a public surface).
    logInternalBookingError("public_slots_service_lookup_failed", {
      code: error.code,
      studioId: studio.id,
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
  // already in the past (today's earlier hours). Shared helper in
  // lib/booking/slots.ts so public booking + public reschedule cannot
  // drift apart (PR #149). No lead-time buffer here.
  // The shared getAvailableSlots() is untouched, so the internal calendar
  // quick-book drawer (app/(app)/calendar/actions.ts) is unaffected.
  return { ok: true, slots: filterFutureSlots(slots) };
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

// Belt-and-braces cap on the next-available scan. Derived from the largest
// configurable horizon (12 months = 372 days) plus a small margin, so the scan
// always reaches the full horizon a studio can configure and never truncates.
const MAX_NEXT_AVAILABLE_SCAN_DAYS = maxPublicBookingHorizonDays() + 14;

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
    // PR #261: sqlstate code + studioId only; drop raw DB message.
    logInternalBookingError("public_next_available_service_lookup_failed", {
      code: svcErr.code,
      studioId: studio.id,
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

  // Capture `now` ONCE before the loop so every iteration's
  // future-filter uses a single clock reading (shared helper in
  // lib/booking/slots.ts, PR #149).
  const nowRef = new Date();
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
    const futureSlots = filterFutureSlots(slots, nowRef);
    if (futureSlots.length > 0) {
      return { ok: true, date: cursor };
    }
    cursor = addDays(cursor, 1);
  }
  return { ok: true, date: null };
}

// BOOK-01 Tranche 1. A COMMITTED booking now returns the client's management
// URL and the TRUE confirmation-email outcome, so the browser that created the
// appointment always leaves with a working path to it — exactly the contract
// the reschedule surface has carried since the 0171 amendment
// (app/reschedule/[token]/actions.ts:598-617).
//
// `manageUrl` goes ONLY to that authorised browser. It is built from the raw
// token this request minted, and the command stored only that token's SHA-256,
// so the URL is never persisted, never logged, never put in an analytics event,
// an ops alert, an audit row or an error message.
//
// SCOPE, STATED HONESTLY: this closes the case where the appointment commits
// and the provider then fails or is switched off. It does NOT cover the process
// dying after COMMIT but before this response reaches the browser — there is no
// response in that case. That case remains covered by the existing recovery
// paths (the authenticated client portal, which mints its own HMAC management
// token per appointment, and the 24h/2h reminder passes, whose window query
// never consults `confirmation_sent_at`). Tranche 1 does not claim otherwise.
export type PublicBookResult =
  | {
      ok: true;
      appointmentId: string;
      manageUrl: string;
      confirmationEmailStatus: ConfirmationEmailStatus;
    }
  | { ok: false; error: string; code?: "slot_taken" };

export async function publicBookAppointmentAction(formData: FormData): Promise<PublicBookResult> {
  const slug = trimmed(formData.get("slug"));
  const serviceId = trimmed(formData.get("service_id"));
  const startsAtRaw = trimmed(formData.get("starts_at"));
  const name = trimmed(formData.get("name"));
  const email = trimmed(formData.get("email")).toLowerCase();
  // SMS consent checkbox (PR Twilio v1). Opt-in only; the field is
  // absent on older form posts. False keeps the existing email-only
  // flow intact. The server-side consent gate below decides whether
  // a "true" here actually stamps sms_consent_at.
  const smsConsent = formData.get("sms_consent") === "true";
  // Optional marketing/analytics consent (opt-in; false unless explicitly
  // checked). Captured after a successful booking; declining never blocks it.
  const marketingConsent = parseMarketingConsent(
    formData.get(MARKETING_CONSENT_FIELD),
  );
  const phone = nullable(formData.get("phone"));
  const notes = nullable(formData.get("notes"));
  // PR #163. "How did you hear about us?" optional answer. Empty
  // string -> null. Non-empty value MUST be in the canonical option
  // set; an unknown value throws synchronously and surfaces as the
  // generic public booking error below so a probing caller cannot
  // enumerate the option set via the form. Validation lives in
  // lib/booking/referral-source.ts so the form, the action, and
  // every reader stay in sync.
  let referralSource: string | null = null;
  try {
    referralSource = parseReferralSource(formData.get("referral_source"));
  } catch {
    return {
      ok: false,
      error: "We couldn't read your booking form. Please refresh and try again.",
    };
  }

  // Public booking new/existing split. The first-step UI choice is
  // posted as client_type and is the source of truth for two rules:
  //   * client_type = "new" requires a consultation service.
  //   * client_type = "existing" requires an active (non-archived)
  //     client to already exist in the studio under the submitted
  //     normalized email; the action MUST NOT create a new client
  //     here and MUST NOT reveal whether the email exists in an
  //     archived row.
  // An older client (pre-PR public form, replayed cache, etc.) that
  // omits client_type is rejected with the same generic missing-
  // choice message; we never silently fall back to the old "new or
  // existing" lookup because that path would let an existing-client
  // intent be silently downgraded to a new-client insert. The error
  // is generic so a probing visitor cannot tell which field was
  // missing.
  const rawClientType = trimmed(formData.get("client_type"));
  const clientType: "new" | "existing" | null =
    rawClientType === "new"
      ? "new"
      : rawClientType === "existing"
        ? "existing"
        : null;
  if (clientType == null) {
    return { ok: false, error: MISSING_CLIENT_TYPE_ERROR };
  }

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

  // New-client consultation guard. Server is the source of truth: the
  // UI filters the picker to consultation services when client_type
  // is "new", but a forged or replayed form post could still submit
  // any active service id. The same predicate is shared by the UI
  // helper (lib/booking/consultation.ts) so the visible list and the
  // server gate cannot drift apart. Rejected attempts surface the
  // explicit copy from the spec; no internal state is leaked.
  if (clientType === "new" && !isConsultationService(service)) {
    return { ok: false, error: NEW_CLIENT_MUST_BOOK_CONSULTATION_ERROR };
  }

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

  // Active-only existing-client lookup. Archived clients (migration
  // 0050) MUST NOT match here. If they did, a public booker who knows
  // an archived client's email could attach a brand new appointment
  // to the archived row, and the appointment would then disappear
  // from Chloe's active client list because the parent client is
  // hidden. The archived-collision case is detected below in the
  // 23505 race-fallback branch, where we re-read the unique-index
  // winner WITHOUT this filter so we can distinguish "no winner" from
  // "winner is archived" and return a non-revealing error.
  const { data: existingClient, error: lookupErr } = await admin
    .from("clients")
    .select("id, name, email, phone, sms_consent_at, sms_opted_out_at")
    .eq("studio_id", studio.id)
    .eq("normalized_email", normalizedEmail)
    .is("archived_at", null)
    .maybeSingle();
  if (lookupErr) {
    // PR #261: sqlstate code + studioId + salted email fingerprint;
    // drop raw DB message. The fingerprint correlates repeated
    // failures for one booker without writing their raw email.
    logInternalBookingError("public_booking_client_lookup_failed", {
      code: lookupErr.code,
      studioId: studio.id,
      emailFingerprint: hashFingerprint(normalizedEmail),
    });
    return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
  }

  let clientId: string;
  let clientName: string;
  let clientPhone: string | null;
  // SMS consent state used by the SMS confirmation attempt at the
  // bottom. Tracked through both client branches so the dispatch
  // logic below has a stable view regardless of whether the client
  // was new or existing. Existing-client opt-out is preserved as-is;
  // only consent_at can be stamped from this public surface.
  let clientSmsConsentAt: string | null = null;
  let clientSmsOptedOutAt: string | null = null;

  // No-enumeration gate for the existing-client path. When the
  // visitor said "I am an existing client" but the studio has no
  // ACTIVE client under this email, the action MUST NOT silently
  // insert a new row, MUST NOT reveal that an archived row exists,
  // and MUST NOT acknowledge any internal state. The same generic
  // error is returned whether the email is unknown OR archived
  // (archived rows naturally fall through to "no active match"
  // because the lookup above filters archived_at IS NULL). New
  // clients still take the INSERT path below; the existing-client
  // path can only succeed when existingClient is truthy.
  if (clientType === "existing" && !existingClient) {
    return { ok: false, error: EXISTING_CLIENT_NO_MATCH_ERROR };
  }
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
    clientSmsConsentAt = existingClient.sms_consent_at ?? null;
    clientSmsOptedOutAt = existingClient.sms_opted_out_at ?? null;

    // SMS consent stamp for existing clients is gated by two rules:
    //   1. The client must not already be opted out (STOP is sticky).
    //   2. The submitted phone must normalize to the same digits as
    //      the stored phone. Without this, anyone who knows a real
    //      client's email could opt them into SMS by typing a
    //      different phone number on the public form.
    // We also do not overwrite an already-set sms_consent_at; the
    // earlier source-of-truth wins.
    if (
      smsConsent &&
      clientSmsOptedOutAt == null &&
      clientSmsConsentAt == null
    ) {
      const submittedDigits = normalizePhoneForMatch(phone);
      const storedDigits = normalizePhoneForMatch(existingClient.phone);
      if (
        submittedDigits.length > 0 &&
        submittedDigits === storedDigits
      ) {
        const nowIso = new Date().toISOString();
        const { error: consentErr } = await admin
          .from("clients")
          .update({
            sms_consent_at: nowIso,
            sms_consent_source: "public_booking",
          })
          .eq("id", clientId);
        if (consentErr) {
          // Soft fail. The booking and the email path must not break
          // because of a consent-stamp error; future bookings can
          // re-attempt. We log a sanitized error and proceed.
          // PR #261: sqlstate code + studioId + salted email
          // fingerprint; drop raw DB message.
          logInternalBookingError("public_booking_sms_consent_update_failed", {
            code: consentErr.code,
            studioId: studio.id,
            emailFingerprint: hashFingerprint(normalizedEmail),
          });
        } else {
          clientSmsConsentAt = nowIso;
        }
      }
    }
  } else {
    // New client. If smsConsent is true, stamp consent_at immediately
    // with source "public_booking" -- there is no prior phone to
    // protect (this row is being created right now) so the gate is
    // strictly the checkbox plus a normalizable phone, both of which
    // were submitted by the same form post. Building the row with a
    // base + conditional spread keeps Supabase's column-type inference
    // happy across the two branches.
    const nowIso = new Date().toISOString();
    const newClientRow = {
      studio_id: studio.id,
      name,
      email,
      phone,
      ...(smsConsent
        ? {
            sms_consent_at: nowIso,
            sms_consent_source: "public_booking" as const,
          }
        : {}),
    };
    const { data: createdClient, error: clientErr } = await admin
      .from("clients")
      .insert(newClientRow)
      .select("id, name, email, phone, sms_consent_at, sms_opted_out_at")
      .single();
    if (clientErr || !createdClient) {
      // Race-safe path: the clients_studio_normalized_email_uniq
      // partial unique index raises sqlstate 23505 when our INSERT
      // collides on (studio_id, normalized_email). The winning row is
      // either:
      //   (a) an ACTIVE client created by a concurrent booking from
      //       the same email (the original race-fallback case), or
      //   (b) an ARCHIVED client (migration 0050) that owns the same
      //       email. The initial lookup filters archived clients, so
      //       case (b) falls through to the INSERT, which then trips
      //       the unique index because the index is on the bare
      //       normalized_email column (archived rows still occupy
      //       their slot in the index).
      //
      // We re-read the winner WITHOUT the archived filter so we can
      // distinguish (a) from (b). If the winner is archived, we
      // refuse the booking with a generic non-revealing error -- we
      // never attach a public appointment to an archived client,
      // never auto-unarchive from a public surface, and never reveal
      // to the booker that the email belongs to an archived row.
      if (clientErr?.code === "23505") {
        const { data: winner } = await admin
          .from("clients")
          .select(
            "id, name, phone, sms_consent_at, sms_opted_out_at, archived_at",
          )
          .eq("studio_id", studio.id)
          .eq("normalized_email", normalizedEmail)
          .maybeSingle();
        if (winner && winner.archived_at != null) {
          // Archived-collision case. Log internally so an operator
          // can see what happened; return a generic message that
          // does not reveal the archive.
          // PR #261: never write the raw booker email or the internal
          // archived client UUID to logs from this unauthenticated
          // path. The salted email fingerprint preserves operator
          // correlation; archivedClientCollision flags the case without
          // re-introducing the archive-enumeration linkage the visitor
          // message deliberately hides.
          logInternalBookingError("public_booking_archived_client_collision", {
            studioId: studio.id,
            emailFingerprint: hashFingerprint(normalizedEmail),
            archivedClientCollision: true,
          });
          return {
            ok: false,
            error: archivedClientCollisionError(studio.name),
          };
        }
        if (winner) {
          clientId = winner.id;
          clientName = winner.name;
          clientPhone = winner.phone ?? phone;
          clientSmsConsentAt = winner.sms_consent_at ?? null;
          clientSmsOptedOutAt = winner.sms_opted_out_at ?? null;
        } else {
          // PR #261: keep the sqlstate code (the diagnostic that
          // matters for an unresolved unique-index race) + studioId +
          // salted email fingerprint; drop the raw booker email and the
          // raw DB message.
          logInternalBookingError("public_booking_unique_race_unresolved", {
            studioId: studio.id,
            emailFingerprint: hashFingerprint(normalizedEmail),
            code: clientErr.code,
          });
          return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
        }
      } else {
        // PR #261: sqlstate code + studioId + salted email fingerprint;
        // drop raw DB message.
        logInternalBookingError("public_booking_client_insert_failed", {
          code: clientErr?.code,
          studioId: studio.id,
          emailFingerprint: hashFingerprint(normalizedEmail),
        });
        return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
      }
    } else {
      clientId = createdClient.id;
      clientName = createdClient.name;
      clientPhone = createdClient.phone;
      clientSmsConsentAt = createdClient.sms_consent_at ?? null;
      clientSmsOptedOutAt = createdClient.sms_opted_out_at ?? null;
    }
  }

  // BOOK-01 P2-B. REQUIRED CONFIGURATION IS RESOLVED BEFORE THE DURABILITY
  // BOUNDARY. `getRequiredAppOrigin()` THROWS by design when
  // NEXT_PUBLIC_APP_ORIGIN is absent in production (lib/app-origin.ts:38-46) —
  // it deliberately offers no hone.care or localhost fallback, because a
  // wrong-domain link mailed to a real client is worse than a refusal. This
  // call used to sit ~250 lines BELOW the command, so a missing origin threw
  // AFTER the appointment and its audit row had committed: the booking existed,
  // the client saw an error, and no management URL was ever produced.
  //
  // Resolved here, the same misconfiguration refuses cleanly and durably:
  // nothing is committed, no audit row, no token hash persisted, no
  // client-facing success. It is a deterministic config failure, so failing
  // closed before the write is the only honest order. Mirrors the reschedule
  // surface, which already resolves the origin before minting its successor
  // token (app/reschedule/[token]/actions.ts:744-754).
  let appOrigin: string;
  try {
    appOrigin = getRequiredAppOrigin();
  } catch (err) {
    const errorClass = err instanceof Error ? err.name : "unknown";
    logInternalBookingError("public_booking_app_origin_unresolved", {
      studioId: studio.id,
      errorClass,
    });
    return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
  }

  const appointmentToken = generateAppointmentToken();
  // Migration 0170. The appointment and its MANDATORY appointment_audit row are
  // created by one command, in one transaction. Previously this route inserted
  // the appointment here and the audit row ~80 lines later in a second
  // statement whose error was discarded, so a confirmed public booking could
  // exist with no audit trail — production carries exactly one such row.
  //
  // Everything authoritative is derived inside the command from current
  // database state: duration from the LOCKED service row, end time from that
  // duration, status, the owner practitioner, and the capacity/buffer columns
  // (trigger-derived). There is no parameter for a custom duration, an
  // outside-hours override, or a status, so this caller cannot request one. The
  // command re-validates studio/client/service tenancy and the full public
  // availability contract under the studio lock, independently of the slot
  // re-check above.
  const { data: rpcRows, error: rpcErr } = await admin.rpc(
    "create_public_appointment",
    {
      p_studio_id: studio.id,
      p_client_id: clientId,
      p_service_id: serviceId,
      p_starts_at: start.toISOString(),
      p_cancellation_token_hash: hashAppointmentToken(appointmentToken),
      p_notes: notes,
      p_referral_source: referralSource,
    },
  );
  const commandRow = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const commandResult = (commandRow?.result as string | undefined) ?? null;
  const createdId =
    commandResult === "created" && commandRow?.appointment_id
      ? (commandRow.appointment_id as string)
      : null;
  // Authoritative row timestamp, straight from the command's own INSERT.
  const createdAtIso = (commandRow?.created_at as string | undefined) ?? null;

  // Expected business refusals come back as closed result codes, never as a
  // thrown Postgres error. Each maps to copy the visitor already sees today; a
  // code we do not recognise falls through to the generic message rather than
  // leaking anything about why.
  if (!rpcErr && commandResult && commandResult !== "created") {
    // Exactly the codes the command can emit for an unavailable time. It
    // reports every collision (overlap, buffer, block, break) as
    // `time_unavailable`, so there is no separate `buffer_conflict` to map.
    //
    // `not_a_public_slot` belongs HERE, not in the operator bucket below. It
    // means the submitted instant is no longer an offered slot — which is
    // exactly what a visitor sees when a conflict is cancelled between this
    // action's slot re-check and the command taking the studio lock, removing an
    // after-conflict anchor. That visitor should be told to pick another time,
    // not handed a generic "contact the studio" dead end.
    const SLOT_TAKEN_CODES = new Set([
      "time_unavailable",
      "outside_availability",
      "studio_closed",
      "invalid_time",
      "not_a_public_slot",
    ]);
    if (SLOT_TAKEN_CODES.has(commandResult)) {
      console.error(
        JSON.stringify({
          event: "booking_slot_rejected",
          studioId: studio.id,
          code: commandResult,
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
    if (commandResult === "outside_horizon") {
      return { ok: false, error: "That date is outside the booking window." };
    }
    if (commandResult === "public_booking_unavailable") {
      return { ok: false, error: UNAVAILABLE_PUBLIC_BOOKING_MESSAGE };
    }
    if (commandResult === "invalid_service") {
      return { ok: false, error: "Service no longer available." };
    }
    // invalid_client / invalid_practitioner / no_practitioner / not_eligible /
    // studio_not_found are all operator-visible states, never the visitor's
    // fault to fix, and must not distinguish "wrong studio" from "no such row".
    logInternalBookingError("public_booking_command_refused", {
      code: commandResult,
      studioId: studio.id,
      emailFingerprint: hashFingerprint(normalizedEmail),
    });
    return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
  }

  if (rpcErr || !createdId) {
    // sqlstate 23P01 = exclusion_violation (actual-overlap GiST). HB001 =
    // migration 0152's soft-buffer trigger (public booking never bypasses the
    // buffer; the slot generator already filters buffer-proximate times, so this
    // only fires on a rare race). Both map to the SAME safe copy — never the raw
    // DB message or SQLSTATE. A rejected booking must NOT trigger a confirmation
    // email, so we return before any send path.
    if (rpcErr?.code === "23P01" || rpcErr?.code === "HB001") {
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
    // PR #261: sqlstate code + studioId + salted email fingerprint;
    // drop raw DB message (the appointments row carries free-text notes,
    // so its error text must never reach logs on a public surface).
    logInternalBookingError("public_booking_insert_failed", {
      code: rpcErr?.code,
      studioId: studio.id,
      emailFingerprint: hashFingerprint(normalizedEmail),
    });
    return { ok: false, error: PUBLIC_BOOKING_GENERIC_ERROR };
  }

  // The appointment is COMMITTED (create_public_appointment returned 'created'),
  // together with its audit row. Everything from here on is a post-commit,
  // fail-soft side effect and must never roll the booking back.
  //
  // The confirmation/notification senders take an Appointment, but they read
  // only id / starts_at / ends_at / duration_minutes (lib/email/send-appointment.ts
  // :360-383, :423, :507-515, :534-542). Every one of those comes back from the
  // command as an AUTHORITATIVE value, so the payload is built from the command's
  // own return rather than by re-reading the row.
  //
  // This is deliberate. An earlier revision re-read the row and gated the sends
  // on that read succeeding — which meant one transient SELECT failure would
  // silently skip the confirmation email. The raw `appointmentToken` lives only
  // in memory and only its SHA-256 is persisted (`cancellation_token_hash`), so
  // the send must depend on nothing that can fail after the commit.
  //
  // BOOK-01 Tranche 1 AMENDS THE REST OF THIS NOTE. It used to say the email is
  // the ONLY carrier of the token and that losing it is unrecoverable. Neither
  // is true any more, and one was never quite true: this action's own success
  // response now carries the management URL to the authorised browser, and a
  // committed appointment was already recoverable through the authenticated
  // client portal and the 24h/2h reminder passes, both of which mint a stateless
  // HMAC management token from the appointment id (lib/booking/tokens.ts) that
  // /manage, /cancel and /reschedule all accept. Delivering the email still
  // matters — it is the client's durable copy — but a provider failure is no
  // longer a dead end.
  const created = {
    id: createdId,
    starts_at: commandRow?.starts_at as string,
    ends_at: commandRow?.ends_at as string,
    duration_minutes: commandRow?.duration_minutes as number,
    created_at: createdAtIso as string,
  } as unknown as import("@/lib/types/database").Appointment;

  // BOOK-01 P2-A. THE POST-COMMIT LAW.
  //
  // `create_public_appointment` has returned 'created', so the appointment and
  // its audit row are DURABLE. From here to the return, every operation is an
  // OPTIONAL secondary effect, and none of them may turn a committed booking
  // into `{ ok: false }` or an exception. Before this helper existed, several
  // could: `getTreatmentTimeContextForEmail` throws outright on a read error
  // (lib/treatment-time/queries.ts:256-258), and `ensureIntakeForClient`,
  // `recordEmailAttempt`, the practitioner notification and `revalidatePath`
  // are none of them proven throw-free. Any one of them would have surfaced a
  // committed booking as a failure with no management URL.
  //
  // Fail-soft is NOT silence: each failure records safe internal evidence and
  // degrades exactly one enrichment. Same shape as the reschedule surface's
  // `attempt()` (app/reschedule/[token]/actions.ts:918-945).
  //
  // SECRECY. Never `err.message`. A template, provider or URL-parsing error can
  // carry the recipient address or a management URL that embeds the RAW token.
  // Only the error's NAME — a fixed class like "TypeError" — plus ids we already
  // own are recorded.
  //
  // SCOPE. This contains unexpected APPLICATION EXCEPTIONS. It cannot contain
  // process termination: if the host kills this function after the commit there
  // is no response to carry anything, and that case stays owned by the portal
  // and reminder recovery paths.
  // Bound once, so the evidence the helper records cannot depend on anything
  // that might change (or be re-narrowed) later in this response.
  const evidenceAppointmentId = createdId;
  const evidenceStudioId = studio.id;
  const postCommit = async <T,>(
    event: string,
    fallback: T,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      // `errorClass` (not `errorName`) because the PII guard bans any key or
      // expression matching /\w*[nN]ame\w*/ in a booking log payload — a
      // deliberately blunt rule that catches clientName/practitionerName, and
      // widening it to admit an exception would weaken it. The CLASS is
      // extracted here so no `err.name` expression appears inside the logged
      // payload at all. Never `err.message`: it can carry the recipient address
      // or a URL embedding the raw token.
      const errorClass = err instanceof Error ? err.name : "unknown";
      logInternalBookingError(event, {
        appointmentId: evidenceAppointmentId,
        studioId: evidenceStudioId,
        errorClass,
      });
      return fallback;
    }
  };

  // AUTHORITATIVE PRACTITIONER. `commandRow.practitioner_id` is the practitioner
  // the appointment was actually assigned to, resolved inside the transaction
  // under the studio lock. It is the ONLY source downstream may use.
  //
  // This route used to pre-fetch "the current active owner" BEFORE the RPC and
  // then use that object for the notification row, the practitioner email
  // recipient and the practitioner name shown to the client. Those could
  // diverge: if ownership changed, or the owner was deactivated, between the
  // pre-fetch and the command's own lookup, the appointment committed to
  // practitioner B while every notification still named and emailed A. That is
  // an attribution and privacy defect, so the pre-fetch is gone.
  //
  // Metadata is re-read by EXACT (id, studio_id) — never by "current active
  // owner", which could resolve to someone else if activity changed again right
  // after commit. This read is best-effort: the appointment is already
  // committed and nothing here may fail the booking.
  const assignedPractitionerId =
    (commandRow?.practitioner_id as string | null | undefined) ?? null;
  type AssignedPractitioner = {
    id: string;
    display_name: string | null;
    email: string | null;
  };
  const assignedPractitioner: AssignedPractitioner | null = assignedPractitionerId
    ? await postCommit<AssignedPractitioner | null>(
        "public_booking_practitioner_lookup_threw",
        null,
        async () => {
          const { data: pr, error: prErr } = await admin
            .from("practitioners")
            .select("id, display_name, email")
            .eq("id", assignedPractitionerId)
            .eq("studio_id", studio.id)
            .maybeSingle();
          if (prErr || !pr) {
            // Safe, non-PII operational signal. Downstream degrades to the
            // studio-name fallback and skips the practitioner-specific email
            // rather than risking a stale recipient.
            logInternalBookingError("public_booking_practitioner_lookup_failed", {
              code: prErr?.code,
              studioId: studio.id,
            });
            return null;
          }
          return pr;
        },
      )
    : null;
  // Client-facing practitioner label. Falls back to the studio name exactly as
  // before when there is no assigned practitioner or the metadata read failed.
  const practitionerDisplayName =
    assignedPractitioner?.display_name?.trim() ||
    assignedPractitioner?.email ||
    studio.name;

  // PR #164. Fire-and-forget practitioner notification. The
  // appointment row is committed at this point; a failure inside
  // the helper logs to ops_alerts but does NOT roll back the
  // booking. Body is composed from the same data we already used
  // for the email + SMS confirmations -- no tokens, no secrets, no
  // PII beyond the client name + service name + start time the
  // appointment detail page already exposes to studio members.
  // BOOK-01 P2-A: the helper itself is synchronous and documented never to
  // throw, but the `body` template is evaluated EAGERLY at this call site, so a
  // date/timezone formatting failure would propagate from here. Contained.
  await postCommit("public_booking_practitioner_notification_threw", undefined, () =>
    recordPractitionerNotification({
      studioId: studio.id,
      practitionerId: assignedPractitionerId,
      eventType: "new_booking",
      title: "New booking",
      body: `${clientName} booked ${service.name} for ${formatDayLabel(start, studio.timezone)} at ${localTimeString12h(start, studio.timezone)}.`,
      appointmentId: createdId,
      clientId: clientId,
      href: `/calendar/${createdId}`,
    }),
  );

  // Fire-and-forget marketing/analytics consent capture. The appointment is
  // already committed, so this NEVER fails or delays the booking (a failed
  // insert only logs a safe, PII-free signal). Records exactly one
  // booking_tracking_consents row (migration 0106) — consent bookkeeping only,
  // separate from clinical/payment consent. No provider is contacted and no
  // data is sent anywhere; this only stores whether the client opted in.
  void (async () => {
    try {
      const { error: consentErr } = await admin
        .from("booking_tracking_consents")
        .insert(
          buildBookingMarketingConsentRow({
            studioId: studio.id,
            appointmentId: createdId,
            clientId,
            consent: marketingConsent,
          }),
        );
      if (consentErr) {
        logInternalBookingError("public_booking_marketing_consent_insert_failed", {
          code: consentErr.code,
          studioId: studio.id,
        });
      }
    } catch {
      // Consent capture must never break a confirmed booking.
    }
  })();

  // The appointment_audit row is NO LONGER written here. Migration 0170 writes
  // it inside create_public_appointment, in the same transaction as the
  // appointment, so it cannot be skipped or silently fail. Its shape is
  // unchanged: actor_type 'client', actor_id null, action 'created', details
  // { source: 'public_booking', email, notes } — with the email read from the
  // client row inside the command rather than passed across the boundary.

  // Fire-and-forget provider-agnostic conversion tracking (booking_confirmed).
  // Fully gated inside dispatchBookingConversion: sends NOTHING unless the
  // studio has an enabled provider config AND its token decrypts — so this is
  // inert in production today. Never throws; a confirmed booking must not fail
  // because tracking failed. No clinical data / no raw email/phone is logged.
  void dispatchBookingConversion({
    studioId: studio.id,
    appointmentId: createdId,
    eventTimeUnixSeconds: Math.floor(
      new Date(createdAtIso as string).getTime() / 1000,
    ),
    consentGranted: marketingConsent,
    email: normalizedEmail,
    phone: clientPhone,
    serviceModality: service.modality,
    eventSourceUrl: `${appOrigin}/book/${slug}`,
  });
  // Emails. New confirmation + reminder + reschedule URLs use the random
  // appointment_token column; legacy /cancel/[hmac] route still validates
  // older in-flight links.
  const cancellationUrl = `${appOrigin}/cancel/${appointmentToken}`;
  const rescheduleUrl = `${appOrigin}/reschedule/${appointmentToken}`;
  // SMS carries one neutral /manage/<token> link that surfaces both
  // reschedule and cancel after the studio's policies. Email still
  // includes the separate cancel + reschedule URLs above; SMS used
  // to mirror them and now does not, per the pilot direction change
  // away from encouraging cancel/reschedule from inside the SMS.
  const manageUrl = `${appOrigin}/manage/${appointmentToken}`;
  // Note: the HMAC-fallback generateCancellationToken() call previously
  // sat here purely to keep the import "used". It has been removed; the
  // public booking flow now depends exclusively on
  // generateAppointmentToken() above (stored hash-only at rest as
  // appointments.cancellation_token_hash; the raw token lives only in the
  // confirmation-email URL). Legacy HMAC links remain verifiable on the
  // /cancel/[token] route via verifyCancellationToken inside the resolver,
  // but no new HMAC links are minted here.

  // Ensure an in-progress intake exists for this client and attach the link
  // to the confirmation email. Returns null if they already have a submitted
  // or reviewed intake on file, in which case the email omits the section.
  //
  // BOOK-01 P2-A: the helper already returns null for EXPECTED read/insert
  // errors, but it carries no outer try/catch, so an unexpected throw would
  // have escaped. A null fallback degrades exactly one thing — the email and
  // SMS omit the intake link — and never a committed booking. Deliberately ONE
  // attempt: no retry inside this response path.
  const intake = await postCommit<{ id: string; url: string } | null>(
    "public_booking_intake_threw",
    null,
    () =>
      ensureIntakeForClient({
        studioId: studio.id,
        clientId,
        appOrigin,
      }),
  );

  // Studio toggle: skip the confirmation email entirely if disabled.
  // Email reporting is truthful: recordEmailAttempt atomically increments
  // confirmation_send_attempts AND stamps confirmation_sent_at only when
  // the Resend call actually succeeded. The old code path stamped the
  // timestamp unconditionally, which falsely advertised delivery.
  //
  // BOOK-01 Tranche 1: that same verdict is now REPORTED to the caller.
  // `disabled` is the honest default — the studio switched confirmations off,
  // which is a configuration rather than a failure, and still returns the
  // management URL. Only a provider success may move it to `sent`.
  let confirmationEmailStatus: ConfirmationEmailStatus = "disabled";
  if (studio.send_confirmation_emails) {
    // BOOK-01 P2-A: the treatment-time enrichment is the one dependency here
    // that throws OUTRIGHT rather than returning an error —
    // `getTreatmentTimeContextForEmail` raises on any read failure
    // (lib/treatment-time/queries.ts:256-258). A null line degrades the email's
    // optional context and nothing else, so the confirmation still goes out.
    const treatmentTimeLine = studio.show_treatment_time_to_clients
      ? await postCommit<string | null>(
          "public_booking_treatment_time_threw",
          null,
          async () =>
            buildTreatmentTimeLine({
              enabled: true,
              clientFirstName: clientName.split(/\s+/)[0] || clientName,
              context: await getTreatmentTimeContextForEmail(studio.id, clientId),
            }),
        )
      : null;
    // BOOK-01 P2-A: `sendEmailSafely` returns `{ ok: false }` rather than
    // throwing, so a provider refusal already lands on the truthful path below.
    // What is NOT proven throw-free is everything around it — subject/HTML/text
    // composition and the ICS builder. An unexpected throw there resolves to the
    // same shape as a refusal, so it reports `failed`: we do not know the client
    // received anything, and claiming otherwise would be a lie.
    const result = await postCommit<{
      ok: boolean;
      error?: string;
      retryable?: boolean;
    }>(
      "public_booking_confirmation_email_threw",
      { ok: false, error: "confirmation sender threw", retryable: false },
      () =>
        sendBookingConfirmationToClient({
          appointment: created,
          service,
          studio,
          practitionerDisplayName,
          clientName,
          clientEmail: email,
          cancellationUrl,
          rescheduleUrl,
          intakeUrl: intake?.url ?? null,
          treatmentTimeLine,
          appBaseUrl: appOrigin,
        }),
    );
    // The status reflects the PROVIDER, not the bookkeeping write below: if
    // recording the attempt fails, the client still did (or did not) get the
    // email, and what we report must match what actually happened. This is set
    // BEFORE the write for exactly that reason — the write cannot upgrade a
    // refusal to `sent`, nor downgrade a real send to `failed`.
    confirmationEmailStatus = result.ok ? "sent" : "failed";
    await postCommit("public_booking_email_attempt_write_threw", undefined, () =>
      recordEmailAttempt(admin, createdId, "confirmation", result.ok),
    );
    if (!result.ok) {
      await postCommit("public_booking_email_failure_log_threw", undefined, () =>
        logEmailFailure({
          appointmentId: createdId,
          emailType: "confirmation",
          error: result.error ?? "unknown",
          retryable: result.retryable ?? false,
          attemptNumber: 1,
        }),
      );
    }
  }

  // SMS confirmation attempt (PR Twilio v1). Strictly independent of
  // the email flow above: every gate check happens inside
  // sendBookingConfirmationSmsToClient, including the studio toggle,
  // consent_at, opted_out_at, phone normalization, and the
  // claim_sms_send race guard. The helper returns ok/skipped/error
  // and never throws; the booking succeeds regardless of the SMS
  // outcome and the email attempt tracking above is untouched. We
  // await so the serverless function does not exit before the Twilio
  // POST resolves; the helper bounds itself with a 15-second timeout.
  //
  // BOOK-01 P2-A: verified — `sendOne` wraps the provider call in try/catch and
  // returns a result object, so the documented "never throws" holds for the send
  // itself. It is NOT total: the consent/toggle gate and the `claim_sms_send`
  // race guard run BEFORE that try. Contained at the boundary rather than by
  // editing the helper, so SMS product behaviour is unchanged by this PR.
  await postCommit("public_booking_confirmation_sms_threw", undefined, () =>
    sendBookingConfirmationSmsToClient({
      admin,
      appointmentId: createdId,
      startsAt: start,
      timezone: studio.timezone,
      studio,
      client: {
        phone: clientPhone,
        sms_consent_at: clientSmsConsentAt,
        sms_opted_out_at: clientSmsOptedOutAt,
      },
      intakeUrl: intake?.url ?? null,
      manageUrl,
    }),
  );
  // Migration 0047: studio owners can opt out of the practitioner
  // new-booking notification. Default true preserves existing
  // behavior. Client confirmation email above is gated separately
  // via send_confirmation_emails and is NOT affected by this toggle.
  // Only the AUTHORITATIVE assigned practitioner may receive this. A null
  // practitioner, or a failed metadata read, sends nothing — never a stale owner.
  if (
    assignedPractitioner?.email &&
    studio.notify_practitioner_on_new_booking !== false
  ) {
    // BOOK-01 P2-A: secondary by definition — the CLIENT's booking must not
    // depend on notifying staff. Recipients and enablement logic are unchanged.
    await postCommit("public_booking_practitioner_email_threw", undefined, () =>
      sendBookingNotificationToPractitioner({
        appointment: created,
        service,
        studio,
        practitionerName:
          assignedPractitioner.display_name?.trim() ||
          assignedPractitioner.email ||
          "Practitioner",
        practitionerEmail: assignedPractitioner.email as string,
        clientName,
        clientEmail: email,
        clientPhone,
        notes,
        appointmentUrl: `${appOrigin}/calendar/${createdId}`,
        // PR #163. Already-labelled practitioner-facing string;
        // null when the visitor declined to answer.
        referralSourceLabel: referralSourceLabel(referralSource),
      }),
    );
  }

  // BOOK-01 P2-A: cache revalidation is a studio-side nicety. `revalidatePath`
  // throws when called outside a request scope, and a stale calendar is a far
  // smaller problem than a committed booking reported as an error.
  await postCommit("public_booking_revalidate_threw", undefined, () => {
    revalidatePath("/calendar");
    revalidatePath("/calendar/upcoming");
  });

  // Post-response, bounded: a PostHog outage must never make a COMMITTED
  // public booking report failure to the client (P1/P2-ANALYTICS-03).
  // `captureServerEvent` is already non-blocking and documented never to throw
  // (lib/analytics/server.ts:110-117 wraps `after()` in try/catch), but the
  // property allowlisting runs synchronously first, so it is contained too.
  // The payload carries studio scope only — never a token, URL or client id.
  await postCommit("public_booking_analytics_threw", undefined, () =>
    captureServerEvent({
      actor: { kind: "studio", id: studio.id },
      event: "public_appointment_booked",
      properties: { studio_id: studio.id, source: "public_booking" },
    }),
  );

  // THE BOOKING IS COMMITTED, and the client leaves with a usable path to it
  // whatever the email did. `manageUrl` goes ONLY to this authorised browser —
  // it is never persisted, logged, alerted on or reported.
  return {
    ok: true,
    appointmentId: createdId,
    manageUrl,
    confirmationEmailStatus,
  };
}

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
function nullable(value: FormDataEntryValue | null): string | null {
  const t = trimmed(value);
  return t.length === 0 ? null : t;
}

// PR #164. Short "weekday Month day" label used in the practitioner
// notification body for a new booking. Kept local because the
// notification builder is the only caller; the rest of the action
// uses email-template helpers that build the day label themselves.
// en-US locale matches the existing notification + email styling.
function formatDayLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
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
