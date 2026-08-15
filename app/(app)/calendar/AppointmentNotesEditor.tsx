"use client";

// APPOINTMENT BOUNDARY B4, governed appointment-notes correction surface.
//
// Appointment notes are written once, at booking time, by the client or by the
// practitioner taking the booking. Nothing in the product ever let them be
// edited afterwards, and after 0172 revoked direct authenticated UPDATE on
// `appointments` they became immutable through the browser outright. Migration
// 0173 supplies the governed correction command; this is its surface.
//
// SCOPE. This is the OPERATIONAL note attached to the booking: "parking is
// round the back", "running late, arriving 10 past". It is NOT a clinical
// record: charting, treatment memory and clinical notes have their own
// surfaces with their own retention rules, and this component deliberately
// does not touch them. The existing client-safe / clinical hierarchy on the
// detail page is unchanged; only this one operational field becomes editable.
//
// Any ACTIVE studio member may correct it: unlike outcome repair, which is
// owner-only, because the practitioner who ran the visit is usually the one
// who needs to fix it. The command re-derives membership in SQL regardless.
//
// The audit records the BEFORE and AFTER LENGTHS only, never the text: these
// notes routinely carry client-identifying detail and appointment_audit is
// readable by every member of the studio.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setAppointmentNotesAction } from "./appointment-repair-actions";
import { MAX_APPOINTMENT_NOTES_LENGTH } from "./appointment-repair-contract";

export type AppointmentNotesEditorProps = {
  appointmentId: string;
  notes: string | null;
  // Optional: notified after a successful save so an enclosing surface that
  // holds its own copy of the notes can re-read it. router.refresh() always
  // runs regardless, but it only re-runs SERVER components — a client-held
  // lazy load (the calendar preview drawer) is untouched by it and would go on
  // rendering the pre-save text.
  onSaved?: () => void;
};

export function AppointmentNotesEditor({
  appointmentId,
  notes,
  onSaved,
}: AppointmentNotesEditorProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const tooLong = draft.trim().length > MAX_APPOINTMENT_NOTES_LENGTH;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await setAppointmentNotesAction({
        appointmentId,
        notes: draft,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
      onSaved?.();
    });
  }

  return (
    <section className="rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Appointment notes
        </h2>
        {!open && (
          <button
            type="button"
            onClick={() => {
              setDraft(notes ?? "");
              setError(null);
              setOpen(true);
            }}
            className="text-xs font-medium text-neutral-600 underline underline-offset-2 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            {notes ? "Edit" : "Add notes"}
          </button>
        )}
      </div>

      {!open ? (
        notes ? (
          <p className="mt-2 whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
            {notes}
          </p>
        ) : (
          <p className="mt-2 text-xs text-neutral-500">No notes for this appointment.</p>
        )
      ) : (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
          <textarea
            name="notes"
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Notes about this appointment"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <p className="text-xs text-neutral-500">
            Leaving this empty clears the notes. Changes are recorded in the
            appointment audit history.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              disabled={pending}
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || tooLong}
              className="rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {pending ? "Saving…" : "Save notes"}
            </button>
            {tooLong && (
              <span className="text-xs text-red-700 dark:text-red-300">
                Notes must be {MAX_APPOINTMENT_NOTES_LENGTH} characters or fewer.
              </span>
            )}
            {error && (
              <span className="text-xs text-red-700 dark:text-red-300">
                {error}
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
