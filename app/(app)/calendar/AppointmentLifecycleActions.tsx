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
// CONFIRMATION (Chloe workflow fix). The confirmation step used to be a
// native window.confirm(). On iOS Safari that dialog can be suppressed by
// WebKit and return false WITHOUT showing anything — indistinguishable from
// a real "Cancel" tap — so "Mark completed" silently did nothing and the
// appointment never advanced to a chargeable state. The confirmation is now
// an in-DOM accessible dialog (components/confirm-dialog.tsx): keyboard +
// screen-reader accessible, focus-trapped, Escape/Cancel send NO request, and
// the trusted server actions run exactly once per confirmation inside a
// transition. The server actions + their RPC gates are UNCHANGED.
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
// detail page re-fetches and reflects the new terminal status (which in
// turn re-renders the payment/checkout surface). The server actions also
// revalidatePath the detail page route for the same effect on full-page
// navigations.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
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

// Safe, fixed fallback failure copy. The server actions already map every
// RPC failure to curated, non-technical strings (e.g. "This appointment
// hasn't ended yet."); this is only used if an action ever returns an empty
// error. No raw DB / provider text ever reaches this surface.
const GENERIC_FAILURE =
  "Something went wrong. Please refresh and try again.";

type Confirming = "complete" | "no_show" | null;

export function AppointmentLifecycleActions({
  appointmentId,
  status,
  endsAt,
}: AppointmentLifecycleActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  // Which confirmation dialog (if any) is open. Opening a dialog is the new
  // replacement for the old window.confirm() prompt; the server action runs
  // only when the practitioner presses Confirm inside the dialog.
  const [confirming, setConfirming] = useState<Confirming>(null);

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

  // Open the confirmation dialog for Mark completed. No request is sent here.
  function runComplete() {
    setError(null);
    setHint(null);
    setConfirming("complete");
  }

  // Open the confirmation dialog for Mark no-show. No request is sent here.
  function runNoShow() {
    setError(null);
    setHint(null);
    setConfirming("no_show");
  }

  // Cancel: close the dialog and send NO request.
  function handleCancel() {
    if (pending) return;
    setConfirming(null);
    setError(null);
    setHint("Cancelled, no change made.");
    window.setTimeout(() => setHint(null), 2000);
  }

  // Confirm: run the appropriate server action exactly once inside a
  // transition. The Confirm button is disabled while `pending`, so a second
  // press cannot fire a second request. On success we refresh so the
  // appointment, session and payment/checkout surfaces re-render; on failure
  // we surface the action's own safe, curated error inside the dialog and
  // leave it open so the practitioner can read it and Cancel or retry.
  function handleConfirm() {
    if (pending) return;
    const which = confirming;
    if (!which) return;
    setError(null);
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    startTransition(async () => {
      const res =
        which === "complete"
          ? await markAppointmentCompleteAction(fd)
          : await markAppointmentNoShowAction(fd);
      if (!res.ok) {
        setError(res.error || GENERIC_FAILURE);
        return;
      }
      setConfirming(null);
      setHint(
        which === "complete"
          ? "Appointment marked completed."
          : "Marked no-show",
      );
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
              : "Appointment can be marked completed after the appointment has ended."
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
      {error && !confirming && (
        <p className="text-xs text-red-700">{error}</p>
      )}

      {/* Mark completed confirmation. Separate, truthful copy from no-show. */}
      <ConfirmDialog
        open={confirming === "complete"}
        title="Mark appointment completed?"
        description={COMPLETE_CONFIRM_MESSAGE}
        confirmLabel="Mark completed"
        busyLabel="Marking completed…"
        pending={pending}
        error={confirming === "complete" ? error : null}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />

      {/* Mark no-show confirmation. Separate, truthful copy from complete. */}
      <ConfirmDialog
        open={confirming === "no_show"}
        title="Mark client as no-show?"
        description={NO_SHOW_CONFIRM_MESSAGE}
        confirmLabel="Mark no-show"
        busyLabel="Marking no-show…"
        tone="danger"
        pending={pending}
        error={confirming === "no_show" ? error : null}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
}
