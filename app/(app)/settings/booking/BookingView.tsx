import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { BUFFER_PRESET_MINUTES } from "@/lib/booking/buffer-presets";
import { PUBLIC_BOOKING_HORIZON_MONTHS_VALUES } from "@/lib/booking/horizon";
import {
  updateStudioBookingPrefsAction,
  updateNewClientAdmissionModeAction,
} from "./actions";
import { getNewClientAdmissionMode } from "@/lib/booking/new-client-admission";
import { BookingLinkCard } from "./BookingLinkCard";
import { SaveButton } from "./SaveButton";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { bookingSettingsErrorSentence } from "@/lib/booking/settings-error-codes";
import { FormDirtyGuard } from "@/components/settings/form-dirty-guard";
import { SettingsViewHeading, STUDIO_WIDE_SCOPE } from "@/components/settings/view-heading";

// Plain option labels for the buffer select. The "Recommended" hint
// is no longer inlined here because that crowded the select control
// (especially on narrow widths, where the caret got cramped against
// the parenthetical). The recommendation is now surfaced next to the
// field label and in the helper text below the field.
function bufferOptionLabel(minutes: number): string {
  if (minutes === 0) return "No buffer";
  return `${minutes} minutes`;
}

// Renders a calm green/red banner above the form after the save
// action redirected back with a status query param. Server-rendered;
// no client component needed. The banner stays until the next
// navigation so the practitioner can read it without it auto-hiding
// while their thumb is somewhere else on a phone screen.
function SaveBanner({
  saved,
  error,
}: {
  saved: boolean;
  error: string | null;
}) {
  if (!saved && !error) return null;
  if (error) {
    return (
      <div
        role="status"
        className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700/50 dark:bg-red-950/30 dark:text-red-100"
      >
        <p className="font-medium">Could not save preferences.</p>
        <p className="mt-1">{error}</p>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100"
    >
      Preferences saved.
    </div>
  );
}

export type BookingViewKind = "link" | "window";

// One focused Booking view (R2): the booking link or the booking window, each
// its own route. Both save through updateStudioBookingPrefsAction, which now
// writes ONLY the fields its form carries (so one view's save can never reset the
// other's fields to defaults) with every per-field validation unchanged. The
// hidden `view` field only picks which route the result banner returns to.
export async function BookingView({
  view,
  searchParams,
}: {
  // Next 15 App Router: searchParams is async. saved / error come from the
  // query string written by the redirect()s in the booking actions.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  view: BookingViewKind;
}) {
  const params = (await searchParams) ?? {};
  const savedParam = params.saved;
  const errorParam = params.error;
  const saved =
    (Array.isArray(savedParam) ? savedParam[0] : savedParam) === "1";
  // `?error=` carries a CODE; only a recognised code becomes one of the fixed
  // sentences, so a crafted link cannot write its own words in the banner.
  const errorMessage = errorParam === undefined ? null : bookingSettingsErrorSentence(errorParam);

  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can change booking preferences.
      </div>
    );
  }
  const appOrigin = getRequiredAppOrigin();

  if (view === "window") {
    return (
      <div className="flex flex-col gap-8">
        <SettingsViewHeading title="Booking window" scope={STUDIO_WIDE_SCOPE}>
          Timezone, default appointment length, time between appointments, how
          far ahead clients can book, the description shown on your booking page,
          and the address clients see there and in appointment emails.
        </SettingsViewHeading>
        <SaveBanner saved={saved} error={errorMessage} />
        <form
          action={updateStudioBookingPrefsAction}
          className="flex max-w-2xl flex-col gap-5"
        >
          <input type="hidden" name="view" value="window" />
          <FormDirtyGuard name="booking-window" token={Date.now().toString(36)} />
        <div className="grid gap-4 md:grid-cols-3">
          <label id="timezone" className="flex scroll-mt-24 flex-col gap-1.5">
            <span className="text-sm font-medium">Timezone</span>
            <input
              name="timezone"
              defaultValue={studio.timezone}
              placeholder="America/Toronto"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>
          <label
            id="default-duration"
            className="flex scroll-mt-24 flex-col gap-1.5"
          >
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
          <label id="buffer" className="flex scroll-mt-24 flex-col gap-1.5">
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

        <label
          id="booking-horizon"
          className="flex max-w-xs scroll-mt-24 flex-col gap-1.5"
        >
          <span className="text-sm font-medium">Booking horizon</span>
          <select
            name="public_booking_horizon_months"
            defaultValue={String(studio.public_booking_horizon_months)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          >
            {PUBLIC_BOOKING_HORIZON_MONTHS_VALUES.map((m) => (
              <option key={m} value={String(m)}>
                {m} month{m === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-500">
            Choose how far ahead clients can book online. Internal
            practitioner booking is not limited by this setting.
          </span>
        </label>

        <label
          id="public-address"
          className="flex scroll-mt-24 flex-col gap-1.5"
        >
          <span className="text-sm font-medium">
            Public address (booking page and appointment emails)
          </span>
          <input
            name="address"
            defaultValue={studio.address ?? ""}
            placeholder="123 Main St, City"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <span className="text-xs text-neutral-500">
            Shown on your public booking page, and in clients&rsquo;
            confirmation, reminder and appointment-update emails and calendar
            invites. For home-based studios, leave this blank and share the
            address after booking.
          </span>
        </label>

        <label id="booking-intro" className="flex scroll-mt-24 flex-col gap-1.5">
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
            <SaveButton idleLabel="Save preferences" />
          </div>
        </form>
      </div>
    );
  }

  // The studio-owned mode, from the one authority that owns it. UNKNOWN is
  // rendered as its own state below rather than pre-selecting a choice the
  // owner did not make.
  const admission = await getNewClientAdmissionMode(studio);

  return (
    <div className="flex flex-col gap-8">
      <SettingsViewHeading title="Booking link" scope={STUDIO_WIDE_SCOPE}>
        How clients find and book you: your public link, its URL slug, and
        whether you are taking new clients.
      </SettingsViewHeading>
      <SaveBanner saved={saved} error={errorMessage} />

      <section className="flex flex-col gap-2">
        <label id="booking-link" className="scroll-mt-24 text-sm font-medium">
          Your booking link
        </label>
        <BookingLinkCard slug={studio.slug} origin={appOrigin} variant="card" />
      </section>

      {/* NEW-CLIENT-MODE-01. Its own form because it is its own authority: the
          database command re-derives owner role, so this cannot be a field that
          rides along with the general preferences save. NEW CLIENTS ONLY -
          stated in the copy, because an owner choosing "not accepting" needs to
          know their existing clients keep booking. */}
      <section className="flex flex-col gap-3">
        <label
          id="new-client-admission"
          className="scroll-mt-24 text-sm font-medium"
        >
          New clients
        </label>
        {!admission.ok ? (
          <p className="max-w-2xl text-sm text-neutral-600">
            We couldn&rsquo;t check this setting just now, so it isn&rsquo;t shown.
            Reload to try again &mdash; nothing has changed.
          </p>
        ) : (
          <form
            action={updateNewClientAdmissionModeAction}
            className="flex max-w-2xl flex-col gap-3"
          >
            <FormDirtyGuard name="booking-new-clients" token={Date.now().toString(36)} />
            {(
              [
                {
                  value: "open",
                  label: "Accept bookings",
                  consequence:
                    "New clients book a consultation themselves from your booking page.",
                },
                {
                  value: "waitlist",
                  label: "Use a waitlist",
                  consequence:
                    "New clients can\u2019t book. Your booking page offers a waitlist form instead, and each join is saved so you can invite them when you have room.",
                },
                {
                  value: "closed",
                  label: "Not accepting new clients",
                  consequence:
                    "Your booking page says you aren\u2019t taking new clients. They can\u2019t book and can\u2019t join a waitlist.",
                },
              ] as const
            ).map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-200 p-3"
              >
                <input
                  type="radio"
                  name="new_client_admission_mode"
                  value={opt.value}
                  defaultChecked={admission.mode === opt.value}
                  className="mt-1"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-xs text-neutral-600">
                    {opt.consequence}
                  </span>
                </span>
              </label>
            ))}
            <p className="text-xs text-neutral-500">
              This affects new clients only. Your existing clients can always
              book, use the portal and rebook, whichever option you choose.
            </p>
            <SaveButton idleLabel="Save new-client setting" />
          </form>
        )}
      </section>

      <form
        action={updateStudioBookingPrefsAction}
        className="flex max-w-2xl flex-col gap-5"
      >
        <input type="hidden" name="view" value="link" />
        <FormDirtyGuard name="booking-link" token={Date.now().toString(36)} />
        <label id="booking-slug" className="flex scroll-mt-24 flex-col gap-1.5">
          <span className="text-sm font-medium">Booking URL slug</span>
          <div className="flex items-stretch">
            <span className="inline-flex items-center rounded-l-md border border-r-0 border-neutral-300 bg-neutral-50 px-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
              {appOrigin.replace(/^https?:\/\//, "")}/book/
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

        <div>
          <SaveButton idleLabel="Save booking link" />
        </div>
      </form>
    </div>
  );
}
