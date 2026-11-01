"use client";

import { PORTAL_OFF_STAFF_MESSAGE } from "@/lib/booking/client-self-service-policy";

import { useState, useTransition } from "react";
import { setClientSelfServiceAction } from "./actions";

type Initial = { cancellation: boolean; reschedule: boolean };

const ROWS: ReadonlyArray<{
  key: keyof Initial;
  label: string;
  helper: string;
}> = [
  {
    key: "cancellation",
    label: "Let clients cancel online",
    helper:
      "When off, the cancel link in emails and on the booking page tells the client the studio handles cancellations directly. Their appointment is not changed.",
  },
  {
    key: "reschedule",
    label: "Let clients reschedule online",
    helper:
      "When off, the reschedule link tells the client the studio handles changes directly. Their appointment is not changed.",
  },
];

export function ClientSelfServiceForm({
  initial,
  portalEnabled = true,
}: {
  initial: Initial;
  // HON-47. Read-only status; the portal switch itself is not on this page.
  portalEnabled?: boolean;
}) {
  const [state, setState] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: keyof Initial) {
    const next = { ...state, [key]: !state[key] };
    setState(next);
    setError(null);
    setHint(null);
    const fd = new FormData();
    fd.set("client_cancellation_enabled", next.cancellation ? "true" : "false");
    fd.set("client_reschedule_enabled", next.reschedule ? "true" : "false");
    startTransition(async () => {
      const res = await setClientSelfServiceAction(fd);
      if (!res.ok) {
        setError(res.error);
        setState(state);
        return;
      }
      setHint("Saved");
      window.setTimeout(() => setHint(null), 1500);
    });
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        {/* The view heading (Client self-service) comes from the route. */}
        <p className="text-sm text-neutral-500">
          Choose what clients can change themselves from their email links. Reminders and
          aftercare emails keep sending either way; only the cancel and reschedule options change. The client portal and online rebooking are not affected by these switches.
        </p>
      </div>
      {!portalEnabled && (
        <p
          data-testid="client-portal-off-status"
          className="rounded-md bg-neutral-50 p-3 text-sm text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
        >
          {PORTAL_OFF_STAFF_MESSAGE}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {ROWS.map((r) => (
          <li key={r.key} className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{r.label}</p>
              <p className="mt-1 text-xs text-neutral-500">{r.helper}</p>
            </div>
            <button
              type="button"
              onClick={() => toggle(r.key)}
              disabled={pending}
              aria-pressed={state[r.key]}
              aria-label={r.label}
              className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
                state[r.key] ? "bg-neutral-900 dark:bg-white" : "bg-neutral-300 dark:bg-neutral-700"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all dark:bg-neutral-950 ${
                  state[r.key] ? "left-[1.375rem]" : "left-0.5"
                }`}
              />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 text-xs">
        {hint && <span className="text-green-600 dark:text-green-400">{hint}</span>}
        {error && <span className="text-red-700">{error}</span>}
      </div>
    </section>
  );
}
