"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getReceptionistWithStudio } from "@/lib/desk/guard";
import type { DeskRpc } from "@/lib/desk/read";
import {
  UUID,
  UNKNOWN_FAILURE,
  cancelDeskBooking,
  createDeskBooking,
  isCancelReason,
  moveDeskBooking,
  readStudioTimezone,
} from "@/lib/desk/book";
import { studioLocalToInstant } from "@/lib/desk/time";

// The desk's booking actions: book, move, cancel (Sam, 1 Nov). Each resolves the receptionist
// itself (a server action cannot rely on a layout or page guard) and calls the 0220 receptionist
// command through the SIGNED-IN client, so the database derives the actor from the session: nothing
// the form sends names the actor, the studio is the guard's, and no service-role client is used.
//
// Every form value is validated here before it reaches the database (uuids, a real local date and
// time in the STUDIO's zone, a closed cancellation reason); the database re-validates tenancy,
// eligibility and availability. Every outcome is a fixed message: no id, name or time is echoed.

export type DeskActionState = { status: "idle" } | { status: "ok"; message: string } | { status: "error"; message: string };

const BAD_INPUT: DeskActionState = { status: "error", message: "Check the details and try again." };

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v.trim() : "";
}

async function context() {
  const identity = await getReceptionistWithStudio();
  const db = (await createClient()) as unknown as DeskRpc;
  return { identity, db };
}

function outcome(result: { ok: true } | { ok: false; message: string }, done: string): DeskActionState {
  if (result.ok) {
    revalidatePath("/desk");
    return { status: "ok", message: done };
  }
  return { status: "error", message: result.message };
}

export async function bookAppointmentAction(_prev: DeskActionState, formData: FormData): Promise<DeskActionState> {
  try {
    const { identity, db } = await context();
    const clientId = field(formData, "clientId");
    const serviceId = field(formData, "serviceId");
    const practitionerId = field(formData, "practitionerId");
    if (!UUID.test(clientId) || !UUID.test(serviceId) || !UUID.test(practitionerId)) {
      return { status: "error", message: "Choose a client, a service and a practitioner." };
    }
    const tz = await readStudioTimezone(db, identity.studioId);
    const startsAt = studioLocalToInstant(field(formData, "date"), field(formData, "time"), tz);
    if (!startsAt) return { status: "error", message: "Enter a valid date and time." };
    return outcome(await createDeskBooking(db, identity.studioId, { practitionerId, clientId, serviceId, startsAtIso: startsAt }), "Appointment booked.");
  } catch {
    return { status: "error", message: UNKNOWN_FAILURE };
  }
}

export async function moveAppointmentAction(_prev: DeskActionState, formData: FormData): Promise<DeskActionState> {
  try {
    const { identity, db } = await context();
    const appointmentId = field(formData, "appointmentId");
    const practitionerId = field(formData, "practitionerId");
    const expectedStart = field(formData, "expectedStartsAt");
    const expectedEnd = field(formData, "expectedEndsAt");
    if (!UUID.test(appointmentId) || !UUID.test(practitionerId)) return BAD_INPUT;
    if (!Number.isFinite(Date.parse(expectedStart)) || !Number.isFinite(Date.parse(expectedEnd))) return BAD_INPUT;
    const tz = await readStudioTimezone(db, identity.studioId);
    const newStart = studioLocalToInstant(field(formData, "date"), field(formData, "time"), tz);
    if (!newStart) return { status: "error", message: "Enter a valid date and time." };
    return outcome(
      await moveDeskBooking(db, identity.studioId, {
        appointmentId,
        practitionerId,
        expectedStartsAtIso: new Date(expectedStart).toISOString(),
        expectedEndsAtIso: new Date(expectedEnd).toISOString(),
        newStartsAtIso: newStart,
      }),
      "Appointment moved.",
    );
  } catch {
    return { status: "error", message: UNKNOWN_FAILURE };
  }
}

export async function cancelAppointmentAction(_prev: DeskActionState, formData: FormData): Promise<DeskActionState> {
  try {
    const { identity, db } = await context();
    const appointmentId = field(formData, "appointmentId");
    const reason = field(formData, "reason");
    if (!UUID.test(appointmentId) || !isCancelReason(reason)) return BAD_INPUT;
    return outcome(await cancelDeskBooking(db, identity.studioId, { appointmentId, reason }), "Appointment cancelled.");
  } catch {
    return { status: "error", message: UNKNOWN_FAILURE };
  }
}
