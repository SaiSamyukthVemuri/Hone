"use client";

// P0-1 + P0-3 + PR #180: practitioner-facing lifecycle actions for an
// appointment.
//
// Mount this component on the appointment detail / drawer surface so a
// practitioner can:
//   * Mark completed: only available after the appointment end time,
//                     AND requires an explicit confirmation step before
//                     invoking the server action.
//   * Mark no-show:   same gating as Mark completed.
//
// PR #180 history. Manual "Mark complete" was originally removed from
// this surface per pre-payments feedback (Chloe did not want to mark
// each appointment complete by hand at the time). Re-introduced by
// PR #180 because the PR #172 session-payment prepare gate REQUIRES
// `appointment.status='completed'` before a payment can be prepared,
// and there was no other way for a practitioner to reach the completed
// state from the UI. The server action `markAppointmentCompleteAction`
// + the RPC `public.mark_appointment_complete` (migration 0032) were
// unchanged across the removal/re-introduction cycle; this component
// just re-surfaces the button. The auto-complete-on-session-start
// path in `app/(app)/clients/[id]/sessions/new/actions.ts` covers the
// common case where the practitioner immediately charts the session;
// the explicit button covers the case where charting happens later.
//
// No-show routes through the SECURITY DEFINER RPC
// `public.mark_appointment_no_show` (migration 0033) via
// `markAppointmentNoShowAction`. Terminal-state appointments present
// no functional action.
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

// PR #180. Confirmation copy for Mark completed. Less consequential
// than no-show (a completed appointment is the normal happy path), but
// still asks for an explicit confirm so the practitioner does not
// terminate a row by accident. The copy explains why the action matters
// in the payment workflow.
const COMPLETE_CONFIRM_MESSAGE =
  "Mark this appointment completed? This marks the appointment completed and allows the session to be charged after charting.";

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

  // PR #180. Mark completed. Same gating as Mark no-show (must be a
  // confirmed appointment whose ends_at has passed); two-click confirm
  // pattern matches the no-show action. Both buttons share `pending` so
  // a click on one disables the other while a transition is in flight.
  function runComplete() {
    setError(null);
    setHint(null);
    if (typeof window !== "undefined") {
      const ok = window.confirm(COMPLETE_CONFIRM_MESSAGE);
      if (!ok) {
        setHint("Cancelled, no change made.");
        window.setTimeout(() => setHint(null), 2000);
        return;
      }
    }
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    startTransition(async () => {
      const res = await markAppointmentCompleteAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setHint("Appointment marked completed.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || !hasEnded}
          onClick={runComplete}
          title={
            hasEnded
              ? "Mark this appointment completed. You will be asked to confirm."
              : "Appointment can be marked completed after the start time."
          }
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          Mark completed
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
