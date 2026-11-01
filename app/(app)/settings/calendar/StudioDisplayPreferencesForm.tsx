"use client";

import { useState, useTransition } from "react";
import { updateStudioDisplayPreferencesAction } from "../studio/actions";
import { BIRTHDAY_REMINDER_COLORS, resolveBirthdayColor } from "@/lib/birthday-colors";
import type { BirthdayReminderColor } from "@/lib/types/database";
import type { TimeFormat } from "@/lib/booking/tz";
import { SaveStatus, useSaveFeedback } from "@/components/settings/save-status";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";

const TIME_FORMAT_OPTIONS: ReadonlyArray<{ value: TimeFormat; label: string }> = [
  { value: "12h", label: "12-hour · 2:30 PM" },
  { value: "24h", label: "24-hour · 14:30" },
];

type Props = {
  initialBirthdayColor: BirthdayReminderColor;
  initialTimeFormat: TimeFormat;
};

const CHOICE_BASE = "rounded-full border px-3 py-1.5 text-sm transition";
const CHOICE_ON = "border-neutral-900 dark:border-neutral-100";
const CHOICE_OFF = "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700";

export function StudioDisplayPreferencesForm({ initialBirthdayColor, initialTimeFormat }: Props) {
  const [saved, setSaved] = useState({ color: initialBirthdayColor, timeFormat: initialTimeFormat });
  const [birthdayColor, setBirthdayColor] = useState<BirthdayReminderColor>(initialBirthdayColor);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(initialTimeFormat);
  const [pending, startTransition] = useTransition();
  const feedback = useSaveFeedback();

  const dirty = birthdayColor !== saved.color || timeFormat !== saved.timeFormat;
  useUnsavedChangesGuard("studio-display-preferences", dirty);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    feedback.saving();
    const fd = new FormData();
    fd.set("birthday_reminder_color", birthdayColor);
    fd.set("time_format", timeFormat);
    startTransition(async () => {
      try {
        const result = await updateStudioDisplayPreferencesAction(fd);
        if (result.ok) {
          setSaved({ color: birthdayColor, timeFormat });
          feedback.saved();
        } else {
          feedback.failed(result.error);
        }
      } catch (err) {
        feedback.failed(err instanceof Error ? err.message : "Failed to save.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-xl flex-col gap-5">
      <div id="birthday-color" className="flex scroll-mt-24 flex-col gap-1.5">
        <span className="text-sm font-medium">Birthday reminder color</span>
        <p className="text-xs text-neutral-500">
          Choose the accent color used for birthday reminders. Red is reserved for allergies and cautions.
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          {BIRTHDAY_REMINDER_COLORS.map((opt) => {
            const selected = birthdayColor === opt.value;
            const classes = resolveBirthdayColor(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setBirthdayColor(opt.value);
                  feedback.reset();
                }}
                aria-pressed={selected}
                className={`flex items-center gap-2 ${CHOICE_BASE} ${selected ? CHOICE_ON : CHOICE_OFF}`}
              >
                <span aria-hidden className={`inline-block h-3.5 w-3.5 rounded-full ${classes.swatch}`} />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div id="time-format" className="flex scroll-mt-24 flex-col gap-1.5">
        <span className="text-sm font-medium">Time format</span>
        <p className="text-xs text-neutral-500">
          How times are shown on your calendar, dashboard, and availability. Client-facing messages (texts, emails,
          online booking) always use 12-hour time.
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          {TIME_FORMAT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setTimeFormat(opt.value);
                feedback.reset();
              }}
              aria-pressed={timeFormat === opt.value}
              className={`${CHOICE_BASE} ${timeFormat === opt.value ? CHOICE_ON : CHOICE_OFF}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !dirty}
          className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving" : "Save"}
        </button>
        <SaveStatus state={feedback.state} />
      </div>
    </form>
  );
}
