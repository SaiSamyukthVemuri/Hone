"use server";

import { BILLING_LOCK_STAFF_MESSAGE, isBillingLockError } from "@/lib/subscriptions/lock-message";
import { revalidatePath } from "next/cache";
import { daysBetween, isRealLocalDate } from "@/lib/business-analytics/period";
import { bookingClient, deskText, instant, validDeskId, type DeskBookingClient, type DeskBookingOptions, type DeskOpening, type DeskResult } from "@/lib/desk/booking";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import { isUsableTimeZone } from "@/lib/desk/time";
import { createClient } from "@/lib/supabase/server";

const studioChanged = { ok: false, error: "Your selected studio changed. Reload the desk before continuing." } as const;
const staleOpening = { ok: false, error: "That opening is no longer available. Search for another time." } as const;
const uncertainBooking = { ok: false, error: "We couldn’t confirm whether this booking was saved. Check the desk schedule before trying again." } as const;

export async function getDeskBookingOptionsAction(): Promise<DeskResult<DeskBookingOptions>> {
  const { studioId } = await requireReceptionistWithStudio();
  const db = await createClient();
  const [options, clock] = await Promise.all([
    db.rpc("receptionist_booking_options", { p_studio_id: studioId }),
    db.rpc("receptionist_studio_timezone", { p_studio_id: studioId }),
  ]);
  if (options.error || clock.error || !Array.isArray(options.data) || options.data.length >= 1000
    || typeof clock.data !== "string" || !isUsableTimeZone(clock.data)) {
    return { ok: false, error: "Could not load booking options. Try again." };
  }
  const services: DeskBookingOptions["services"] = [];
  const practitioners: DeskBookingOptions["practitioners"] = [];
  for (const row of options.data) {
    const name = deskText(row?.name);
    if (!name || !validDeskId(row?.id)) return { ok: false, error: "Booking options are incomplete. Try again." };
    if (row.kind === "practitioner") practitioners.push({ id: row.id, name });
    else if (row.kind === "service" && Number.isInteger(row.duration_minutes) && row.duration_minutes > 0) {
      services.push({ id: row.id, name, durationMinutes: row.duration_minutes });
    } else return { ok: false, error: "Booking options are incomplete. Try again." };
  }
  return { ok: true, studioId, timezone: clock.data, services, practitioners };
}

export async function searchDeskBookingClientsAction(input: { studioId: string; query: string }): Promise<DeskResult<{ clients: DeskBookingClient[] }>> {
  const { studioId } = await requireReceptionistWithStudio();
  if (input?.studioId !== studioId) return studioChanged;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length < 2 || query.length > 80) return { ok: false, error: "Enter 2 to 80 characters to find a client." };
  const db = await createClient();
  const search = await db.rpc("receptionist_booking_clients_v3", { p_studio_id: studioId, p_query: query, p_limit: 11 });
  if (search.error || !Array.isArray(search.data)) return { ok: false, error: "Could not search for clients. Try again." };
  // An omitted eleventh match could make two indistinguishable clients look unique.
  if (search.data.length > 10) return { ok: false, error: "Many clients match. Enter more of the name, phone number, or email." };
  const clients: DeskBookingClient[] = [];
  for (const row of search.data) {
    const match = row && bookingClient(row);
    if (!match) return { ok: false, error: "Could not read the matching clients. Try again." };
    clients.push(match);
  }
  return { ok: true, clients };
}

