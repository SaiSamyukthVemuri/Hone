"use client";

// P0-1 + P0-3: practitioner-facing lifecycle actions for an appointment.
//
// Mount this component on the appointment detail / drawer surface so a
// practitioner can:
//   * Mark complete — only available after the appointment end time.
//   * Mark no-show — only available after the appointment end time,
//                    AND requires an explicit confirmation step before
//                    invoking the server action.
//
// Both actions route through SECURITY DEFINER RPCs
// (`public.mark_appointment_complete` from migration 0032 and
// `public.mark_appointment_no_show` from migration 0033) via the
// server actions `markAppointmentCompleteAction` /
// `markAppointmentNoShowAction` in `./actions.ts`. Terminal-state
// appointments do not present any functional action.
//
// On success, the component calls router.refresh() so the appointment
// detail page re-fetches and reflects the new terminal status. The
// server actions also revalidatePath the detail page route for the
// same effect on full-page navigations.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  markAppointmentCompleteAction,
  markAppointmentNoShowAction,
} from "./actions";

export type AppointmentLifecycleActionsProps = {
  appointmentId: string;
  status: "confirmed" | "completed" | "cancelled" | "no_show";
  endsAt: string;
};

// Confirmation copy for the consequential mark-no-show terminal
// outcome. A no-show may later carry late-cancellation / no-show fee
// implications under Stripe Phase 1; the practitioner is asked to
// confirm intent before the row is flipped.
const NO_SHOW_CONFIRM_MESSAGE =
  "Mark this client as a no-show? This records that the appointment was missed and cannot be undone from this screen.";

export function AppointmentLifecycleActions({
  appointmentId,
  status,
  endsAt,
}: AppointmentLifecycleActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const endsAtMs = new Date(endsAt).getTime();

  // Tick a state value when the appointment's end time is reached so
  // the two buttons re-render and become enabled without requiring
  // the practitioner to refresh. We schedule one timeout aimed at
  // `ends_at` (clamped to >0ms) and bail after it fires. If the page
  // is already past `ends_at`, no timer is scheduled.
  //
  // NOTE: this hook is called unconditionally at the top of the
  // component. Any early-return guard (e.g. for terminal status)
  // must happen AFTER all hooks per the Rules of Hooks.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(endsAtMs)) return;
    const remaining = endsAtMs - Date.now();
    if (remaining <= 0) return;
    const t = window.setTimeout(() => setNowTick(Date.now()), remaining + 250);
    return () => window.clearTimeout(t);
  }, [endsAtMs]);

  // Terminal states: render nothing. Placed AFTER hooks so the hook
  // order is stable across renders.
  if (status !== "confirmed") return null;

  const hasEnded = Number.isFinite(endsAtMs) && endsAtMs <= nowTick;

  function runComplete() {
    setError(null);
    setHint(null);
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    startTransition(async () => {
      const res = await markAppointmentCompleteAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setHint("Marked complete");
      // Refresh so the detail page's server-fetched status reflects
      // the new terminal state on the same client navigation.
      router.refresh();
    });
  }

  function runNoShow() {
    setError(null);
    setHint(null);
    // Workflow fix 2: explicit confirmation before the consequential
    // terminal outcome is recorded. The browser's window.confirm()
    // is a minimal, blocking confirmation that prevents an
    // accidental click from flipping the row.
    if (typeof window !== "undefined") {
      const ok = window.confirm(NO_SHOW_CONFIRM_MESSAGE);
      if (!ok) {
        setHint("Cancelled, no change made.");
        window.setTimeout(() => setHint(null), 2000);
        return;
      }
    }
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    startTransition(async () => {
      const res = await markAppointmentNoShowAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setHint("Marked no-show");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !hasEnded}
          onClick={runComplete}
          title={
            hasEnded
              ? "Mark this appointment complete."
              : "Available after the appointment end time."
          }
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Mark complete
        </button>
        <button
          type="button"
          disabled={pending || !hasEnded}
          onClick={runNoShow}
          title={
            hasEnded
              ? "Mark this appointment as no-show. You will be asked to confirm."
              : "Available after the appointment end time."
          }
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Mark no-show
        </button>
      </div>
      {hint && (
        <p className="text-xs text-green-600 dark:text-green-400">{hint}</p>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
