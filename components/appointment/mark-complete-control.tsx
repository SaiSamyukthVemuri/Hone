"use client";

// THE completion control for an appointment, one implementation, two mounts.
//
// Extracted from AppointmentLifecycleActions so the calendar appointment page
// and the charting page's "Finish appointment" workflow use the SAME control
// rather than two lookalikes that can drift. Everything consequential lives
// here and is unchanged: the end-time gate and its self-enabling timer, the
// accessible in-DOM confirmation, single-flight protection, the curated error
// copy, and router.refresh() so every dependent surface re-renders.
//
// The server action `markAppointmentCompleteAction` and its SECURITY DEFINER
// RPC `public.mark_appointment_complete` (migration 0032) remain the authority,
// including the end-time check and the appointment_audit row. This component
// gates the BUTTON; the server gates the WRITE.
//
// CONFIRMATION HISTORY (kept from the original). The confirmation used to be a
// native window.confirm(). On iOS Safari WebKit can suppress that dialog and
// return false WITHOUT showing anything: indistinguishable from a real Cancel
// so "Mark completed" silently did nothing and the appointment never became
// chargeable. It is now an in-DOM accessible dialog: focus-trapped,
// keyboard/screen-reader reachable, Escape and Cancel send NO request.
//
// No-show deliberately does NOT live here. It is a calendar-surface action; a
// practitioner inside charting has just treated the client, so offering
// "no-show" there would be nonsense.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { markAppointmentCompleteAction } from "@/app/(app)/calendar/actions";

// PR #180. Less consequential than no-show (a completed appointment is the
// normal happy path), but still an explicit confirm so a row is not terminated
// by accident. The copy explains why it matters in the payment workflow.
export const COMPLETE_CONFIRM_MESSAGE =
  "Mark this appointment completed? This marks the appointment completed and allows the session to be charged after charting.";

// Safe, fixed fallback. The server action already maps every RPC failure to a
// curated, non-technical string (e.g. "This appointment hasn't started yet.");
// this is used only if an action ever returns an empty error. No raw DB or
// provider text ever reaches this surface.
const GENERIC_FAILURE = "Something went wrong. Please refresh and try again.";

export type MarkAppointmentCompleteControlProps = {
  appointmentId: string;
  // B6: EXPLICIT completion is gated on the appointment having STARTED, not
  // ended. No-show keeps its own ends_at rule and its own control.
  startsAt: string;
  // Rendered beside the button when the appointment has not started yet.
  notStartedHint?: string;
  // Full-width, one-column layout for the charting surface at 390px.
  block?: boolean;
};

export function MarkAppointmentCompleteControl({
  appointmentId,
  startsAt,
  notStartedHint = "Available once the appointment has started",
  block = false,
}: MarkAppointmentCompleteControlProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const startsAtMs = new Date(startsAt).getTime();

  // Tick when the START time is reached so the button enables itself without
  // the practitioner refreshing. One timeout aimed at starts_at; none if past.
  // Called unconditionally, no early return may precede a hook.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(startsAtMs)) return;
    const remaining = startsAtMs - Date.now();
    if (remaining <= 0) return;
    const t = window.setTimeout(() => setNowTick(Date.now()), remaining + 250);
    return () => window.clearTimeout(t);
  }, [startsAtMs]);

  // Truthful name: this is 'the visit has begun', not 'the visit has ended'.
  // Inclusive boundary, matching mark_appointment_complete's `starts_at > now()`
  // refusal, exactly starts_at is eligible.
  const canComplete = Number.isFinite(startsAtMs) && startsAtMs <= nowTick;

  // Opens the dialog. NO request is sent here.
  function openConfirm() {
    setError(null);
    setHint(null);
    setConfirming(true);
  }

  // Cancel: close and send NO request.
  function handleCancel() {
    if (pending) return;
    setConfirming(false);
    setError(null);
    setHint("Cancelled, no change made.");
    window.setTimeout(() => setHint(null), 2000);
  }

  // Confirm: run the trusted action exactly once inside a transition. The
  // Confirm button is disabled while `pending`, so a second press cannot fire a
  // second request. On success refresh so the appointment, session and payment
  // surfaces re-render; on failure surface the action's own curated error and
  // leave the dialog open to read it.
  //
  // Deliberately does NOT navigate: the practitioner must be able to see the
  // updated statuses before leaving.
  function handleConfirm() {
    if (pending) return;
    setError(null);
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    startTransition(async () => {
      const res = await markAppointmentCompleteAction(fd);
      if (!res.ok) {
        setError(res.error || GENERIC_FAILURE);
        return;
      }
      setConfirming(false);
      setHint("Appointment marked completed.");
      router.refresh();
    });
  }

  return (
    <div className={block ? "flex w-full flex-col gap-2" : "flex flex-col gap-2"}>
      <button
        type="button"
        data-testid="mark-appointment-complete"
        disabled={pending || !canComplete}
        onClick={openConfirm}
        title={
          canComplete
            ? "Mark this appointment completed. You will be asked to confirm."
            : "Appointment can be marked completed once it has started."
        }
        className={`inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 ${
          block ? "w-full" : ""
        }`}
      >
        Mark completed
      </button>
      {!canComplete && (
        <p data-testid="mark-complete-not-started" className="text-xs text-neutral-500">
          {notStartedHint}
        </p>
      )}
      {hint && <p className="text-xs text-green-600 dark:text-green-400">{hint}</p>}
      {error && !confirming && <p className="text-xs text-red-700">{error}</p>}

      <ConfirmDialog
        open={confirming}
        title="Mark appointment completed?"
        description={COMPLETE_CONFIRM_MESSAGE}
        confirmLabel="Mark completed"
        busyLabel="Marking completed…"
        pending={pending}
        error={confirming ? error : null}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
}
