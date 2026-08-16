"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAvailableSlots,
  INTERNAL_SLOT_PACKING,
  type Slot,
} from "@/lib/booking/slots";
import {
  classifyAgainstWindow,
  localInterval,
  readFullDayBlockout,
  resolveAvailabilityWindow,
  type AvailabilityWindow,
} from "@/lib/booking/availability-window";

function logBookingSlotError(stage: string, code: string | undefined): void {
  // Bounded PHI-free marker only, never the raw DB/PostgREST message.
  console.error(`booking_slot_db_error:${stage}:${code ?? "unknown"}`);
}

// Part 4 Item 6: target-aware internal slot loader. An OWNER of a capacity-ON
// studio may request another practitioner's slots (params.practitionerId); every
// other caller (member, or capacity OFF) gets their OWN timeline. A forged or
// non-owner practitionerId is IGNORED here (resolved to self), exactly the rule
// bookAppointmentForClientAction enforces, and the DB command remains the final
// authority at booking time.
// The suggestion list AND the actual availability window for the same
// (studio, practitioner, date). They are returned together, and deliberately
// kept as two separate fields, because they answer two different questions:
//
//   slots   the packed SUGGESTIONS -- a small, efficient subset
//   window  the practitioner's REAL working hours that day
//
// The window travels to the browser so a manually typed time can be classified
// with the SAME pure predicate the server uses when it accepts the booking
// (classifyAgainstWindow). The alternative -- letting the browser infer "inside
// hours" from the suggestion list -- is exactly the conflation this change
// exists to remove, and would have re-created it one layer up.
//
// The browser's verdict decides COPY ONLY. It is never sent back and never
// trusted: bookAppointmentForClientAction independently re-resolves the window
// server-side from the server-resolved studio and target before accepting
// anything.
export type SlotResult =
  | { ok: true; slots: Slot[]; window: AvailabilityWindow }
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
    // Fixed copy, never reveals whether a FOREIGN id exists.
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

  // The real availability window for the SAME (studio, target, date) the slots
  // were generated for. Resolved through the shared resolver, so the window the
  // browser renders copy from and the window the booking action enforces are
  // one implementation.
  //
  // A blockout is reported as a CLOSED window: on a blocked-out day there is no
  // manual time to offer, and the booking action independently refuses it. A
  // failed blockout read also resolves to closed here, matching the fail-closed
  // policy of the booking action rather than the slot engine's older
  // continue-anyway behaviour -- the cost of being wrong is a manual-time field
  // that stays hidden, never a booking on a day off.
  const blockout = await readFullDayBlockout(supabase, studio.id, params.date);
  const window: AvailabilityWindow =
    // A blockout ROW is knowledge: the day is closed. A failed READ is not, and
    // must not be rendered as a factual "not working" state -- doing so made
    // windowKnown true and exposed the owner acknowledgement, which would
    // persist a false exception. UNKNOWN blocks the manual path instead.
    blockout.readFailed
      ? { kind: "unknown" }
      : blockout.blocked
        ? { kind: "closed" }
        : await resolveAvailabilityWindow(
          supabase,
          {
            id: studio.id,
            timezone: studio.timezone,
            practitioner_capacity_enabled: studio.practitioner_capacity_enabled,
          },
          params.date,
          capacityOn ? target : null,
        );

  // ONE RESPONSE MAY NOT ASSERT CONTRADICTORY BOOKING FACTS.
  //
  // `slots` and `window` come from TWO INDEPENDENT read sequences: the slot
  // engine does its own blockout + availability reads, and the strict companion
  // resolution above does them again. Nothing reconciled them, so a single
  // response could say "availability could not be verified" while handing the
  // practitioner bookable suggestions produced moments earlier -- and the
  // suggestion path needs no window at all to submit.
  //
  // The companion resolution is the STRICTER, later read, so it is the
  // presentation authority. The response is made coherent HERE, on the server,
  // before React ever sees it -- a UI check alone would leave the contradictory
  // payload available to any other caller.
  //
  //   unknown -> [] : we could not verify; offer nothing.
  //   closed  -> [] : the day is closed; there is nothing to offer.
  //   open    -> every surviving slot must still fit THAT window.
  //
  // The open case matters as much as the unknown one: the window can also have
  // NARROWED between the two reads, which would otherwise leave a stale late
  // suggestion sitting next to a window that no longer contains it. Judged with
  // the SAME shared classifier the booking action and both surfaces use --
  // there is deliberately no second hours algorithm here.
  //
  // This changes PRESENTATION only. The database remains the final booking
  // authority, and appointment overlap / buffer races are still its job.
  const coherentSlots =
    window.kind === "open"
      ? slots.filter(
          (s) =>
            classifyAgainstWindow(
              window,
              localInterval(
                new Date(s.start),
                service.default_duration_minutes,
                studio.timezone,
              ),
            ) === "inside_availability",
        )
      : [];

  return { ok: true, slots: coherentSlots, window };
}

export type EligiblePractitioner = { id: string; displayName: string };

// Part 4 Item 6: the owner-only practitioner selector's option list: the ACTIVE,
// same-studio practitioners ELIGIBLE for the chosen service. Returns an EMPTY list
// for a member or a capacity-OFF studio (no selector is shown there). Display
// names only, never email/ids/metadata. RLS-scoped reads (service_practitioners
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
