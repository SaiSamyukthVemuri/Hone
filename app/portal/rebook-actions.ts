"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPortalSession } from "@/lib/portal/session";
import {
  getPortalBookableServices,
  pickPortalBookableService,
  type PortalBookableService,
} from "@/lib/portal/queries";
import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";
import {
  filterFutureSlots,
  getAvailableSlots,
  type Slot,
} from "@/lib/booking/slots";
import { loadPublicSlotsByDate } from "@/lib/booking/public-slot-range";
import {
  horizonRangeInStudioTz,
  isWithinPublicBookingHorizon,
  maxPublicBookingHorizonDays,
} from "@/lib/booking/horizon";
import { addDays, localTimeString12h, localDateString, todayInTz } from "@/lib/booking/tz";
import {
  generateAppointmentToken,
  hashAppointmentToken,
} from "@/lib/booking/appointment-token";
import type { ConfirmationEmailStatus } from "@/lib/booking/confirmation-presentation";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { ensureIntakeForClient } from "@/lib/intake/queries";
import {
  logEmailFailure,
  recordEmailAttempt,
  sendBookingConfirmationToClient,
  sendBookingNotificationToPractitioner,
} from "@/lib/email/send-appointment";
import { recordPractitionerNotification } from "@/lib/notifications/practitioner-notifications";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";
import {
  PORTAL_REBOOK_GENERIC_REFUSAL,
  PORTAL_REBOOK_OUTSIDE_WINDOW,
  PORTAL_REBOOK_SERVICE_UNAVAILABLE,
  PORTAL_REBOOK_SESSION_EXPIRED,
  PORTAL_REBOOK_SLOT_TAKEN,
  type PortalRebookRefusalCode,
} from "@/lib/portal/rebook-copy";
import type { Studio } from "@/lib/types/database";

// ===========================================================================
// EMERG-PORTAL-REBOOK-01 — a returning client can book again, from the portal.
// ===========================================================================
//
// THE GAP. `/book/<slug>` asks "new or existing client?"; the existing branch
// renders a "Sign in to your secure client portal" card and nothing else
// (app/book/[slug]/PublicBookForm.tsx). The portal then showed upcoming
// appointments and no way to create one. A returning client was therefore
// routed into a room with no booking door.
//
// IDENTITY IS THE WHOLE POINT, SO IT IS NEVER SUBMITTED.
//
// The public action still carries a `client_type=existing` path that binds a
// clinical client by matching a TYPED email against the studio's active
// clients. It is unreachable from the rendered public surface and it stays
// that way: exposing it would mean anyone who knows a client's email address
// can book as that person. THIS FILE DOES NOT REOPEN IT AND DOES NOT IMPORT
// FROM IT. `studioId` and `clientId` come from `getCurrentPortalSession()` and
// from nowhere else. There is no form field for either, so there is nothing to
// forge. The browser supplies CHOICES — which service, which time, an optional
// note. It never supplies WHO.
//
// DEFENCE IN DEPTH, NOT TRUST. The commit goes through
// `create_public_appointment` (migration 0170), the SAME locked command the
// public route uses and the only authorised writer of a public appointment. It
// re-validates studio, client and service tenancy under the studio lock,
// derives duration from the LOCKED service row, derives the end time, the
// status, the owner practitioner and the capacity/buffer columns, re-derives
// the public slot grid and requires exact millisecond membership, and writes
// the mandatory `appointment_audit` row in the same transaction. There is no
// parameter for a duration, an end time, a status, a practitioner or an
// outside-hours override, so this caller cannot request one.
//
// So the identity binding is enforced TWICE and the second enforcement is in
// the database: even if every line below were wrong, the command would refuse
// a client id that does not belong to the session's studio.
//
// NO NEW SCHEMA. The command already accepted `p_client_id` and already
// validated it. This emergency needed a caller, not a migration.
//
// WHAT IS DELIBERATELY NOT HERE
//
//   * No WAIT interaction. `isNewClientWaitlistEnabled` gates NEW-CLIENT
//     ADMISSION — whether a visitor presenting nothing may book as a new
//     client. A returning client with a live portal session is not a new
//     client, was already admitted, and is not re-admitted here. This file
//     does not import the flag, so a waitlisted studio keeps serving its
//     existing clients while its new-client intake stays closed.
//   * No SMS. The public surface sends a confirmation SMS behind a consent
//     gate; adding a second sender on a new surface would be an SMS behaviour
//     change, which this lane is explicitly not making.
//   * No marketing-consent row and no conversion dispatch. Neither has an
//     opt-in on this surface, and inventing one would be a consent claim we
//     have not collected.
//   * No new rate limiter. The portal session IS the gate; the public
//     limiters exist because that surface is unauthenticated.
// ===========================================================================

