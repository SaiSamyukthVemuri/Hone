"use client";

import { useState, useTransition } from "react";
import type { Studio } from "@/lib/types/database";
import { setStudioSmsSettingsAction } from "./sms-settings-actions";

type Key = keyof Pick<
  Studio,
  "send_confirmation_sms" | "send_24h_sms_reminders" | "send_2h_sms_reminders"
>;

const TOGGLES: ReadonlyArray<{ key: Key; label: string; helper?: string }> = [
  { key: "send_confirmation_sms", label: "Text a confirmation when an appointment is booked" },
  { key: "send_24h_sms_reminders", label: "Send 24-hour text reminders" },
  { key: "send_2h_sms_reminders", label: "Send 2-hour text reminders" },
];

type Props = { initial: Pick<Studio, Key> };

export function SmsSettingsForm({ initial }: Props) {
  const [state, setState] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: Key) {
    const next = { ...state, [key]: !state[key] };
    setState(next);
    setError(null);
    setHint(null);
    const fd = new FormData();
    for (const t of TOGGLES) fd.set(t.key, next[t.key] ? "true" : "false");
    startTransition(async () => {
      const res = await setStudioSmsSettingsAction(fd);
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
    <section className="flex flex-col gap-4" data-testid="sms-settings">
      <div>
        <h2 id="sms-notifications" className="scroll-mt-24 text-lg font-medium">
          Text messages
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Texts go only to clients who have agreed to receive them and have not
          opted out. A client without a phone number or without that agreement
          gets no text, whatever is switched on here. Email notifications above
          are separate.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {TOGGLES.map((t) => (
          <li key={t.key} className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.label}</p>
            </div>
            <button
              type="button"
              onClick={() => toggle(t.key)}
              disabled={pending}
              aria-pressed={state[t.key]}
              aria-label={t.label}
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
        {hint && <span className="text-green-600 dark:text-green-400">{hint}</span>}
        {error && <span className="text-red-700">{error}</span>}
      </div>
    </section>
  );
}
