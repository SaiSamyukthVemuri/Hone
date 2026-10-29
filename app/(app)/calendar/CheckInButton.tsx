"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setAppointmentArrivedAction } from "./actions";
import { ARRIVED_GLYPH, ARRIVED_TAG } from "@/lib/calendar/arrival";

// HON-48: the front-desk check-in control. The command, not this button, decides
// who may check a client in; a refusal is shown as its message.
export function CheckInButton({
  appointmentId,
  checkedIn,
  onChanged,
}: {
  appointmentId: string;
  checkedIn: boolean;
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run() {
    if (pending) return;
    setError(null);
    const fd = new FormData();
    fd.set("appointment_id", appointmentId);
    fd.set("arrived", checkedIn ? "false" : "true");
    startTransition(async () => {
      const res = await setAppointmentArrivedAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
      onChanged?.();
    });
  }

  return (
    <div className="flex flex-col gap-1" data-testid="check-in-control">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {pending ? "Saving…" : checkedIn ? `Undo ${ARRIVED_TAG.toLowerCase()}` : `${ARRIVED_GLYPH} Check in`}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
