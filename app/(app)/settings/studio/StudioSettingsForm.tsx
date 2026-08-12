"use client";

import { useState, useTransition } from "react";
import { updateStudioAction } from "./actions";
import {
  BIRTHDAY_REMINDER_COLORS,
  resolveBirthdayColor,
} from "@/lib/birthday-colors";
import type { BirthdayReminderColor } from "@/lib/types/database";
import type { TimeFormat } from "@/lib/booking/tz";

const TIME_FORMAT_OPTIONS: ReadonlyArray<{ value: TimeFormat; label: string }> = [
  { value: "12h", label: "12-hour · 2:30 PM" },
  { value: "24h", label: "24-hour · 14:30" },
];

type Props = {
  initialName: string;
  initialLegalEntity: string;
  ownerEmail: string;
  initialBirthdayColor: BirthdayReminderColor;
  initialTimeFormat: TimeFormat;
};

export function StudioSettingsForm({
  initialName,
  initialLegalEntity,
  ownerEmail,
  initialBirthdayColor,
  initialTimeFormat,
}: Props) {
  const [name, setName] = useState(initialName);
  const [legalEntity, setLegalEntity] = useState(initialLegalEntity);
  const [birthdayColor, setBirthdayColor] =
    useState<BirthdayReminderColor>(initialBirthdayColor);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(initialTimeFormat);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<
    { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      setHint({ kind: "error", message: "Studio name is required." });
      return;
    }
    setHint({ kind: "idle" });
    const fd = new FormData();
    fd.set("name", name);
    fd.set("legal_entity_name", legalEntity);
    fd.set("birthday_reminder_color", birthdayColor);
    fd.set("time_format", timeFormat);

    startTransition(async () => {
      try {
        await updateStudioAction(fd);
        setHint({ kind: "saved" });
        window.setTimeout(() => setHint({ kind: "idle" }), 1500);
      } catch (err) {
        setHint({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to save.",
        });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-xl flex-col gap-5">
      <label id="studio-name" className="flex scroll-mt-24 flex-col gap-1.5">
        <span className="text-sm font-medium">
          Studio name<span className="ml-1 text-red-500">*</span>
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <label id="legal-entity" className="flex scroll-mt-24 flex-col gap-1.5">
        <span className="text-sm font-medium">Legal entity name</span>
        <input
          value={legalEntity}
          onChange={(e) => setLegalEntity(e.target.value)}
          placeholder="If different from studio name"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Owner email</span>
        <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-base text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
          {ownerEmail}
        </p>
      </div>

      <div id="birthday-color" className="flex scroll-mt-24 flex-col gap-1.5">
        <span className="text-sm font-medium">Birthday reminder color</span>
        <p className="text-xs text-neutral-500">
          Choose the accent color used for birthday reminders. Red is
          reserved for allergies and cautions.
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          {BIRTHDAY_REMINDER_COLORS.map((opt) => {
            const selected = birthdayColor === opt.value;
            const classes = resolveBirthdayColor(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setBirthdayColor(opt.value)}
                aria-pressed={selected}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
                  selected
                    ? "border-neutral-900 dark:border-neutral-100"
                    : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"
                }`}
              >
                <span
                  aria-hidden
                  className={`inline-block h-3.5 w-3.5 rounded-full ${classes.swatch}`}
                />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div id="time-format" className="flex scroll-mt-24 flex-col gap-1.5">
        <span className="text-sm font-medium">Time format</span>
        <p className="text-xs text-neutral-500">
          How times are shown on your calendar, dashboard, and availability.
          Client-facing messages (texts, emails, online booking) always use
          12-hour time.
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          {TIME_FORMAT_OPTIONS.map((opt) => {
            const selected = timeFormat === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTimeFormat(opt.value)}
                aria-pressed={selected}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  selected
                    ? "border-neutral-900 dark:border-neutral-100"
                    : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving" : "Save"}
        </button>
        {hint.kind === "saved" && (
          <span className="text-sm text-green-600 dark:text-green-400">
            Saved
          </span>
        )}
        {hint.kind === "error" && (
          <span className="text-sm text-red-600 dark:text-red-400">
            {hint.message}
          </span>
        )}
      </div>
    </form>
  );
}
