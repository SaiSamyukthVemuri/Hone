import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAvailabilityDefaults,
  getBlockouts,
  getOverridesForRange,
} from "@/lib/booking/queries";
import { addDays, todayInTz } from "@/lib/booking/tz";
import {
  createBlockoutAction,
  deleteBlockoutAction,
  deleteOverrideAction,
  saveWeeklyDefaultsAction,
  updateStudioBookingPrefsAction,
  upsertOverrideAction,
} from "./actions";

const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function trimTime(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 5);
}

export default async function AvailabilitySettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can change availability.
      </div>
    );
  }

  const today = todayInTz(studio.timezone);
  const ninetyDaysOut = addDays(today, 90);

  const [defaults, overrides, blockouts] = await Promise.all([
    getAvailabilityDefaults(studio.id),
    getOverridesForRange(studio.id, today, ninetyDaysOut),
    getBlockouts(studio.id),
  ]);

  const byDay = new Map(defaults.map((d) => [d.day_of_week, d]));

  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">Booking preferences</h2>
        <form
          action={updateStudioBookingPrefsAction}
          className="flex max-w-2xl flex-col gap-4"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Booking URL slug</span>
            <div className="flex items-stretch">
              <span className="inline-flex items-center rounded-l-md border border-r-0 border-neutral-300 bg-neutral-50 px-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
                hone.care/book/
              </span>
              <input
                name="slug"
                defaultValue={studio.slug}
                required
                pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
                className="w-full rounded-r-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </div>
            <span className="text-xs text-neutral-500">
              Lowercase letters, numbers, and dashes.
            </span>
          </label>

          <div className="grid gap-4 md:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Timezone</span>
              <input
                name="timezone"
                defaultValue={studio.timezone}
                placeholder="America/Toronto"
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Default duration (min)</span>
              <input
                name="default_appointment_duration_minutes"
                type="number"
                min={5}
                max={480}
                step={5}
                defaultValue={studio.default_appointment_duration_minutes}
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Buffer (min)</span>
              <input
                name="buffer_minutes"
                type="number"
                min={0}
                max={240}
                step={5}
                defaultValue={studio.buffer_minutes}
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Address (shown to clients)</span>
            <input
              name="address"
              defaultValue={studio.address ?? ""}
              placeholder="123 Main St, City"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Booking page intro</span>
            <textarea
              name="booking_description"
              rows={3}
              defaultValue={studio.booking_description ?? ""}
              placeholder="Short description shown on your public booking page."
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>

          <div>
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Save preferences
            </button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">Weekly default</h2>
        <p className="text-sm text-neutral-500">
          Times below repeat every week unless an override or blockout applies.
        </p>
        <form action={saveWeeklyDefaultsAction} className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {DAY_LABELS.map((label, dow) => {
              const row = byDay.get(dow);
              const isOpen = row?.is_open ?? false;
              return (
                <li
                  key={dow}
                  className="grid gap-3 px-4 py-3 md:grid-cols-[8rem_auto_auto_auto] md:items-center"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name={`is_open_${dow}`}
                      value="true"
                      defaultChecked={isOpen}
                    />
                    Open
                  </label>
                  <input
                    type="time"
                    name={`open_time_${dow}`}
                    defaultValue={trimTime(row?.open_time ?? null)}
                    className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                  />
                  <input
                    type="time"
                    name={`close_time_${dow}`}
                    defaultValue={trimTime(row?.close_time ?? null)}
                    className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                  />
                </li>
              );
            })}
          </ul>
          <div>
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Save weekly default
            </button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">Per-date overrides</h2>
        <p className="text-sm text-neutral-500">
          Override the weekly default for a specific date. Useful for an extra
          day open or a planned short day.
        </p>
        <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {overrides.length === 0 ? (
            <li className="px-4 py-3 text-sm text-neutral-500">
              No overrides in the next 90 days.
            </li>
          ) : (
            overrides.map((o) => (
              <li
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <span className="font-medium">{o.effective_date}</span>
                <span className="text-neutral-500">
                  {o.is_open
                    ? `${trimTime(o.open_time)} – ${trimTime(o.close_time)}`
                    : "closed"}
                  {o.note ? ` · ${o.note}` : ""}
                </span>
                <form action={deleteOverrideAction}>
                  <input type="hidden" name="id" value={o.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))
          )}
        </ul>
        <form
          action={upsertOverrideAction}
          className="grid gap-2 md:grid-cols-[10rem_auto_auto_auto_auto]"
        >
          <input
            type="date"
            name="effective_date"
            required
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" name="is_open" value="true" defaultChecked />
            Open
          </label>
          <input
            type="time"
            name="open_time"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <input
            type="time"
            name="close_time"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Save override
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">Blockouts</h2>
        <p className="text-sm text-neutral-500">
          Date ranges where no bookings can be made (vacation, sick day, etc.).
        </p>
        <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {blockouts.length === 0 ? (
            <li className="px-4 py-3 text-sm text-neutral-500">No blockouts.</li>
          ) : (
            blockouts.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <span className="font-medium">
                  {b.starts_on} → {b.ends_on}
                </span>
                <span className="text-neutral-500">{b.reason ?? ""}</span>
                <form action={deleteBlockoutAction}>
                  <input type="hidden" name="id" value={b.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))
          )}
        </ul>
        <form
          action={createBlockoutAction}
          className="grid gap-2 md:grid-cols-[10rem_10rem_minmax(0,1fr)_auto]"
        >
          <input
            type="date"
            name="starts_on"
            required
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <input
            type="date"
            name="ends_on"
            required
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <input
            name="reason"
            placeholder="Reason (optional)"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Add blockout
          </button>
        </form>
      </section>
    </div>
  );
}
