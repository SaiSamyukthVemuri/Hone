"use client";

import { useEffect, useState, useTransition } from "react";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { editSessionStartedAtAction } from "./actions";

function toDateTimeLocalString(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Props = {
  sessionId: string;
  clientId: string;
  startedAtIso: string;
};

export function EditSessionStartedAt({
  sessionId,
  clientId,
  startedAtIso,
}: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => toDateTimeLocalString(startedAtIso));
  const [error, setError] = useState<string | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  // Reset the input whenever the canonical timestamp changes underneath us
  // (e.g. after a successful save the server-rendered iso updates).
  useEffect(() => {
    setValue(toDateTimeLocalString(startedAtIso));
  }, [startedAtIso]);

  function handleCancel() {
    setOpen(false);
    setError(null);
    setValue(toDateTimeLocalString(startedAtIso));
  }

  function handleSave() {
    setError(null);
    if (!value) {
      setError("Pick a date and time.");
      return;
    }
    const local = new Date(value);
    if (Number.isNaN(local.getTime())) {
      setError("That isn't a valid date or time.");
      return;
    }

    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("new_started_at", local.toISOString());

    startTransition(async () => {
      const result = await editSessionStartedAtAction(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setShowSaved(true);
      window.setTimeout(() => setShowSaved(false), 1500);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-3 text-sm text-neutral-500">
        <span>
          Started <FormattedDateTime iso={startedAtIso} />
        </span>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
          >
            Edit time
          </button>
        )}
        {showSaved && (
          <span
            className="text-xs text-green-600 dark:text-green-400"
            aria-live="polite"
          >
            Saved
          </span>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Session start
            </span>
            <input
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={pending}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={pending}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {pending ? "Saving" : "Save"}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={pending}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Cancel
            </button>
            {error && (
              <span className="text-xs text-red-600 dark:text-red-400">
                {error}
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-500">
            Edits are recorded in the session&rsquo;s history.
          </p>
        </div>
      )}
    </div>
  );
}
