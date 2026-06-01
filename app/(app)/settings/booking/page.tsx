import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { BUFFER_PRESET_MINUTES } from "@/lib/booking/buffer-presets";
import { PUBLIC_BOOKING_HORIZON_MONTHS_VALUES } from "@/lib/booking/horizon";
import { updateStudioBookingPrefsAction } from "./actions";
import { BookingLinkCard } from "./BookingLinkCard";

// Plain option labels for the buffer select. The "Recommended" hint
// is no longer inlined here because that crowded the select control
// (especially on narrow widths, where the caret got cramped against
// the parenthetical). The recommendation is now surfaced next to the
// field label and in the helper text below the field.
function bufferOptionLabel(minutes: number): string {
  if (minutes === 0) return "No buffer";
  return `${minutes} minutes`;
}

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";

export default async function BookingSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can change booking preferences.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="text-xl font-medium">Booking</h2>
        <p className="mt-1 text-sm text-neutral-500">
          How clients find and book you. Public URL, timezone, default
          appointment length, and the description shown on your booking page.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <label className="text-sm font-medium">Your booking link</label>
        <BookingLinkCard slug={studio.slug} origin={APP_ORIGIN} variant="card" />
      </section>

      <form
        action={updateStudioBookingPrefsAction}
        className="flex max-w-2xl flex-col gap-5"
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Booking URL slug</span>
          <div className="flex items-stretch">
            <span className="inline-flex items-center rounded-l-md border border-r-0 border-neutral-300 bg-neutral-50 px-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
              {APP_ORIGIN.replace(/^https?:\/\//, "")}/book/
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
            Lowercase letters, numbers, and dashes. Change at your own risk:
            old links will stop working.
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
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="text-sm font-medium">
                Time between appointments
              </span>
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                Recommended: 15 min
              </span>
            </div>
            <select
              name="buffer_minutes"
              defaultValue={String(studio.buffer_minutes)}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            >
              {!BUFFER_PRESET_MINUTES.includes(studio.buffer_minutes) && (
                <option value={String(studio.buffer_minutes)}>
                  {studio.buffer_minutes} minutes (current, not a preset)
                </option>
              )}
              {BUFFER_PRESET_MINUTES.map((m) => (
                <option key={m} value={String(m)}>
                  {bufferOptionLabel(m)}
                </option>
              ))}
            </select>
            <span className="text-xs text-neutral-500">
              Automatically blocks time after each appointment for cleanup,
              notes, and preparation. 15 minutes is recommended. Changes
              apply to new bookings only.
            </span>
          </label>
        </div>

        <label className="flex flex-col gap-1.5 max-w-xs">
          <span className="text-sm font-medium">Booking horizon</span>
          <select
            name="public_booking_horizon_months"
            defaultValue={String(studio.public_booking_horizon_months)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          >
            {PUBLIC_BOOKING_HORIZON_MONTHS_VALUES.map((m) => (
              <option key={m} value={String(m)}>
                {m} months
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-500">
            Choose how far ahead clients can book online. Internal
            practitioner booking is not limited by this setting.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Public address (shown on your booking page)
          </span>
          <input
            name="address"
            defaultValue={studio.address ?? ""}
            placeholder="123 Main St, City"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <span className="text-xs text-neutral-500">
            For home-based studios, leave this blank and share the address
            after booking.
          </span>
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
    </div>
  );
}
