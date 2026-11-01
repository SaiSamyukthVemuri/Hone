"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reassignOpenAppointmentAction } from "./actions";

type Option = { id: string; displayName: string };

// One explicit, per-appointment correction. Nothing here is pre-applied: the suggestion only
// pre-selects the dropdown, and the owner still has to press the button.
export function ReassignRow({
  appointmentId,
  options,
  suggestionId,
  currentId,
  canChange,
}: {
  appointmentId: string;
  options: Option[];
  suggestionId: string | null;
  currentId: string | null;
  canChange: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const initial = suggestionId ?? options.find((o) => o.id !== currentId)?.id ?? "";
  const [target, setTarget] = useState(initial);

  if (!canChange) {
    return (
      <p data-testid="check-practitioner-started" className="text-xs text-neutral-500">
        This appointment has already started. Changing its practitioner is not available yet.
      </p>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData();
        fd.set("appointment_id", appointmentId);
        fd.set("target_practitioner_id", target);
        start(async () => {
          const res = await reassignOpenAppointmentAction(fd);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          router.refresh();
        });
      }}
    >
      <label className="sr-only" htmlFor={`target-${appointmentId}`}>
        Practitioner
      </label>
      <select
        id={`target-${appointmentId}`}
        data-testid="check-practitioner-select"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="min-h-[44px] rounded-md border border-neutral-300 bg-white px-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.displayName}
            {o.id === currentId ? " (current)" : ""}
            {o.id === suggestionId ? " (suggested)" : ""}
          </option>
        ))}
      </select>
      <button
        type="submit"
        data-testid="check-practitioner-confirm"
        disabled={pending || !target || target === currentId}
        className="min-h-[44px] rounded-md bg-neutral-900 px-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Saving…" : "Change practitioner"}
      </button>
      {error && (
        <p role="alert" className="w-full text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
