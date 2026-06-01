"use client";

import { useState, useTransition } from "react";
import type { Studio } from "@/lib/types/database";
import { setStudioEmailSettingsAction } from "./actions";

type Toggle = {
  key: keyof Pick<
    Studio,
    | "send_confirmation_emails"
    | "notify_practitioner_on_new_booking"
    | "send_24h_reminders"
    | "send_2h_reminders"
    | "auto_mark_no_shows"
    | "send_no_show_followup"
    | "show_treatment_time_to_clients"
  >;
  label: string;
  helper?: string;
  // P0-1: when set, the toggle is forced OFF in the UI and cannot be
  // changed. The previous "auto no-show" implementation was unsafe
  // (mutated status based on starts_at + 30min, not ends_at) and the
  // backing cron has been replaced with a non-mutating informational
  // endpoint. The control re-enables only after the lifecycle work in
  // the next phase: ends_at + grace + atomic claim + duplicate-send
  // protection.
  forceOff?: boolean;
  forceOffReason?: string;
};

const TOGGLES: ReadonlyArray<Toggle> = [
  {
    key: "send_confirmation_emails",
    label: "Send confirmation emails when appointments are booked",
  },
  {
    key: "notify_practitioner_on_new_booking",
    label: "Email me when a new booking is created",
    helper:
      "Send the studio owner a notification when a client books online. Client confirmation emails are separate and stay unchanged.",
  },
  { key: "send_24h_reminders", label: "Send 24-hour reminders" },
  { key: "send_2h_reminders", label: "Send 2-hour reminders" },
  {
    key: "auto_mark_no_shows",
    label: "Automatically mark no-shows",
    helper:
      "Disabled while no-show lifecycle is being hardened. Use the Mark no-show button on the appointment after the end time instead.",
    forceOff: true,
    forceOffReason:
      "Disabled while no-show lifecycle is being hardened. Use the Mark no-show button on the appointment after the end time instead.",
  },
  {
    key: "send_no_show_followup",
    label: "Send follow-up email to no-shows",
    helper:
      "Disabled until automatic no-show is re-enabled with end-time-aware lifecycle.",
    forceOff: true,
    forceOffReason:
      "Disabled until automatic no-show is re-enabled with end-time-aware lifecycle.",
  },
  {
    key: "show_treatment_time_to_clients",
    label: "Show treatment time to clients in emails",
    helper:
      "When on, confirmation and reminder emails include the client's total treatment time so far and the session number. Useful for transparency; some practitioners prefer keeping this internal.",
  },
];

type Props = {
  initial: Pick<
    Studio,
    | "send_confirmation_emails"
    | "notify_practitioner_on_new_booking"
    | "send_24h_reminders"
    | "send_2h_reminders"
    | "auto_mark_no_shows"
    | "send_no_show_followup"
    | "show_treatment_time_to_clients"
  >;
};

export function EmailSettingsForm({ initial }: Props) {
  const [state, setState] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(t: Toggle) {
    if (t.forceOff) {
      // P0-1: the no-show family of toggles is force-off in this build.
      // Any attempt to flip them is a no-op surfaced as a hint.
      setError(null);
      setHint(t.forceOffReason ?? "This setting is currently disabled.");
      window.setTimeout(() => setHint(null), 2500);
      return;
    }
    const key = t.key;
    const next = { ...state, [key]: !state[key] };
    setState(next);
    setError(null);
    setHint(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(next)) {
      // Force-off toggles are always submitted as false so the
      // backing studios row cannot drift back to true via this form.
      const matchingToggle = TOGGLES.find((tt) => tt.key === k);
      if (matchingToggle?.forceOff) {
        fd.set(k, "false");
      } else {
        fd.set(k, v ? "true" : "false");
      }
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
        {TOGGLES.map((t) => {
          const isForceOff = t.forceOff === true;
          // Force-off toggles always render in the OFF position
          // regardless of the underlying studios row (which is also
          // re-written to false by the form action).
          const displayOn = isForceOff ? false : state[t.key];
          return (
            <li key={t.key} className="flex items-start justify-between gap-4 p-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t.label}</p>
                {t.helper && (
                  <p className="mt-1 text-xs text-neutral-500">{t.helper}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => toggle(t)}
                disabled={pending || isForceOff}
                aria-pressed={displayOn}
                aria-disabled={isForceOff}
                title={isForceOff ? t.forceOffReason : undefined}
                className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
                  displayOn ? "bg-neutral-900 dark:bg-white" : "bg-neutral-300 dark:bg-neutral-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all dark:bg-neutral-950 ${
                    displayOn ? "left-[1.375rem]" : "left-0.5"
                  }`}
                />
              </button>
            </li>
          );
        })}
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