export async function findDeskOpeningsAction(input: {
  studioId: string; serviceId: string; practitionerIds: string[]; fromDate: string; toDate: string;
  earliest: string; latestEnd: "12:00" | null;
}): Promise<DeskResult<{ openings: DeskOpening[]; limited?: true }>> {
  const { studioId } = await requireReceptionistWithStudio();
  if (input?.studioId !== studioId) return studioChanged;
  if (!validDeskId(input.serviceId) || !Array.isArray(input.practitionerIds) || !input.practitionerIds.length
    || !input.practitionerIds.every(validDeskId)) {
    return { ok: false, error: "Choose a service and practitioner." };
  }
  if (input.practitionerIds.length > 100) return { ok: false, error: "Select up to 100 practitioners to compare openings." };
  if (typeof input.earliest !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.earliest)
    || (input.latestEnd !== null && (input.latestEnd !== "12:00" || input.latestEnd <= input.earliest))) {
    return { ok: false, error: "Choose an earliest start within your time window." };
  }
  if (!isRealLocalDate(input.fromDate) || !isRealLocalDate(input.toDate) || input.fromDate > input.toDate
    || daysBetween(input.fromDate, input.toDate) > 6) {
    return { ok: false, error: "Choose a date range of up to seven days." };
  }
  const db = await createClient();
  const result = await db.rpc("receptionist_find_openings_v2", {
    p_studio_id: studioId, p_service_id: input.serviceId, p_practitioner_ids: input.practitionerIds,
    p_from_date: input.fromDate, p_to_date: input.toDate, p_earliest: input.earliest, p_latest_end: input.latestEnd,
  });
  const failed = { ok: false, error: "Could not load available times. Try again." } as const;
  if (result.error || !Array.isArray(result.data) || result.data.length > 336) return failed;
  let limited = false;
  const openings: DeskOpening[] = [];
  for (const row of result.data) {
    if (!row || !validDeskId(row.practitioner_id) || !deskText(row.practitioner_name) || !instant(row.starts_at) || !instant(row.ends_at)
      || Date.parse(row.starts_at) >= Date.parse(row.ends_at) || !isRealLocalDate(row.local_date)
      || row.local_date < input.fromDate || row.local_date > input.toDate
      || typeof row.local_time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.local_time)
      || typeof row.has_more !== "boolean" || !input.practitionerIds.includes(row.practitioner_id) || row.local_time < input.earliest) return failed;
    limited ||= row.has_more;
    openings.push({
      start: row.starts_at, end: row.ends_at, date: row.local_date, localTime: row.local_time,
      practitionerId: row.practitioner_id, practitionerName: deskText(row.practitioner_name), serviceId: input.serviceId,
    });
  }
  return limited ? { ok: true, openings, limited } : { ok: true, openings };
}

const refusalMessages: Record<string, string> = {
  not_authorized: "You no longer have access to book at this studio.",
  invalid_client: "This client is no longer available. Find the client again.",
  invalid_practitioner: "That practitioner is no longer available. Search again.",
  not_eligible: "This practitioner cannot perform this service. Search again.",
  invalid_service: "That service is no longer available. Choose another service.",
  booking_paused: "New bookings are paused for this studio.",
  invalid_time: staleOpening.error,
  invalid_duration: staleOpening.error,
  practitioner_closed: staleOpening.error,
  outside_availability: staleOpening.error,
  buffer_conflict: staleOpening.error,
  opening_unavailable: staleOpening.error,
};

export async function bookDeskOpeningAction(input: {
  studioId: string; clientId: string; serviceId: string; practitionerId: string; start: string; end: string;
}): Promise<DeskResult<object>> {
  const { studioId } = await requireReceptionistWithStudio();
  if (input?.studioId !== studioId) return studioChanged;
  if (![input.clientId, input.serviceId, input.practitionerId].every(validDeskId)) {
    return { ok: false, error: "Choose a client, service and practitioner." };
  }
  if (!instant(input.start) || !instant(input.end) || Date.parse(input.start) <= Date.now() || Date.parse(input.end) <= Date.parse(input.start)) return staleOpening;
  const db = await createClient();
  try {
    const booked = await db.rpc("receptionist_book_opening", {
      p_studio_id: studioId, p_client_id: input.clientId, p_service_id: input.serviceId, p_practitioner_id: input.practitionerId,
      p_start: input.start, p_expected_end: input.end,
    });
    if (isBillingLockError(booked.error)) return { ok: false, error: BILLING_LOCK_STAFF_MESSAGE };
    if (booked.error?.code === "23P01") return staleOpening;
    if (booked.error?.code === "42501") return { ok: false, error: refusalMessages.not_authorized };
    if (booked.error || !Array.isArray(booked.data) || booked.data.length !== 1) return uncertainBooking;
    const row = booked.data[0];
    if (row?.result !== "created" || !validDeskId(row.appointment_id)) {
      return { ok: false, error: typeof row?.result === "string" && Object.hasOwn(refusalMessages, row.result)
        ? refusalMessages[row.result] : uncertainBooking.error };
    }
  } catch {
    return uncertainBooking;
  }
  // The RPC has committed. Refresh failures must not encourage a second booking.
  try {
    revalidatePath("/desk");
    revalidatePath("/calendar");
    revalidatePath("/calendar/upcoming");
    revalidatePath("/dashboard");
    revalidatePath(`/clients/${input.clientId}`);
  } catch { /* the desk also refreshes after a successful booking */ }
  return { ok: true };
}