/** A refusal a returning client can read, plus the code the UI branches on. */
type Refusal = { ok: false; error: string; code: PortalRebookRefusalCode };

const refuse = (code: PortalRebookRefusalCode, error: string): Refusal => ({
  ok: false,
  error,
  code,
});

export type PortalRebookSlotsResult =
  | { ok: true; slots: Slot[] }
  | Refusal;

export type PortalRebookNextAvailableResult =
  | { ok: true; date: string | null }
  | Refusal;

export type PortalRebookResult =
  | {
      ok: true;
      appointmentId: string;
      /**
       * The client's guaranteed path to the appointment they just made, built
       * from the raw token THIS request minted. Only the SHA-256 is persisted,
       * so this URL goes to this authorised browser and is never logged,
       * alerted on, or written anywhere.
       */
      manageUrl: string;
      startsAt: string;
      serviceName: string;
      /**
       * The address on file that the confirmation was (or was not) sent to.
       *
       * It is the AUTHENTICATED CLIENT'S OWN address, returned only to their
       * own browser, and it is what makes the acknowledgement checkable: a
       * client who sees the wrong address knows to tell the studio. Null when
       * the studio holds no address for them.
       */
      confirmationEmail: string | null;
      /**
       * What the confirmation email ACTUALLY did. `disabled` means the studio
       * switched confirmations off; `failed` means we tried and could not.
       * Neither ever turns a committed booking into a failure, and neither is
       * ever reported as `sent`.
       */
      confirmationEmailStatus: ConfirmationEmailStatus;
    }
  | Refusal;

/**
 * Sanitised internal evidence.
 *
 * Never a client name, email, phone, note or any raw Postgres message: this
 * runs for an authenticated person's clinical booking, and the appointment row
 * carries free-text notes, so an error string can echo them. Ids we already
 * own plus a sqlstate code are enough to diagnose.
 */
function logRebookError(event: string, detail: Record<string, unknown>) {
  console.error(
    JSON.stringify({ event, ...detail, timestamp: new Date().toISOString() }),
  );
}

/**
 * The server-resolved booking identity.
 *
 * It holds the STUDIO ROW and the SESSION'S client id, so no caller below can
 * accidentally re-derive either from something the browser sent.
 */
type PortalBookingContext = {
  studio: Studio;
  /** Straight from the portal session. The only client identity in this file. */
  clientId: string;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  /**
   * SMS eligibility as STORED. Passed through untouched to the existing sender,
   * which owns every gate. Nothing on this surface can set, widen or infer it.
   */
  clientSmsConsentAt: string | null;
  clientSmsOptedOutAt: string | null;
};

/**
 * Resolve the portal session, then the ACTIVE client and the studio it names.
 *
 * FAIL CLOSED, IN THIS ORDER:
 *   1. no / expired / revoked session          -> session_expired (UI -> login)
 *   2. client row unreadable                   -> unavailable
 *   3. client missing, archived, or not this studio's -> unavailable
 *   4. studio row unreadable or missing        -> unavailable
 *
 * 2 and 3 return the SAME sentence on purpose. A read failure is not an
 * archived client, but neither is the client's to fix, and distinguishing them
 * would say something about a record the client cannot otherwise see.
 */
