"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAvailableSlots,
  INTERNAL_SLOT_PACKING,
  type Slot,
} from "@/lib/booking/slots";

function logBookingSlotError(stage: string, code: string | undefined): void {
  // Bounded PHI-free marker only — never the raw DB/PostgREST message.
  console.error(`booking_slot_db_error:${stage}:${code ?? "unknown"}`);
}

// Part 4 Item 6: target-aware internal slot loader. An OWNER of a capacity-ON
// studio may request another practitioner's slots (params.practitionerId); every
// other caller (member, or capacity OFF) gets their OWN timeline. A forged or
// non-owner practitionerId is IGNORED here (resolved to self) — exactly the rule
// bookAppointmentForClientAction enforces — and the DB command remains the final
// authority at booking time.
export type SlotResult =
  | { ok: true; slots: Slot[] }
  | { ok: false; error: string; code?: string };

export async function fetchSlotsForClientBookingAction(params: {
  serviceId: string;
  date: string;
  practitionerId?: string | null;
}): Promise<SlotResult> {
  if (!params.serviceId || !params.date) {
    return { ok: false, error: "Pick a service and date.", code: "invalid_input" };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  const { data: service, error: serviceErr } = await supabase
    .from("services")
    .select("default_duration_minutes")
    .eq("id", params.serviceId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (serviceErr) {
    logBookingSlotError("service_lookup", serviceErr.code);
    return { ok: false, error: "Could not load times. Please try again.", code: "could_not_load_times" };
  }
  if (!service) return { ok: false, error: "Service not found.", code: "service_not_found" };

  // Item 6 (1A): resolve + VALIDATE the target BEFORE generating slots. Only an
  // owner of a capacity-ON studio may target another practitioner; the target must
  // be same-studio + active + eligible for the service. A member's (or any
  // non-owner's) supplied id is ignored → self. Legacy ignores the dimension.
  const capacityOn = studio.practitioner_capacity_enabled === true;
  let target = practitioner.id;
  if (capacityOn && practitioner.role === "owner" && params.practitionerId) {
    const { data: t, error: tErr } = await supabase
      .from("practitioners")
      .select("id")
      .eq("id", params.practitionerId)
      .eq("studio_id", studio.id)
      .eq("active", true)
      .maybeSingle();
    if (tErr) {
      logBookingSlotError("target_lookup", tErr.code);
      return { ok: false, error: "Could not load times. Please try again.", code: "could_not_load_times" };
    }
    // Fixed copy — never reveals whether a FOREIGN id exists.
    if (!t) return { ok: false, error: "That practitioner isn't available.", code: "invalid_practitioner" };

    const { data: elig, error: eligErr } = await supabase
      .from("service_practitioners")
      .select("practitioner_id")
      .eq("service_id", params.serviceId)
      .eq("practitioner_id", params.practitionerId)
      .eq("studio_id", studio.id)
      .maybeSingle();
    if (eligErr) {
      logBookingSlotError("target_eligibility", eligErr.code);
      return { ok: false, error: "Could not load times. Please try again.", code: "could_not_load_times" };
    }
    if (!elig) {
      return { ok: false, error: "That practitioner isn't set up for this service.", code: "practitioner_not_eligible" };
    }
    target = params.practitionerId;
  }

  const slots = await getAvailableSlots(
    supabase,
    {
      id: studio.id,
      timezone: studio.timezone,
      default_appointment_duration_minutes:
        studio.default_appointment_duration_minutes,
      buffer_minutes: studio.buffer_minutes,
      practitioner_capacity_enabled: studio.practitioner_capacity_enabled,
    },
    params.date,
    service.default_duration_minutes,
    undefined,
    // Legacy (flag off) ignores the id → studio-wide, exactly as today.
    capacityOn ? target : null,
    INTERNAL_SLOT_PACKING,
  );
  return { ok: true, slots };
}

export type EligiblePractitioner = { id: string; displayName: string };

// Part 4 Item 6: the owner-only practitioner selector's option list — the ACTIVE,
// same-studio practitioners ELIGIBLE for the chosen service. Returns an EMPTY list
// for a member or a capacity-OFF studio (no selector is shown there). Display
// names only — never email/ids/metadata. RLS-scoped reads (service_practitioners
// member_select + studio-scoped practitioners); the target is revalidated in the
// DB command regardless.
export async function fetchEligiblePractitionersAction(
  serviceId: string,
): Promise<{ ok: true; practitioners: EligiblePractitioner[] } | { ok: false; error: string }> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (studio.practitioner_capacity_enabled !== true || practitioner.role !== "owner") {
    return { ok: true, practitioners: [] };
  }
  if (!serviceId) return { ok: true, practitioners: [] };

  const supabase = await createClient();
  const { data: elig, error: eligErr } = await supabase
    .from("service_practitioners")
    .select("practitioner_id")
    .eq("service_id", serviceId)
    .eq("studio_id", studio.id);
  if (eligErr) {
    logBookingSlotError("eligibility_lookup", eligErr.code);
    return { ok: false, error: "Could not load practitioners. Please try again." };
  }
  const ids = (elig ?? []).map((r) => r.practitioner_id as string);
  if (ids.length === 0) return { ok: true, practitioners: [] };

  const { data: pracs, error: pracErr } = await supabase
    .from("practitioners")
    .select("id, display_name")
    .eq("studio_id", studio.id)
    .eq("active", true)
    .in("id", ids);
  if (pracErr) {
    logBookingSlotError("practitioner_lookup", pracErr.code);
    return { ok: false, error: "Could not load practitioners. Please try again." };
  }
  const practitioners = (pracs ?? [])
    .map((p) => ({ id: p.id as string, displayName: p.display_name as string }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { ok: true, practitioners };
}
