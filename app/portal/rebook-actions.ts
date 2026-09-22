"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPortalSession } from "@/lib/portal/session";
import { getActiveServices } from "@/lib/booking/queries";
import { getAvailableSlots } from "@/lib/booking/slots";
import { localDateString } from "@/lib/booking/tz";
import {
  generateAppointmentToken,
  hashAppointmentToken,
} from "@/lib/booking/appointment-token";

// EMERG-PORTAL-REBOOK-01 — the returning client can book again.
//
// THE GAP THIS CLOSES. `/book/<slug>` offers "existing client" and then
// early-returns to `/portal/login` (PublicBookForm), and `/portal` could only
// manage appointments that already existed. A returning client was therefore
// trapped: public booking -> portal -> no way to book. This is the missing
// third side.
//
// IDENTITY IS THE WHOLE POINT, SO IT IS NOT SUBMITTED.
//
// The dormant unauthenticated existing-client path in `app/book/[slug]/actions.ts`
// binds identity by matching the TYPED email against an active client
// (`client_type=existing`). That is an impersonation surface: anyone who knows a
// client's email books as them. This action does NOT reopen it. `studioId` and
// `clientId` come from `getCurrentPortalSession()` and from nowhere else — there
// is no form field for either, so a forged one has nothing to forge into.
//
// The form supplies CHOICES (which service, which time). It never supplies
// WHO.
//
// DEFENCE IN DEPTH, NOT TRUST. The commit goes through `create_public_appointment`
// (migration 0170), the same locked command the public route uses. It derives
// duration from the LOCKED service row, derives end time, status, owner
// practitioner and the capacity/buffer columns, and re-validates
// studio/client/service tenancy and the full public availability contract under
// the studio lock — independently of the re-check below. There is no parameter
// for a custom duration, an outside-hours override or a status, so this caller
// cannot request one. It also writes the mandatory appointment_audit row in the
// same transaction.
//
// So a bug here cannot create an appointment for a client of another studio:
// the database refuses it.
//
// NO MIGRATION. The command already accepts p_client_id and validates it. The
// emergency needed a caller, not new schema.

/** A refusal a returning client can act on, or a booking that happened. */
export type PortalRebookResult =
  | { ok: true; startsAt: string; serviceName: string }
  | { ok: false; error: string };

export type PortalRebookSlotsResult =
  | { ok: true; slots: readonly string[] }
  | { ok: false; error: string };

// One sentence for every refusal that is not the client's to fix. The public
// route takes the same stance: a refusal must not tell an unauthenticated
// reader which dimension failed, because that difference is an enumeration
// channel. "Time taken" is the one exception — it is actionable and reveals
// nothing, since the slot list is already public.
const GENERIC_REFUSAL =
  "We couldn't complete this booking. Please choose another time or contact the studio.";
const NO_SESSION =
  "Your session has expired. Please sign in again to book.";
const TIME_TAKEN =
  "That time is no longer available. Please choose another time.";

type StudioRow = {
  id: string;
  timezone: string;
  default_appointment_duration_minutes: number;
  buffer_minutes: number;
};

/**
 * Resolve the session and the studio it points at.
 *
 * Returns the STUDIO ROW rather than an id so callers cannot accidentally
 * re-read it from something submitted.
 */
async function resolveSessionStudio(): Promise<
  | { ok: true; studio: StudioRow; clientId: string }
  | { ok: false; error: string }
