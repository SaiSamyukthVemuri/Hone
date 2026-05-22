"use client";

import { useState, useTransition } from "react";
import type { Studio } from "@/lib/types/database";
import { setStudioEmailSettingsAction } from "./actions";

type Toggle = {
  key: keyof Pick<
    Studio,
    | "send_confirmation_emails"
    | "send_24h_reminders"
    | "send_2h_reminders"
    | "auto_mark_no_shows"
    | "send_no_show_followup"
  >;
  label: string;
  helper?: string;
};

const TOGGLES: ReadonlyArray<Toggle> = [
  {
    key: "send_confirmation_emails",
    label: "Send confirmation emails when appointments are booked",
  },
  { key: "send_24h_reminders", label: "Send 24-hour reminders" },
  { key: "send_2h_reminders", label: "Send 2-hour reminders" },
  {
    key: "auto_mark_no_shows",
    label: "Automatically mark no-shows",
    helper: "30 minutes after start time when the appointment was not cancelled.",
  },
  {
    key: "send_no_show_followup",
    label: "Send follow-up email to no-shows",
    helper:
      "Sends a message to clients who didn't make it, inviting them to rebook.",
  },
];

type Props = {
  initial: Pick<
    Studio,
    | "send_confirmation_emails"
    | "send_24h_reminders"
    | "send_2h_reminders"
    | "auto_mark_no_shows"
    | "send_no_show_followup"
  >;
};

export function EmailSettingsForm({ initial }: Props) {
  const [state, setState] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: Toggle["key"]) {
    const next = { ...state, [key]: !state[key] };
    setState(next);
    setError(null);
    setHint(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(next)) {
      fd.set(k, v ? "true" : "false");
    }
    startTransition(async () => {
      const res = await setStudioEmailSettingsAction(fd);
      if (!res.ok) {
        setError(res.error);
        setState(initial);
        return;
      }
      setHint("Saved");
      window.setTimeout(() => setHint(null), 1500);
    });
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-medium">Email notifications</h2>
        <p className="mt-1 text-sm text-neutral-500">
          All emails are sent from hello@hone.care and appear as your studio.
          Clients can cancel or reschedule directly from any of these emails.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {TOGGLES.map((t) => (
          <li key={t.key} className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.label}</p>
              {t.helper && (
                <p className="mt-1 text-xs text-neutral-500">{t.helper}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => toggle(t.key)}
              disabled={pending}
              aria-pressed={state[t.key]}
              className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
                state[t.key] ? "bg-neutral-900 dark:bg-white" : "bg-neutral-300 dark:bg-neutral-700"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all dark:bg-neutral-950 ${
                  state[t.key] ? "left-[1.375rem]" : "left-0.5"
                }`}
              />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 text-xs">
        {hint && (
          <span className="text-green-600 dark:text-green-400">{hint}</span>
        )}
        {error && <span className="text-red-700">{error}</span>}
      </div>
    </section>
  );
}
