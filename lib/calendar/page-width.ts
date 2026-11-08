// HON-48: the calendar grid uses the FULL viewport width (Google Calendar's shape): no centred
// max-width page container, the sidebar on the left and the schedule filling the rest. Every other
// page keeps the app shell's centred column. Only the grid page itself is wide: the appointment
// detail and Upcoming pages under /calendar/... are reading pages and keep the normal width.

export function calendarUsesFullWidth(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return path === "/calendar";
}

export const APP_MAIN_NORMAL = "mx-auto max-w-5xl px-5 py-8 md:px-8 md:py-10";
export const APP_MAIN_FULL = "w-full px-3 py-6 md:px-6 md:py-8";