> {
  const session = await getCurrentPortalSession();
  if (!session) return { ok: false, error: NO_SESSION };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("studios")
    .select(
      "id, timezone, default_appointment_duration_minutes, buffer_minutes",
    )
    .eq("id", session.studioId)
    .maybeSingle();

  // A FAILED READ IS NOT A MISSING STUDIO, and neither is the client's fault,
  // so both collapse to the same sentence rather than inventing a cause.
  if (error || !data) {
    console.error(
      JSON.stringify({
        event: "portal_rebook_studio_lookup_failed",
        code: error?.code ?? null,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: GENERIC_REFUSAL };
  }

  return { ok: true, studio: data as StudioRow, clientId: session.clientId };
}

/**
 * The services this studio currently offers, for this session's studio only.
 *
 * Scoped by the SESSION's studio id, never by anything submitted.
 */
export async function loadPortalRebookServicesAction(): Promise<
  { ok: true; services: readonly { id: string; name: string }[] } | { ok: false; error: string }
> {
  const resolved = await resolveSessionStudio();
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const services = await getActiveServices(resolved.studio.id);
  return {
    ok: true,
    services: services.map((s) => ({ id: s.id, name: s.name })),
  };
}

/**
 * Offerable start times for one service on one studio-local date.
 *
 * Same generator the public route uses, so the portal cannot offer a slot the
 * public surface would refuse, nor miss one it would offer.
 */
export async function loadPortalRebookSlotsAction(
  serviceId: string,
  dateStr: string,
): Promise<PortalRebookSlotsResult> {
  const resolved = await resolveSessionStudio();
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const admin = createAdminClient();
  const services = await getActiveServices(resolved.studio.id);
  const service = services.find((s) => s.id === serviceId);

  // TENANCY AND ACTIVENESS IN ONE CHECK. `getActiveServices` is already scoped
  // to the session's studio, so a service id from another studio simply is not
  // in the list — there is no separate "wrong studio" branch to get wrong.
  if (!service) return { ok: false, error: GENERIC_REFUSAL };

  const slots = await getAvailableSlots(
    admin,
    {
      id: resolved.studio.id,
      timezone: resolved.studio.timezone,
      default_appointment_duration_minutes:
        resolved.studio.default_appointment_duration_minutes,
      buffer_minutes: resolved.studio.buffer_minutes,
    },
    dateStr,
    service.default_duration_minutes,
  );

  return { ok: true, slots: slots.map((s) => s.start) };
}

/**
 * Book another appointment as the client this session already proved.
 */
export async function bookAnotherAppointmentAction(
  formData: FormData,
): Promise<PortalRebookResult> {
  const resolved = await resolveSessionStudio();
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { studio, clientId } = resolved;

  // CHOICES ONLY. Note what is absent: no email, no name, no client id, no
  // studio id. Adding any of them would recreate the gap this unit exists to
  // avoid, so their absence is the contract.
  const serviceId = String(formData.get("serviceId") ?? "").trim();
  const startsAtRaw = String(formData.get("startsAt") ?? "").trim();
  if (serviceId.length === 0 || startsAtRaw.length === 0) {
    return { ok: false, error: GENERIC_REFUSAL };
  }

  const start = new Date(startsAtRaw);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: GENERIC_REFUSAL };
  }

  const admin = createAdminClient();
  const services = await getActiveServices(studio.id);
  const service = services.find((s) => s.id === serviceId);
  if (!service) return { ok: false, error: GENERIC_REFUSAL };

  // Re-verify the slot against the STUDIO-LOCAL date. Using the UTC date would
  // look up the wrong day for a late-evening booking west of UTC — the same
  // trap the public route documents.
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
  const free = slots.some(
    (s) => new Date(s.start).getTime() === start.getTime(),
  );
  if (!free) return { ok: false, error: TIME_TAKEN };

  const appointmentToken = generateAppointmentToken();
  const { data: rpcRows, error: rpcErr } = await admin.rpc(
    "create_public_appointment",
    {
      // BOTH SERVER-DERIVED. This is the line the whole unit is about.
      p_studio_id: studio.id,
      p_client_id: clientId,
      p_service_id: serviceId,
      p_starts_at: start.toISOString(),
      p_cancellation_token_hash: hashAppointmentToken(appointmentToken),
      p_notes: null,
      p_referral_source: null,
    },
  );

  if (rpcErr) {
    console.error(
      JSON.stringify({
        event: "portal_rebook_commit_failed",
        code: rpcErr.code,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: GENERIC_REFUSAL };
  }

  const commandRow = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const result = (commandRow?.result as string | undefined) ?? null;

  if (result !== "created") {
    // The command's refusal vocabulary is deliberately NOT echoed. `invalid_time`
    // and `not_a_public_slot` are the client's to act on; the rest name a
    // tenancy or eligibility fact an unauthenticated reader must not learn.
    const actionable = result === "invalid_time" || result === "not_a_public_slot";
    return { ok: false, error: actionable ? TIME_TAKEN : GENERIC_REFUSAL };
  }

  revalidatePath("/portal");
  return { ok: true, startsAt: start.toISOString(), serviceName: service.name };
}
