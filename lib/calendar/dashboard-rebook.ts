import { isReportingPeriod, type ReportingPeriod } from "@/lib/booking/reporting-period";
import { isAppointmentUuid } from "@/lib/sessions/session-start-refusal";

export type RebookOrigin = { appointmentId: string; period?: ReportingPeriod };
export type DashboardRebook = RebookOrigin & {
  clientId: string;
  clientName: string;
  serviceId: string | null;
  practitionerId: string | null;
  durationMinutes: number;
  dashboardHref: string;
  next: { label: string; day: string } | "unavailable" | null;
};

export function withDashboardRebook(href: string, origin?: RebookOrigin | null): string {
  if (!origin || !isAppointmentUuid(origin.appointmentId)) return href;
  const [pathname, query] = href.split("?");
  if (pathname !== "/calendar") return href;
  const params = new URLSearchParams(query);
  params.set("rebook", origin.appointmentId);
  if (isReportingPeriod(origin.period)) params.set("rebookPeriod", origin.period);
  return `${pathname}?${params}`;
}

export function dashboardRebookCalendarHref(appointmentId: string, day: string, period?: ReportingPeriod): string {
  return withDashboardRebook(`/calendar?view=week&day=${encodeURIComponent(day)}`, { appointmentId, period });
}
