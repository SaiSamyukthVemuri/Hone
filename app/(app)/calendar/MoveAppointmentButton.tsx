"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import MoveAppointmentDialog, { type MoveDialogAppointment } from "./MoveAppointmentDialog";

// The single practitioner entry point into the shared Move workflow. Rendered on
// the responsive appointment detail page (mobile/tablet/desktop) AND from the
// desktop in-grid preview drawer. It only OPENS the shared MoveAppointmentDialog —
// it holds no mutation logic of its own (the dialog owns the two server actions,
// which re-authorize server-side). The trigger is gated by the caller to a
// confirmed, future appointment; this component does not re-derive that gate.

type Props = {
  appointment: MoveDialogAppointment;
  studioTimezone: string;
  timeFormat: "12h" | "24h";
  className?: string;
  label?: string;
  // Optional: notified after a successful move so an enclosing surface (e.g. the
  // preview drawer) can close itself. router.refresh() always runs regardless.
  onMoved?: () => void;
};

export function MoveAppointmentButton({
  appointment,
  studioTimezone,
  timeFormat,
  className,
  label = "Move appointment",
  onMoved,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => { setNotice(null); setOpen(true); }}
        className={
          className ??
          "min-h-[44px] rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        }
      >
        {label}
      </button>
      {notice && (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400" role="status">{notice}</p>
      )}
      <MoveAppointmentDialog
        open={open}
        onClose={() => setOpen(false)}
        appointment={appointment}
        studioTimezone={studioTimezone}
        timeFormat={timeFormat}
        onMoved={(r) => {
          setOpen(false);
          setNotice(
            r.notificationStatus === "degraded"
              ? "Appointment moved. The client email could not be delivered."
              : "Appointment moved.",
          );
          router.refresh();
          onMoved?.();
        }}
      />
    </>
  );
}