async function resolvePortalBookingContext(): Promise<
  { ok: true; ctx: PortalBookingContext } | Refusal
> {
  const session = await getCurrentPortalSession();
  if (!session) return refuse("session_expired", PORTAL_REBOOK_SESSION_EXPIRED);

  // THE TWO VALUES THE WHOLE UNIT RESTS ON. Both come from the session, which
  // resolved them from a hashed cookie against a non-expired, non-revoked row.
  const studioId = session.studioId;
  const clientId = session.clientId;

  const admin = createAdminClient();

  // The client must be THIS studio's and must not be archived. Both filters are
  // in the query, so an archived or cross-studio row is simply absent rather
  // than something a later branch has to remember to check.
  const { data: clientRow, error: clientErr } = await admin
    .from("clients")
    .select("id, name, email, phone, sms_consent_at, sms_opted_out_at, archived_at")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (clientErr) {
    logRebookError("portal_rebook_client_lookup_failed", {
      code: clientErr.code,
      studioId,
    });
    return refuse("unavailable", PORTAL_REBOOK_GENERIC_REFUSAL);
  }
  if (!clientRow || clientRow.archived_at != null) {
    return refuse("unavailable", PORTAL_REBOOK_GENERIC_REFUSAL);
  }

  const { data: studioRow, error: studioErr } = await admin
    .from("studios")
    .select("*")
    .eq("id", studioId)
    .maybeSingle();
  // A FAILED READ IS NOT A MISSING STUDIO. Both refuse, and neither is
  // reported as "this studio has nothing available".
  if (studioErr || !studioRow) {
    logRebookError("portal_rebook_studio_lookup_failed", {
      code: studioErr?.code ?? null,
      studioId,
    });
    return refuse("unavailable", PORTAL_REBOOK_GENERIC_REFUSAL);
  }

  return {
    ok: true,
    ctx: {
      studio: studioRow as Studio,
      clientId,
      clientName: ((clientRow.name as string | null) ?? "").trim() || "Client",
      clientEmail: (clientRow.email as string | null) ?? null,
      clientPhone: (clientRow.phone as string | null) ?? null,
      clientSmsConsentAt: (clientRow.sms_consent_at as string | null) ?? null,
      clientSmsOptedOutAt: (clientRow.sms_opted_out_at as string | null) ?? null,
    },
  };
}

/**
 * Resolve the chosen service through THE ONE SERVER-AUTHORIZED SERVICE READ.
 *
 * `getPortalBookableServices` is the same function that produces the menu the
 * client is shown, and the same one whose row supplies the duration handed to
 * slot generation and to `create_public_appointment`. Using it here is what
 * makes those three answers structurally identical: a service the menu would
 * not show is a service this cannot find.
 *
 * IT IS ADMIN-SCOPED ON PURPOSE. Migration 0173 restricts `services` SELECT to
 * authenticated studio MEMBERS, and a portal client is not one — the portal is
 * a separate realm keyed on `hone_portal_session`. The RLS-bound
 * `getActiveServices` therefore returns an EMPTY LIST for a portal client
 * rather than an error, which is how a returning client ends up staring at a
 * surface with no services on it. Tenancy is instead carried by the explicit
 * `studio_id` + `active` query filters inside that loader, with the studio id
 * coming from the session and from nowhere else.
 *
 * A READ FAILURE IS NOT "THAT SERVICE IS GONE": the loader answers null, and
 * that lands on the generic refusal, never on `service_unavailable` and never
 * on an empty menu.
 */
async function resolvePortalService(
  studioId: string,
  serviceId: string,
): Promise<{ ok: true; service: PortalBookableService } | Refusal> {
  const services = await getPortalBookableServices(studioId);
  if (services == null) {
    logRebookError("portal_rebook_service_read_failed", { studioId });
    return refuse("unavailable", PORTAL_REBOOK_GENERIC_REFUSAL);
  }
  const service = pickPortalBookableService(services, serviceId);
  if (!service) {
    // Cross-studio, inactive and unknown all collapse here. The client learns
    // only that this choice is not available — never which of the three it was.
    return refuse("service_unavailable", PORTAL_REBOOK_SERVICE_UNAVAILABLE);
  }
  return { ok: true, service };
}

