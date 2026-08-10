"use client";

// P0-1 + P0-3 + PR #180: practitioner-facing lifecycle actions for an
// appointment, on the CALENDAR surface.
//
// Mount this on the appointment detail / drawer surface so a practitioner can:
//   * Mark completed: only after the appointment end time, with an explicit
//                     confirmation. This is now the SHARED control
//                     (components/appointment/mark-complete-control.tsx), so
//                     the calendar and the charting "Finish appointment"
//                     workflow cannot drift apart.
//   * Mark no-show:   same end-time gating, CALENDAR ONLY. A practitioner
//                     inside charting has just treated the client, so no-show
//                     is deliberately absent there.
//
// No-show routes through the SECURITY DEFINER RPC
// `public.mark_appointment_no_show` (migration 0033) via
// `markAppointmentNoShowAction`. Terminal-state appointments present no
// functional action.
//
// PR #180 history. Manual "Mark complete" was originally removed from this
// surface per pre-payments feedback (Chloe did not want to mark each
// appointment complete by hand at the time). Re-introduced by PR #180 because
// the PR #172 session-payment prepare gate REQUIRES
// `appointment.status='completed'` before a payment can be prepared, and there
// was no other way to reach the completed state from the UI. The server action
// `markAppointmentCompleteAction` + the RPC `public.mark_appointment_complete`
// (migration 0032) were unchanged across that cycle, and are unchanged here.
//
// CONFIRMATION. Both actions use the in-DOM accessible ConfirmDialog rather
// than window.confirm(), which iOS Safari can suppress silently — see the
// shared control for the full history.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { MarkAppointmentCompleteControl } from "@/components/appointment/mark-complete-control";
import { markAppointmentNoShowAction } from "./actions";

export type AppointmentLifecycleActionsProps = {
  appointmentId: string;
  status: "confirmed" | "completed" | "cancelled" | "no_show";
  // B6: two clocks, deliberately. startsAt gates explicit completion; endsAt
  // still gates no-show, because a no-show is the booked opportunity having
  // fully elapsed rather than a practitioner asserting treatment finished.
  startsAt: string;
  endsAt: string;
};

// Confirmation copy for the consequential mark-no-show terminal outcome. A
// no-show may later carry late-cancellation / no-show fee implications under
// Stripe Phase 1; the practitioner confirms intent before the row is flipped.
const NO_SHOW_CONFIRM_MESSAGE =
  "Mark this client as a no-show? This records that the appointment was missed and cannot be undone from this screen.";

const GENERIC_FAILURE = "Something went wrong. Please refresh and try again.";

export function AppointmentLifecycleActions({
  appointmentId,
  status,
  startsAt,
  endsAt,
}: AppointmentLifecycleActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const endsAtMs = new Date(endsAt).getTime();

  // Tick at the end time so the no-show button enables itself without a manual
  // refresh. Called unconditionally: no early return may precede a hook.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(endsAtMs)) return;
    const remaining = endsAtMs - Date.now();
    if (remaining <= 0) return;
    const t = window.setTimeout(() => setNowTick(Date.now()), remaining + 250);
    return () => window.clearTimeout(t);
  }, [endsAtMs]);

  // Terminal states render nothing. AFTER the hooks, so hook order is stable.
  if (status !== "confirmed") return null;

  // NO-SHOW ONLY. Explicit completion has its own startsAt rule inside
  // MarkAppointmentCompleteControl; the two must never share a variable again.
  const hasEnded = Number.isFinite(endsAtMs) && endsAtMs <= nowTick;

  function runNoShow() {
    setError(null);
    setHint(null);
    setConfirming(true);
  }

  function handleCancel() {
    if (pending) return;
    setConfirming(false);
    setError(null);
    setHint("Cancelled, no change made.");
    window.setTimeout(() => setHint(null), 2000);
  }

  function handleConfirm() {
    if (pending) return;
    setError(null);
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    startTransition(async () => {
      const res = await markAppointmentNoShowAction(fd);
      if (!res.ok) {
        setError(res.error || GENERIC_FAILURE);
        return;
      }
      setConfirming(false);
      setHint("Marked no-show");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        {/* THE shared completion control — identical here and in charting. */}
        <MarkAppointmentCompleteControl
          appointmentId={appointmentId}
          startsAt={startsAt}
          notStartedHint="Available once the appointment has started."
        />
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
      {hint && <p className="text-xs text-green-600 dark:text-green-400">{hint}</p>}
      {error && !confirming && <p className="text-xs text-red-700">{error}</p>}

      {/* Mark no-show confirmation. Separate, truthful copy from complete. */}
      <ConfirmDialog
        open={confirming}
        title="Mark client as no-show?"
        description={NO_SHOW_CONFIRM_MESSAGE}
        confirmLabel="Mark no-show"
        busyLabel="Marking no-show…"
        tone="danger"
        pending={pending}
        error={confirming ? error : null}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
}
