import "server-only";
import { createClient } from "@/lib/supabase/server";

// STUDIO-READY-02d (#824): the receptionist's ONLY data reads.
//
// Each call goes to a 0216 projection with the receptionist's OWN session. The
// database derives the actor from auth.uid() and refuses anyone who is not an
// active receptionist of the studio (42501). No actor id is ever passed in. The
// projections return fixed columns, with no notes, prices, payment state or
// clinical fields, and they bound their own window and result size.
//
// The front desk must read through this module and nothing else. That rule is
// pinned in tests/app/front-desk/front-desk-boundary.test.ts.

export type FrontDeskAppointment = {
  appointment_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  practitioner_id: string | null;
  practitioner_display_name: string | null;
  practitioner_color: string | null;
  service_id: string | null;
  service_name: string | null;
  client_id: string | null;
  client_display_name: string | null;
};

export type FrontDeskClosure = {
  source_kind: string;
  starts_at: string;
  ends_at: string;
  resource_practitioner_id: string | null;
};

export type FrontDeskContact = {
  client_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  intake_status: string;
  intake_submitted_at: string | null;
  consent_accepted_at: string | null;
};

function fail(what: string, code: string | undefined): never {
  // Code only. Never the database message, which can echo inputs.
  throw new Error(`front_desk_${what}_failed:${code ?? "unknown"}`);
}

export async function getFrontDeskCalendar(
  studioId: string,
  fromIso: string,
  toIso: string,
): Promise<{ appointments: FrontDeskAppointment[]; closures: FrontDeskClosure[] }> {
  const supabase = await createClient();
  const [appts, closures] = await Promise.all([
    supabase.rpc("receptionist_calendar", { p_studio_id: studioId, p_from: fromIso, p_to: toIso }),
    supabase.rpc("receptionist_calendar_closures", { p_studio_id: studioId, p_from: fromIso, p_to: toIso }),
  ]);
  if (appts.error) fail("calendar", appts.error.code);
  if (closures.error) fail("closures", closures.error.code);
  return {
    appointments: (appts.data ?? []) as FrontDeskAppointment[],
    closures: (closures.data ?? []) as FrontDeskClosure[],
  };
}

/** A query shorter than two characters is not sent; the database would refuse it. */
export async function searchFrontDeskContacts(
  studioId: string,
  query: string | null,
): Promise<FrontDeskContact[]> {
  const q = query?.trim() ?? "";
  if (q.length > 0 && q.length < 2) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("receptionist_client_contacts", {
    p_studio_id: studioId,
    p_query: q.length === 0 ? null : q,
    p_limit: 25,
  });
  if (error) fail("contacts", error.code);
  return (data ?? []) as FrontDeskContact[];
}

export type FrontDeskBookingOptions = {
  services: Array<{ id: string; name: string; durationMinutes: number }>;
  practitioners: Array<{ id: string; name: string; color: string | null }>;
};

/** The booking form's choices (0220): active services and bookable practitioners. */
export async function getFrontDeskBookingOptions(studioId: string): Promise<FrontDeskBookingOptions> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("receptionist_booking_options", { p_studio_id: studioId });
  if (error) fail("booking_options", error.code);
  const rows = (data ?? []) as Array<{
    kind: string;
    id: string;
    name: string | null;
    duration_minutes: number | null;
    color: string | null;
  }>;
  return {
    services: rows
      .filter((r) => r.kind === "service")
      .map((r) => ({ id: r.id, name: r.name ?? "Service", durationMinutes: r.duration_minutes ?? 0 })),
    practitioners: rows
      .filter((r) => r.kind === "practitioner")
      .map((r) => ({ id: r.id, name: r.name ?? "Practitioner", color: r.color })),
  };
}