/**
 * The capacity-OFF studio shape the PUBLIC slot loader is given.
 *
 * Built deliberately WITHOUT `practitioner_capacity_enabled` and called with no
 * practitioner, exactly as app/book/[slug]/actions.ts builds it, so the portal
 * cannot offer a start the public grid would not offer — which is the precise
 * membership the command re-derives under its lock.
 */
function publicStudioShape(studio: Studio) {
  return {
    id: studio.id,
    timezone: studio.timezone,
    default_appointment_duration_minutes:
      studio.default_appointment_duration_minutes,
    buffer_minutes: studio.buffer_minutes,
  };
}

/**
 * Offerable start times for one active service on one studio-local date.
 *
 * Same generator, same capacity mode, same past-time filter as the public
 * booking page. Nothing here is a second scheduling engine.
 */
export async function loadPortalRebookSlotsAction(params: {
  serviceId: string;
  date: string;
}): Promise<PortalRebookSlotsResult> {
  const resolved = await resolvePortalBookingContext();
  if (!resolved.ok) return resolved;
  const { studio } = resolved.ctx;

  const horizon = horizonRangeInStudioTz(
    studio.timezone,
    studio.public_booking_horizon_months,
  );
  if (params.date < horizon.minDateStr || params.date > horizon.maxDateStr) {
    return refuse("outside_window", PORTAL_REBOOK_OUTSIDE_WINDOW);
  }

  const service = await resolvePortalService(studio.id, params.serviceId);
  if (!service.ok) return service;

  const admin = createAdminClient();
  const slots = await getAvailableSlots(
    admin,
    publicStudioShape(studio),
    params.date,
    service.service.default_duration_minutes,
  );
  // Public-surface past-time guard, shared helper. Today's earlier hours are
  // never offered.
  return { ok: true, slots: filterFutureSlots(slots) };
}

/**
 * The earliest date at or after `fromDate` that has an offerable slot.
 *
 * Bounded exactly like the public "Next available": ONE bulk pass over the
 * named dates via `loadPublicSlotsByDate`, not one day loader per day. A
 * horizon scan therefore costs the same as a one-day scan.
 */
export async function loadPortalRebookNextAvailableAction(params: {
  serviceId: string;
  fromDate: string;
}): Promise<PortalRebookNextAvailableResult> {
  const resolved = await resolvePortalBookingContext();
  if (!resolved.ok) return resolved;
  const { studio } = resolved.ctx;

  const service = await resolvePortalService(studio.id, params.serviceId);
  if (!service.ok) return service;

  const admin = createAdminClient();
  const today = todayInTz(studio.timezone);
  const horizon = horizonRangeInStudioTz(
    studio.timezone,
    studio.public_booking_horizon_months,
  );
  const startDate = params.fromDate < today ? today : params.fromDate;
  if (startDate > horizon.maxDateStr) return { ok: true, date: null };

  // A LOOP GUARD, not a cost control: the bulk pass below bounds the database
  // work. This only stops a date-arithmetic bug from building an endless array.
  //
  // THE SLACK IS LOAD-BEARING, and it is the same slack the public route
  // carries. `maxPublicBookingHorizonDays()` is 372 (12 * 31), but a window
  // running from today THROUGH today+372 holds 373 dates inclusive — so a bound
  // of exactly 372 silently drops the LAST bookable day, and "Next available"
  // would answer "nothing left" for a studio whose only free slot is on it.
  const SCAN_CAP = maxPublicBookingHorizonDays() + 14;
  const dates: string[] = [];
  let cursor = startDate;
  while (cursor <= horizon.maxDateStr && dates.length < SCAN_CAP) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const range = await loadPublicSlotsByDate(
    admin,
    {
      studioId: studio.id,
      timezone: studio.timezone,
      publicBookingHorizonMonths: studio.public_booking_horizon_months,
      bufferMinutes: studio.buffer_minutes,
      serviceDurationMinutes: service.service.default_duration_minutes,
    },
    dates,
    new Date(),
    { stopAfterFirstMatch: true },
  );

  if (!range.ok) {
    // A READ THAT FAILED IS NOT "BOOKED SOLID". Answering `date: null` here
    // would tell the client this studio has nothing free between now and the
    // horizon on the strength of a query that never answered.
    logRebookError("portal_rebook_next_available_read_failed", {
      studioId: studio.id,
    });
    return refuse("unavailable", PORTAL_REBOOK_GENERIC_REFUSAL);
  }

  // `byDate` is ascending and omits dates with no offerable slot, so the first
  // group IS the answer and an empty list means the horizon is exhausted.
  return { ok: true, date: range.byDate[0]?.date ?? null };
}

