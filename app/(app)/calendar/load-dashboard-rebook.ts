import "server-only";
import { isReportingPeriod } from "@/lib/booking/reporting-period";
import { formatTimeForStudio, localDateString, type TimeFormat } from "@/lib/booking/tz";
import type { DashboardRebook } from "@/lib/calendar/dashboard-rebook";
import { clientDisplayName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";
import { dashboardDayHref } from "@/lib/dashboard/day-navigation";
import { getNextVisitsForRoster } from "@/lib/dashboard/next-visit-for-roster";
import { dbErrorCode } from "@/lib/logging/error-class";
import { isAppointmentUuid } from "@/lib/sessions/session-start-refusal";
import { createClient } from "@/lib/supabase/server";

type Source = {
  id: string;
  client_id: string;
  service_id: string | null;
  practitioner_id: string | null;
  starts_at: string;
  ends_at: string;
  client: { name: string; preferred_name?: string | null; archived_at: string | null } | null;
};

export async function loadDashboardRebook(
  appointmentId: string | undefined,
  rawPeriod: string | undefined,
  studio: { id: string; timezone: string },
  today: string,
  timeFormat: TimeFormat,
): Promise<DashboardRebook | null> {
  if (!appointmentId || !isAppointmentUuid(appointmentId)) return null;

  const db = await createClient();
  const { data: source, error } = await readWithPreferredName(includePreferred =>
    db.from("appointments")
      .select(`id, client_id, service_id, practitioner_id, starts_at, ends_at,
        client:clients!appointments_client_same_studio_fk(name, ${preferredNameColumn(includePreferred)}archived_at)`)
      .eq("studio_id", studio.id)
      .eq("id", appointmentId)
      .maybeSingle<Source>()
  );
  if (error) throw new Error(`db_error:${dbErrorCode(error)}`);
  if (!source?.client || source.client.archived_at) return null;

  const period = isReportingPeriod(rawPeriod) ? rawPeriod : undefined;
  const sourceDay = localDateString(new Date(source.starts_at), studio.timezone);
  let next: DashboardRebook["next"] = null;
  try {
    const upcoming = await getNextVisitsForRoster(db, studio.id, [source], new Date().toISOString());
    const nextVisit = upcoming.get(source.id);
    if (nextVisit) {
      const date = new Date(nextVisit.starts_at);
      const dateLabel = date.toLocaleDateString("en-CA", {
        month: "short", day: "numeric", year: "numeric", timeZone: studio.timezone,
      });
      const timeLabel = formatTimeForStudio(date, studio.timezone, timeFormat);
      next = {
        day: localDateString(date, studio.timezone),
        label: `${dateLabel} · ${timeLabel} · ${nextVisit.service?.name ?? "Service not recorded"}`,
      };
    }
  } catch {
    next = "unavailable";
  }

  // The return path comes from the studio-authorized visit, never a URL in the request.
  const dashboard = dashboardDayHref({ day: sourceDay, todayLocal: today, period });
  return {
    appointmentId: source.id,
    period,
    clientId: source.client_id,
    clientName: clientDisplayName(source.client),
    serviceId: source.service_id,
    practitionerId: source.practitioner_id,
    durationMinutes: Math.round((Date.parse(source.ends_at) - Date.parse(source.starts_at)) / 60000),
    dashboardHref: `${dashboard}#appointment-${source.id}`,
    next,
  };
}
