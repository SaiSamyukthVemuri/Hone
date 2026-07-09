import { notFound } from "next/navigation";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";
import type { StudioTimedBlock } from "@/lib/types/database";
import { addDays, todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import { monthDayLabel, weekdayLabel } from "@/app/(app)/calendar/calendar-format";
import type { MobileDayData } from "@/app/(app)/calendar/CalendarMobileDayView";
import { MobilePreviewShell } from "./MobilePreviewShell";

// PREVIEW-ONLY, AUTH-FREE mobile-calendar movement harness (PR #380).
//
// Why this exists: the real /calendar requires practitioner auth, and on a
// Vercel Preview deploy the magic-link/OAuth redirect bounces back to the
// production domain (getRequiredAppOrigin -> NEXT_PUBLIC_APP_ORIGIN; Supabase
// redirect allowlist excludes the preview host). That makes the mobile calendar
// impossible to test on a phone. This page renders the REAL MobileDayTimeline
// with entirely FAKE data and no login, so the *movement model* can be felt on
// a phone before merge.
//
// Safety:
//   * 404s in production (VERCEL_ENV === "production") — never on hone.care.
//   * No auth, no Supabase, no DB read/write — zero real client data.
//   * Booking/edit is inert (taps show a note); no server actions run.
//   * noindex.
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Mobile calendar preview",
  robots: { index: false, follow: false },
};

const TZ = "America/New_York";
const TIME_FORMAT = "12h" as const;

function fakeAppt(
  date: string,
  open: string,
  close: string,
  name: string,
  serviceId: string,
  serviceName: string,
): AppointmentWithPractitionerColor {
  const starts_at = utcInstantFromLocal(date, open, TZ);
  const ends_at = utcInstantFromLocal(date, close, TZ);
  const duration_minutes = Math.round(
    (new Date(ends_at).getTime() - new Date(starts_at).getTime()) / 60_000,
  );
  return {
    id: `preview-${date}-${open}`,
    starts_at,
    ends_at,
    duration_minutes,
    status: "confirmed",
    client: { id: "preview-client", name },
    service: { id: serviceId, name: serviceName, modality: null },
    practitioner: null,
  } as unknown as AppointmentWithPractitionerColor;
}

function fakeBlock(date: string, open: string, close: string): StudioTimedBlock {
  return {
    id: `preview-block-${date}-${open}`,
    starts_at: utcInstantFromLocal(date, open, TZ),
    ends_at: utcInstantFromLocal(date, close, TZ),
    category: "break",
    private_note: "Lunch",
  } as unknown as StudioTimedBlock;
}

export default function MobileCalendarPreviewPage() {
  // Hard gate: this route must never resolve on production.
  if (process.env.VERCEL_ENV === "production") {
    notFound();
  }

  const today = todayInTz(TZ);
  // Five demo days centered on today so the now-line + day nav can be felt.
  const dates = [-2, -1, 0, 1, 2].map((n) => addDays(today, n));

  const apptsByDate: Record<string, AppointmentWithPractitionerColor[]> = {
    [today]: [
      fakeAppt(today, "09:00", "10:00", "Ava Chen", "svc-a", "Electrolysis 60"),
      fakeAppt(today, "11:30", "12:15", "Jordan Lee", "svc-b", "Consultation"),
      fakeAppt(today, "15:00", "16:30", "Sam Rivera", "svc-a", "Electrolysis 90"),
    ],
    [addDays(today, 1)]: [
      fakeAppt(addDays(today, 1), "10:00", "11:00", "Priya N.", "svc-c", "Laser"),
    ],
  };
  const blocksByDate: Record<string, StudioTimedBlock[]> = {
    [today]: [fakeBlock(today, "12:30", "13:30")],
  };

  const days: MobileDayData[] = dates.map((date) => ({
    date,
    weekdayShort: weekdayLabel(new Date(`${date}T12:00:00Z`).getUTCDay()),
    monthDayLabel: monthDayLabel(date),
    appts: apptsByDate[date] ?? [],
    timedBlocks: blocksByDate[date] ?? [],
    recurringBreaks: [],
    availability: {
      isOpen: true,
      openTime: "09:00",
      closeTime: "18:00",
    } as MobileDayData["availability"],
    closedDay: false,
    blocked: false,
    blockedReason: null,
    isToday: date === today,
  }));

  return (
    <MobilePreviewShell
      days={days}
      initialDate={today}
      today={today}
      tz={TZ}
      timeFormat={TIME_FORMAT}
    />
  );
}
