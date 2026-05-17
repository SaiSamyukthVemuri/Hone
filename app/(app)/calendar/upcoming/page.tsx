import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { addDays, todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import type { Appointment, Client, Service } from "@/lib/types/database";

type Row = Appointment & {
  client: Pick<Client, "id" | "name" | "email" | "phone"> | null;
  service: Pick<Service, "id" | "name"> | null;
};

export default async function UpcomingPage() {
  const { studio } = await getCurrentPractitionerWithStudio();
  const today = todayInTz(studio.timezone);
  const end = addDays(today, 14);

  const startUtc = utcInstantFromLocal(today, "00:00", studio.timezone);
  const endUtc = utcInstantFromLocal(addDays(end, 1), "00:00", studio.timezone);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("appointments")
    .select("*, client:clients(id, name, email, phone), service:services(id, name)")
    .eq("studio_id", studio.id)
    .eq("status", "confirmed")
    .gte("starts_at", startUtc.toISOString())
    .lt("starts_at", endUtc.toISOString())
    .order("starts_at");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Upcoming</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Next 14 days · {studio.timezone}
          </p>
        </div>
        <Link
          href="/calendar"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Week view
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          Nothing booked in the next two weeks.
        </div>
      ) : (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rows.map((a) => (
            <li key={a.id}>
              <Link
                href={`/calendar/${a.id}`}
                className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {a.client?.name ?? "Client"} · {a.service?.name ?? "Appointment"}
                  </div>
                  <div className="text-xs text-neutral-500">
                    <FormattedDateTime iso={a.starts_at} /> · {a.duration_minutes} min
                  </div>
                </div>
                <span className="text-sm text-neutral-400">›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
