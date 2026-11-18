import { bookedManuallyAction } from "@/app/(app)/settings/waitlist/booked-manually-actions";
import { BOOKED_MANUALLY_COPY, bookedManuallyOk, type BookedManuallyResult } from "@/lib/waitlist/booked-manually-notice";

// "Booked manually": the owner records that this person was booked outside the invitation. Presentational: the page decides whether to render it
// (owner only, flag on) and passes the appointments to choose from. It sends nothing and invites no one. The email-mismatch confirmation is an
// explicit, unticked checkbox, never a default.
export const BOOKED_MANUALLY_MEANING = "Use this when you booked them yourself. They leave the waiting list and the entry keeps its history. Nothing is sent.";

export type ManualBookingChoice = { id: string; label: string };

export function BookedManuallyForm({ entryId, choices }: { entryId: string; choices: readonly ManualBookingChoice[] }) {
  if (choices.length === 0) {
    return (
      <p data-testid="booked-manually-none" className="text-sm text-neutral-600 dark:text-neutral-400">
        Booked manually needs an appointment for this person. Book it on the calendar first, then come back.
      </p>
    );
  }
  return (
    <form action={bookedManuallyAction} data-testid="booked-manually-form" className="flex flex-col gap-2 text-sm">
      <input type="hidden" name="entryId" value={entryId} />
      <label className="flex flex-col gap-1">
        <span className="font-medium">Booked manually: choose the appointment</span>
        <select name="appointmentId" required defaultValue="" className="min-h-11 rounded-md border px-2">
          <option value="" disabled>
            Choose an appointment
          </option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-h-11 items-start gap-2">
        <input type="checkbox" name="confirmEmailMismatch" className="mt-1" />
        <span>The booking uses a different email. It is the same person.</span>
      </label>
      <p data-testid="booked-manually-meaning" className="text-neutral-600 dark:text-neutral-400">{BOOKED_MANUALLY_MEANING}</p>
      <button type="submit" className="min-h-11 self-start rounded-md border px-3">Mark as booked manually</button>
    </form>
  );
}

export function BookedManuallyNotice({ result }: { result: BookedManuallyResult | null }) {
  if (!result) return null;
  return (
    <p role={bookedManuallyOk(result) ? "status" : "alert"} data-testid="booked-manually-notice" data-ok={bookedManuallyOk(result) ? "1" : "0"}>
      {BOOKED_MANUALLY_COPY[result]}
    </p>
  );
}
