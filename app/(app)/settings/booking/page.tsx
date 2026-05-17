import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { updateStudioBookingPrefsAction } from "./actions";
import { BookingLinkCard } from "./BookingLinkCard";

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
    </div>
  );
}