/**
 * Book another appointment as the client this session has already proved.
 */
export async function bookAnotherAppointmentAction(
  formData: FormData,
): Promise<PortalRebookResult> {
  // THE SESSION IS RESOLVED BEFORE ANY SUBMITTED VALUE IS READ. A refusal on
  // this line cannot depend on anything the browser sent, and the identity the
  // rest of this function uses is fixed before the form is opened.
  const resolved = await resolvePortalBookingContext();
  if (!resolved.ok) return resolved;
  const {
    studio,
    clientId,
    clientName,
    clientEmail,
    clientPhone,
    clientSmsConsentAt,
    clientSmsOptedOutAt,
  } = resolved.ctx;

  // CHOICES ONLY. Note what is absent: no email, no name, no phone, no client
  // id, no studio id, no client type. Their absence is the contract, and
  // tests/source-guards/portal-rebook-identity.test.ts pins it.
  const serviceId = trimmed(formData.get("serviceId"));
  const startsAtRaw = trimmed(formData.get("startsAt"));
  const notes = nullable(formData.get("notes"));
  if (!serviceId || !startsAtRaw) {
    return refuse("unavailable", PORTAL_REBOOK_GENERIC_REFUSAL);
  }

  const start = new Date(startsAtRaw);
  if (Number.isNaN(start.getTime())) {
    return refuse("unavailable", PORTAL_REBOOK_GENERIC_REFUSAL);
  }
  if (
    !isWithinPublicBookingHorizon(
      start,
      studio.timezone,
      studio.public_booking_horizon_months,
    )
  ) {
    return refuse("outside_window", PORTAL_REBOOK_OUTSIDE_WINDOW);
  }
  // The horizon check admits "today", so a today-but-already-passed instant is
  // caught here rather than by the command.
  if (start.getTime() <= Date.now()) {
    return refuse("slot_taken", PORTAL_REBOOK_SLOT_TAKEN);
  }

  const service = await resolvePortalService(studio.id, serviceId);
  if (!service.ok) return service;

  const admin = createAdminClient();

  // Re-verify against the STUDIO-LOCAL date. Using the UTC date would look up
  // the wrong calendar day for a late-evening booking west of UTC.
  //
  // This is an early, courteous refusal — NOT the authority. It runs before the
  // studio lock is taken, so the command re-derives the same grid under the
  // lock and is the thing that actually decides.
  const slots = await getAvailableSlots(
    admin,
    publicStudioShape(studio),
    localDateString(start, studio.timezone),
    service.service.default_duration_minutes,
  );
  const offered = slots.some(
    (s) => new Date(s.start).getTime() === start.getTime(),
  );
  if (!offered) return refuse("slot_taken", PORTAL_REBOOK_SLOT_TAKEN);

  // REQUIRED CONFIGURATION IS RESOLVED BEFORE THE DURABILITY BOUNDARY.
  // `getRequiredAppOrigin()` throws by design when NEXT_PUBLIC_APP_ORIGIN is
  // absent in production. Resolved here, that misconfiguration refuses cleanly
  // with nothing written; resolved after the command it would mean a committed
  // appointment the client is told failed, with no management URL ever minted.
  let appOrigin: string;
  try {
    appOrigin = getRequiredAppOrigin();
  } catch (err) {
    logRebookError("portal_rebook_app_origin_unresolved", {
      studioId: studio.id,
      errorClass: err instanceof Error ? err.name : "unknown",
    });
    return refuse("unavailable", PORTAL_REBOOK_GENERIC_REFUSAL);
  }

  const appointmentToken = generateAppointmentToken();
  const { data: rpcRows, error: rpcErr } = await admin.rpc(
    "create_public_appointment",
    {
      // BOTH SERVER-DERIVED, AND THIS IS THE LINE THE UNIT IS ABOUT.
      // `studio.id` came from the session's studio row; `clientId` IS
      // `session.clientId`. Neither was ever in the request body.
      p_studio_id: studio.id,
      p_client_id: clientId,
      p_service_id: serviceId,
      p_starts_at: start.toISOString(),
      p_cancellation_token_hash: hashAppointmentToken(appointmentToken),
      // The existing booking contract's own optional note column. Same field,
      // same flattening into appointments.notes the public form performs.
      p_notes: notes,
      // Referral source is a FIRST-VISIT question. A returning client already
      // answered it, so this surface does not re-ask and does not overwrite.
      p_referral_source: null,
    },
  );

  const commandRow = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const commandResult = (commandRow?.result as string | undefined) ?? null;
  const createdId =
    commandResult === "created" && commandRow?.appointment_id
      ? (commandRow.appointment_id as string)
      : null;

  if (rpcErr || !createdId) {
    // 23P01 = the actual-overlap GiST exclusion constraint. HB001 = migration
    // 0152's soft-buffer trigger. Both mean the same thing to a client.
    const collided = rpcErr?.code === "23P01" || rpcErr?.code === "HB001";
    // The command reports every collision — overlap, buffer, block, break — as
    // `time_unavailable`. `not_a_public_slot` belongs here too: it means the
    // instant stopped being an offered slot between the check above and the
    // lock, which is a "pick another time", not a dead end.
    const SLOT_CODES = new Set([
      "time_unavailable",
      "outside_availability",
      "studio_closed",
      "invalid_time",
      "not_a_public_slot",
    ]);
    if (collided || (commandResult != null && SLOT_CODES.has(commandResult))) {
      logRebookError("portal_rebook_slot_rejected", {
        studioId: studio.id,
        code: rpcErr?.code ?? commandResult,
      });
      return refuse("slot_taken", PORTAL_REBOOK_SLOT_TAKEN);
    }
    if (commandResult === "outside_horizon") {
      return refuse("outside_window", PORTAL_REBOOK_OUTSIDE_WINDOW);
    }
    if (commandResult === "invalid_service") {
      return refuse("service_unavailable", PORTAL_REBOOK_SERVICE_UNAVAILABLE);
    }
    // Everything else — invalid_client, studio_not_found, not_eligible,
    // public_booking_unavailable, a transport error, or a `created` with no id
    // — is an operator-visible state. It collapses to ONE sentence so the
    // command's vocabulary never becomes a probe.
    logRebookError("portal_rebook_commit_refused", {
      studioId: studio.id,
      code: rpcErr?.code ?? commandResult ?? "no_result",
    });
    return refuse("unavailable", PORTAL_REBOOK_GENERIC_REFUSAL);
  }

  // =========================================================================
  // THE APPOINTMENT IS COMMITTED, together with its mandatory audit row.
  // From here to the return, EVERY operation is an optional secondary effect
  // and none of them may turn a committed booking into a refusal or an
  // exception. Fail-soft is not silence: each failure records safe internal
  // evidence and degrades exactly one enrichment.
  //
  // SECRECY: never `err.message`. A template, provider or URL-parsing error can
  // carry the recipient address or a management URL embedding the RAW token.
  // Only the error's CLASS plus ids we already own are recorded.
  // =========================================================================
  const postCommit = async <T,>(
    event: string,
    fallback: T,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      logRebookError(event, {
        appointmentId: createdId,
        studioId: studio.id,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
      return fallback;
    }
  };

  const created = {
    id: createdId,
    starts_at: commandRow?.starts_at as string,
    ends_at: commandRow?.ends_at as string,
    duration_minutes: commandRow?.duration_minutes as number,
    created_at: (commandRow?.created_at as string | undefined) ?? null,
  } as unknown as import("@/lib/types/database").Appointment;

  // AUTHORITATIVE PRACTITIONER. `commandRow.practitioner_id` is who the
  // appointment was actually assigned to, resolved inside the transaction under
  // the studio lock. Metadata is re-read by EXACT (id, studio_id), never by
  // "current active owner", which could resolve to someone else. No assignment
  // rule is invented or changed here.
  const assignedPractitionerId =
    (commandRow?.practitioner_id as string | null | undefined) ?? null;
  type AssignedPractitioner = {
    id: string;
    display_name: string | null;
    email: string | null;
  };
  const assignedPractitioner = assignedPractitionerId
    ? await postCommit<AssignedPractitioner | null>(
        "portal_rebook_practitioner_lookup_threw",
        null,
        async () => {
          const { data: pr, error: prErr } = await admin
            .from("practitioners")
            .select("id, display_name, email")
            .eq("id", assignedPractitionerId)
            .eq("studio_id", studio.id)
            .maybeSingle();
          if (prErr || !pr) {
            logRebookError("portal_rebook_practitioner_lookup_failed", {
              code: prErr?.code ?? null,
              studioId: studio.id,
            });
            return null;
          }
          return pr as AssignedPractitioner;
        },
      )
    : null;
  const practitionerDisplayName =
    assignedPractitioner?.display_name?.trim() ||
    assignedPractitioner?.email ||
    studio.name;

  await postCommit("portal_rebook_practitioner_notification_threw", undefined, () =>
    recordPractitionerNotification({
      studioId: studio.id,
      practitionerId: assignedPractitionerId,
      eventType: "new_booking",
      title: "New booking",
      body: `${clientName} booked ${service.service.name} for ${formatDayLabel(start, studio.timezone)} at ${localTimeString12h(start, studio.timezone)}.`,
      appointmentId: createdId,
      clientId,
      href: `/calendar/${createdId}`,
    }),
  );

  const cancellationUrl = `${appOrigin}/cancel/${appointmentToken}`;
  const rescheduleUrl = `${appOrigin}/reschedule/${appointmentToken}`;
  const manageUrl = `${appOrigin}/manage/${appointmentToken}`;

  const intake = await postCommit<{ id: string; url: string } | null>(
    "portal_rebook_intake_threw",
    null,
    () => ensureIntakeForClient({ studioId: studio.id, clientId, appOrigin }),
  );

  // Confirmation email, with the SAME truth semantics the public surface uses:
  // `disabled` when the studio switched confirmations off, `sent` ONLY on a
  // provider success, `failed` otherwise. The status reflects the PROVIDER, not
  // the bookkeeping write, and is set BEFORE that write so the write can
  // neither upgrade a refusal nor downgrade a real send.
  //
  // THE RECIPIENT IS THE STORED CLIENT EMAIL, resolved from the row the session
  // named. Nothing typed into this form can redirect it.
  let confirmationEmailStatus: ConfirmationEmailStatus = "disabled";
  if (studio.send_confirmation_emails && !clientEmail) {
    // CONFIRMATIONS ARE ON AND WE HAVE NO ADDRESS. That is a FAILURE TO SEND,
    // not a studio that switched them off, and reporting `disabled` here would
    // tell the client their studio does not send confirmations when in fact one
    // was owed and could not be produced.
    confirmationEmailStatus = "failed";
    logRebookError("portal_rebook_no_client_email_on_file", {
      appointmentId: createdId,
      studioId: studio.id,
    });
  } else if (studio.send_confirmation_emails && clientEmail) {
    const treatmentTimeLine = studio.show_treatment_time_to_clients
      ? await postCommit<string | null>(
          "portal_rebook_treatment_time_threw",
          null,
          async () =>
            buildTreatmentTimeLine({
              enabled: true,
              clientFirstName: clientName.split(/\s+/)[0] || clientName,
              context: await getTreatmentTimeContextForEmail(studio.id, clientId),
            }),
        )
      : null;
    const result = await postCommit<{
      ok: boolean;
      error?: string;
      retryable?: boolean;
    }>(
      "portal_rebook_confirmation_email_threw",
      { ok: false, error: "confirmation sender threw", retryable: false },
      () =>
        sendBookingConfirmationToClient({
          appointment: created,
          service: service.service,
          studio,
          practitionerDisplayName,
          clientName,
          clientEmail,
          cancellationUrl,
          rescheduleUrl,
          intakeUrl: intake?.url ?? null,
          treatmentTimeLine,
          appBaseUrl: appOrigin,
        }),
    );
    confirmationEmailStatus = result.ok ? "sent" : "failed";
    await postCommit("portal_rebook_email_attempt_write_threw", undefined, () =>
      recordEmailAttempt(admin, createdId, "confirmation", result.ok),
    );
    if (!result.ok) {
      await postCommit("portal_rebook_email_failure_log_threw", undefined, () =>
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

  // SMS confirmation, on EXACTLY the existing terms.
  //
  // WHAT THIS DOES NOT DO. It does not widen eligibility, does not change
  // sender routing, does not collect or infer consent, and does not touch the
  // per-studio sender work. Every gate lives INSIDE
  // `sendBookingConfirmationSmsToClient` — the studio toggle, `sms_consent_at`,
  // `sms_opted_out_at`, phone normalisation and the `claim_sms_send` race guard
  // — and this caller simply hands it the values AS STORED on the client row
  // the session resolved. A client with no consent on file gets no message,
  // which is the same answer the public route produces for the same row.
  //
  // THE PUBLIC ROUTE CAN STAMP CONSENT FROM ITS FORM. THIS ONE CANNOT: there is
  // no consent checkbox on this surface and no code path here writes
  // `sms_consent_at`, so a returning client's SMS state is exactly what it was
  // before they booked.
  //
  // Awaited so the serverless function does not exit before the provider call
  // resolves; the helper bounds itself with its own timeout and is contained
  // here anyway, because its consent/toggle gate and the race guard run before
  // its internal try.
  await postCommit("portal_rebook_confirmation_sms_threw", undefined, () =>
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

  // Same practitioner-notification toggle and the same authoritative recipient
  // rule as the public surface. A null practitioner, or a failed metadata read,
  // emails nobody — never a stale owner.
  if (
    assignedPractitioner?.email &&
    studio.notify_practitioner_on_new_booking !== false
  ) {
    await postCommit("portal_rebook_practitioner_email_threw", undefined, () =>
      sendBookingNotificationToPractitioner({
        appointment: created,
        service: service.service,
        studio,
        practitionerName:
          assignedPractitioner.display_name?.trim() ||
          assignedPractitioner.email ||
          "Practitioner",
        practitionerEmail: assignedPractitioner.email as string,
        clientName,
        clientEmail: clientEmail ?? "",
        clientPhone,
        notes,
        appointmentUrl: `${appOrigin}/calendar/${createdId}`,
        referralSourceLabel: null,
      }),
    );
  }

  // Cache revalidation is a nicety: `revalidatePath` throws outside a request
  // scope, and a stale list is a far smaller problem than a committed booking
  // reported as an error. /portal so the client sees the new appointment in
  // their upcoming list; /calendar so the studio does.
  await postCommit("portal_rebook_revalidate_threw", undefined, () => {
    revalidatePath("/portal");
    revalidatePath("/calendar");
    revalidatePath("/calendar/upcoming");
  });

  return {
    ok: true,
    appointmentId: createdId,
    manageUrl,
    startsAt: start.toISOString(),
    serviceName: service.service.name,
    confirmationEmail: clientEmail,
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

/** Short "Wed Oct 7" label for the practitioner notification body. */
function formatDayLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}
