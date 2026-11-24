"use server";

import { loadSlotsForAuthorizedDates } from "@/lib/booking/public-slot-range";
import { INTERNAL_SLOT_PACKING } from "@/lib/booking/slots";
import { addDays, localDateString, localTimeString } from "@/lib/booking/tz";
import { daysBetween, isRealLocalDate } from "@/lib/business-analytics/period";
import { safeLog } from "@/lib/logging/safe-log";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

export type CalendarOpening = {
  date: string;
  localTime: string;
  start: string;
  end: string;
  practitionerId: string;
  practitionerName: string;
  serviceId: string;
};

type FindTimeInput = {
  serviceId: string;
  practitionerId?: string | null;
  fromDate: string;
  toDate: string;
};

type FindTimeResult =
  | { ok: true; openings: CalendarOpening[]; limited?: true }
  | { ok: false; error: string };

function readFailure(stage: string): FindTimeResult {
  safeLog.error(`calendar_find_time_read_failed:${stage}`);
  return { ok: false, error: "Could not load available times. Please try again." };
}

export async function findCalendarOpeningsAction(params: FindTimeInput): Promise<FindTimeResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) return { ok: false, error: "Your calendar access is inactive." };
  if (!params || typeof params.serviceId !== "string" || !params.serviceId) {
    return { ok: false, error: "Choose a service to find an opening." };
  }
  if (!isRealLocalDate(params.fromDate) || !isRealLocalDate(params.toDate)) {
    return { ok: false, error: "Choose valid start and end dates." };
  }
  const dayCount = daysBetween(params.fromDate, params.toDate) + 1;
  if (dayCount < 1 || dayCount > 7) {
    return { ok: false, error: "Choose a date range of up to seven days." };
  }
  const capacityOn = studio.practitioner_capacity_enabled === true;
  if (capacityOn && studio.practitioner_capacity_booking_enabled !== true) {
    return { ok: false, error: "New bookings are paused for this studio." };
  }
  if (practitioner.role !== "owner" && params.practitionerId && params.practitionerId !== practitioner.id) {
    return { ok: false, error: "You can only book appointments for yourself." };
  }

  const supabase = await createClient();
  const targetId = practitioner.role === "owner" ? params.practitionerId : practitioner.id;
  // Eligibility is enforced by the booking command only in practitioner-capacity mode.
  // A legacy studio has one shared timeline; its practitioners are assignment choices.
  const roster = capacityOn
    ? supabase.from("practitioners").select("id, display_name, service_practitioners!inner(service_id)")
      .eq("service_practitioners.service_id", params.serviceId)
    : supabase.from("practitioners").select("id, display_name");
  const activeRoster = roster.eq("studio_id", studio.id).eq("active", true);
  const [service, targets] = await Promise.all([
    supabase.from("services").select("default_duration_minutes")
      .eq("studio_id", studio.id).eq("id", params.serviceId).eq("active", true).maybeSingle(),
    targetId ? activeRoster.eq("id", targetId) : activeRoster,
  ]);
  if (service.error || targets.error) return readFailure("service_or_practitioners");
  if (!service.data) return { ok: false, error: "That service is no longer available." };
  if (!targets.data?.length) {
    return { ok: false, error: "No available practitioner is assigned to this service." };
  }

  const now = new Date();
  const today = localDateString(now, studio.timezone);
  const dates = Array.from({ length: dayCount }, (_, i) => addDays(params.fromDate, i)).filter(date => date >= today);
  const context = {
    studioId: studio.id,
    timezone: studio.timezone,
    bufferMinutes: studio.buffer_minutes,
    serviceDurationMinutes: service.data.default_duration_minutes,
    practitionerCapacityEnabled: capacityOn,
  };
  const load = (id: string | null) => loadSlotsForAuthorizedDates(
    supabase, { ...context, practitionerId: id }, dates, now, { packing: INTERNAL_SLOT_PACKING },
  );
  const shared = capacityOn ? undefined : await load(null);
  if (shared && !shared.ok) return readFailure("slots");

  const openingsByDate = new Map<string, CalendarOpening[]>();
  const perDay = 48;
  let limited = false;
  // Limit simultaneous range reads. Increasing the search from one to seven days
  // never multiplies the number of database queries for a practitioner.
  const batchSize = 4;
  for (let i = 0; i < targets.data.length; i += batchSize) {
    const batch = targets.data.slice(i, i + batchSize);
    const ranges = await Promise.all(batch.map(target => shared ?? load(target.id)));
    for (const [index, range] of ranges.entries()) {
      if (!range.ok) return readFailure("slots");
      const target = batch[index];
      for (const { date, slots } of range.byDate) {
        const candidates = openingsByDate.get(date) ?? [];
        // Each timeline is chronological. Its 49th offer can never be among
        // the first 48 across the team.
        if (slots.length > perDay) limited = true;
        for (const slot of slots.slice(0, perDay)) {
          candidates.push({
            date,
            localTime: localTimeString(new Date(slot.start), studio.timezone),
            start: slot.start,
            end: slot.end,
            practitionerId: target.id,
            practitionerName: target.display_name,
            serviceId: params.serviceId,
          });
        }
        candidates.sort((a, b) => a.start.localeCompare(b.start)
          || a.practitionerName.localeCompare(b.practitionerName)
          || a.practitionerId.localeCompare(b.practitionerId));
        if (candidates.length > perDay) {
          limited = true;
          candidates.length = perDay;
        }
        openingsByDate.set(date, candidates);
      }
    }
  }
  const openings = dates.flatMap(date => openingsByDate.get(date) ?? []);
  return limited ? { ok: true, openings, limited: true } : { ok: true, openings };
}
