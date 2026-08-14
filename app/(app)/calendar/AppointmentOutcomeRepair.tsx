"use client";

// APPOINTMENT BOUNDARY B4, owner-only outcome repair surface.
//
// Before B4 a terminal outcome was final from the UI's point of view:
// AppointmentLifecycleActions tells the practitioner "cannot be undone from
// this screen" and meant it, because no reverse edge existed anywhere in the
// product. Migration 0173 adds the governed reverse edge; this is its surface.
//
// TWO RULES THIS COMPONENT FOLLOWS
//
//  1. It never presents a control that is guaranteed to fail. The page resolves
//     repair eligibility SERVER-SIDE (loadAppointmentRepairStateAction, which
//     calls the same 0173 helper the command uses) and passes the verdict in.
//     When a repair is blocked the component EXPLAINS why: a linked treatment
//     record, a processed payment, aftercare already emailed: instead of
//     rendering a button that would bounce off the command.
//  2. The wording is practitioner wording, not developer wording. Nothing here
//     says "revert", "sentinel", "DML" or "audit row". It says what happened
//     and what will happen.
//
// Authority still lives in SQL. This component is owner-gated for DISPLAY only;
// revert_appointment_outcome re-derives the actor's role from the database and
// refuses a non-owner regardless of what the browser renders or sends.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { revertAppointmentOutcomeAction } from "./appointment-repair-actions";
import {
  MIN_REPAIR_REASON_LENGTH,
  type RevertibleStatus,
  type AppointmentRepairState,
} from "./appointment-repair-contract";

const STATUS_LABEL: Record<RevertibleStatus, string> = {
  completed: "Completed",
  no_show: "No-show",
  cancelled: "Cancelled",
};

export type AppointmentOutcomeRepairProps = {
  appointmentId: string;
  status: RevertibleStatus;
  repairState: AppointmentRepairState;
};

export function AppointmentOutcomeRepair({
  appointmentId,
  status,
  repairState,
}: AppointmentOutcomeRepairProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const currentLabel = STATUS_LABEL[status];
  // Mirrors the SQL floor so the button is inert until the reason is usable.
  // The command re-checks after its own btrim; this only avoids a pointless
  // round-trip.
  const reasonReady = reason.trim().length >= MIN_REPAIR_REASON_LENGTH;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await revertAppointmentOutcomeAction({
        appointmentId,
        expectedStatus: status,
        reason,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Outcome
      </h2>
      <p className="text-neutral-700 dark:text-neutral-300">{currentLabel}</p>

      {!repairState.repairable ? (
        // Blocked: explain, do not offer. This is the branch that keeps the
        // surface honest when a payment, a treatment record or an aftercare
        // email has already made the outcome load-bearing.
        <p className="text-xs text-neutral-500">{repairState.reason}</p>
      ) : !open ? (
        <div>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-900"
          >
            Correct outcome
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-1 flex flex-col gap-3">
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Correct appointment outcome
          </h3>
          <dl className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            <div className="flex gap-2">
              <dt>Current status:</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-200">
                {currentLabel}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt>Restore to:</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-200">
                Confirmed
              </dd>
            </div>
          </dl>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Reason
            </span>
            <textarea
              name="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What was corrected, and why"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>

          <p className="text-xs text-neutral-500">
            This repair is recorded in the appointment audit history.
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
              disabled={pending || !reasonReady}
              className="rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {pending ? "Restoring…" : "Restore appointment"}
            </button>
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
