import { StaffWelcome } from "@/components/onboarding/staff-welcome";
import { createClient } from "@/lib/supabase/server";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import { DeskScheduleIncompleteError, readDeskSchedule, type DeskRpc } from "@/lib/desk/read";
import { addDays, todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import { isRealLocalDate } from "@/lib/business-analytics/period";
import { getDeskBookingOptionsAction } from "./booking-actions";
import { DeskCalendar } from "./DeskCalendar";
import { DeskBooking } from "./DeskBooking";
import { ClockFallbackNotice } from "./ClockFallbackNotice";
import { deskDays, type DeskView } from "./desk-period";

export const dynamic = "force-dynamic";

type Params = { date?: string | string[]; view?: string | string[] };

export default async function DeskSchedulePage({ searchParams }: { searchParams: Promise<Params> }) {
  const identity = await requireReceptionistWithStudio();
  const params = await searchParams;
  const options = await getDeskBookingOptionsAction().catch(() => null);
  const booking = options?.ok && options.studioId === identity.studioId ? options : null;
  const timezone = booking?.timezone ?? "UTC";
  const today = todayInTz(timezone);
  const date = isRealLocalDate(params.date) ? params.date : today;
  const view: DeskView = params.view === "day" || params.view === "week" ? params.view : "month";
  const days = deskDays(date, view);

  try {
    const db = (await createClient()) as unknown as DeskRpc;
    const rows = await readDeskSchedule(db, identity.studioId,
      utcInstantFromLocal(days[0], "00:00", timezone).toISOString(),
      utcInstantFromLocal(addDays(days[days.length - 1], 1), "00:00", timezone).toISOString());
    return (
      <>
        <StaffWelcome role="receptionist" membershipId={identity.receptionistId} booking={Boolean(booking)} />
        {!booking && <ClockFallbackNotice timezones={[null]} />}
        <DeskCalendar key={identity.receptionistId + identity.studioId} studioId={identity.studioId}
          today={today} date={date} view={view} timezone={timezone} rows={rows} booking={booking} />
      </>
    );
  } catch (e) {
    return <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Schedule</h1>
      <p role="alert">{e instanceof DeskScheduleIncompleteError
        ? "Schedule incomplete. Too many appointments for this period."
        : "The schedule is unavailable right now. Try again in a moment."}</p>
      <a href={`/desk?date=${date}&view=day`} className="underline">Open day calendar</a>
      <DeskBooking studioId={identity.studioId} initialDate={date} options={booking ?? undefined} />
    </section>;
  }
}
