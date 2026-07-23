"use client";

import { useState, useTransition } from "react";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import type {
  EffectiveDay,
  EffectiveOverride,
} from "@/lib/booking/practitioner-availability";
import {
  upsertScopedDayDefaultAction,
  resetPractitionerDayAction,
  customizePractitionerWeekAction,
  resetPractitionerWeekAction,
  upsertScopedOverrideAction,
  resetPractitionerOverrideAction,
  type AvailabilityActionResult,
} from "./actions";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// Format a stored canonical "HH:MM" for display, honouring the studio's 12/24h
// preference. The persisted value is always canonical HH:MM regardless.
function fmt(hhmm: string | null, timeFormat: "12h" | "24h"): string {
  if (!hhmm) return "";
  if (timeFormat === "24h") return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function statusLabel(d: EffectiveDay): string {
  if (d.source === "studio_default") return "Using studio default";
  return d.is_open ? "Custom hours" : "Closed for this practitioner";
}

export function PractitionerWeekEditor({
  practitionerId,
  practitionerName,
  practitionerColor,
  timeFormat,
  week,
  overrides,
}: {
  practitionerId: string;
  practitionerName: string;
  practitionerColor: string;
  timeFormat: "12h" | "24h";
  week: EffectiveDay[];
  overrides: EffectiveOverride[];
}) {
  const color = resolvePractitionerColor(practitionerColor);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editingDow, setEditingDow] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ is_open: boolean; open: string; close: string }>({
    is_open: true,
    open: "09:00",
    close: "17:00",
  });
  const [confirmResetWeek, setConfirmResetWeek] = useState(false);

  function run(action: () => Promise<AvailabilityActionResult>, okText: string) {
    setMsg(null);
    startTransition(async () => {
      const r = await action();
      if (r.ok) {
        setMsg({ ok: true, text: okText });
        setEditingDow(null);
        setConfirmResetWeek(false);
      } else {
        setMsg({ ok: false, text: r.error });
      }
    });
  }

  function fd(fields: Record<string, string>): FormData {
    const f = new FormData();
    f.set("practitioner_id", practitionerId);
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  }

  function openEditor(d: EffectiveDay) {
    setDraft({
      is_open: d.is_open,
      open: d.open_time || "09:00",
      close: d.close_time || "17:00",
    });
    setEditingDow(d.day_of_week);
    setMsg(null);
  }

  function saveDay(dow: number) {
    run(
      () =>
        upsertScopedDayDefaultAction(
          fd({
            day_of_week: String(dow),
            is_open: String(draft.is_open),
            open_time: draft.open,
            close_time: draft.close,
          }),
        ),
      "Saved.",
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-lg font-medium">
          <span aria-hidden="true" className={`h-3 w-3 rounded-full ${color.bg}`} />
          {practitionerName}&rsquo;s weekly hours
        </h3>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(
                () => customizePractitionerWeekAction(fd({})),
                "Customized the full week from the studio default.",
              )
            }
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Customize full week from studio default
          </button>
          {confirmResetWeek ? (
            <span className="flex items-center gap-2 text-sm">
              Reset all custom days?
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () => resetPractitionerWeekAction(fd({})),
                    "Reset the full week to the studio default.",
                  )
                }
                className="rounded-md bg-red-600 px-2 py-1 text-white disabled:opacity-50"
              >
                Reset week
              </button>
              <button type="button" onClick={() => setConfirmResetWeek(false)} className="underline">
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmResetWeek(true)}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Reset full week to studio default
            </button>
          )}
        </div>
      </div>

      {msg && (
        <p
          role="status"
          className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}
        >
          {msg.text}
        </p>
      )}

      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {week.map((d) => (
          <li key={d.day_of_week} className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{DAY_NAMES[d.day_of_week]}</span>
                <span className="ml-2 text-sm text-neutral-600 dark:text-neutral-400">
                  {d.is_open ? `${fmt(d.open_time, timeFormat)} – ${fmt(d.close_time, timeFormat)}` : "Closed"}
                </span>
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-xs ${
                    d.hasCustom
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                  }`}
                >
                  {statusLabel(d)}
                </span>
              </div>
              <div className="flex gap-2 text-sm">
                {editingDow !== d.day_of_week && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => openEditor(d)}
                    className="underline disabled:opacity-50"
                  >
                    {d.hasCustom ? "Edit" : "Customize"}
                  </button>
                )}
                {d.hasCustom && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => resetPractitionerDayAction(fd({ day_of_week: String(d.day_of_week) })),
                        "Reset to the studio default.",
                      )
                    }
                    className="underline text-neutral-500 disabled:opacity-50"
                  >
                    Reset to studio default
                  </button>
                )}
              </div>
            </div>

            {editingDow === d.day_of_week && (
              <div className="flex flex-wrap items-center gap-3 rounded-md bg-neutral-50 p-3 dark:bg-neutral-900">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.is_open}
                    onChange={(e) => setDraft((s) => ({ ...s, is_open: e.target.checked }))}
                    aria-label={`Open on ${DAY_NAMES[d.day_of_week]}`}
                  />
                  Open
                </label>
                {draft.is_open && (
                  <>
                    <label className="flex items-center gap-1 text-sm">
                      <span className="sr-only">{`Open time for ${DAY_NAMES[d.day_of_week]}`}</span>
                      <input
                        type="time"
                        value={draft.open}
                        aria-label={`Open time for ${DAY_NAMES[d.day_of_week]}`}
                        onChange={(e) => setDraft((s) => ({ ...s, open: e.target.value }))}
                        className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
                      />
                    </label>
                    <span aria-hidden="true">–</span>
                    <label className="flex items-center gap-1 text-sm">
                      <input
                        type="time"
                        value={draft.close}
                        aria-label={`Close time for ${DAY_NAMES[d.day_of_week]}`}
                        onChange={(e) => setDraft((s) => ({ ...s, close: e.target.value }))}
                        className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
                      />
                    </label>
                  </>
                )}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => saveDay(d.day_of_week)}
                  className="rounded-md bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                >
                  {pending ? "Saving…" : "Save"}
                </button>
                <button type="button" onClick={() => setEditingDow(null)} className="text-sm underline">
                  Cancel
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <OverridesSection
        practitionerId={practitionerId}
        practitionerName={practitionerName}
        timeFormat={timeFormat}
        overrides={overrides}
        run={run}
        fd={fd}
        pending={pending}
      />
    </div>
  );
}

function OverridesSection({
  practitionerName,
  timeFormat,
  overrides,
  run,
  fd,
  pending,
}: {
  practitionerId: string;
  practitionerName: string;
  timeFormat: "12h" | "24h";
  overrides: EffectiveOverride[];
  run: (a: () => Promise<AvailabilityActionResult>, ok: string) => void;
  fd: (fields: Record<string, string>) => FormData;
  pending: boolean;
}) {
  const [date, setDate] = useState("");
  const [isOpen, setIsOpen] = useState(true);
  const [open, setOpen] = useState("10:00");
  const [close, setClose] = useState("15:00");

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-base font-medium">Date-specific overrides</h4>
      <ul className="flex flex-col gap-1 text-sm">
        {overrides.length === 0 && (
          <li className="text-neutral-500">No date overrides in the next 90 days.</li>
        )}
        {overrides.map((o) => (
          <li key={o.effective_date} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="font-medium">{o.effective_date}</span>{" "}
              {o.source === "practitioner_override"
                ? o.is_open
                  ? `Custom hours for ${practitionerName}: ${fmt(o.open_time, timeFormat)} – ${fmt(o.close_time, timeFormat)}`
                  : `Closed for ${practitionerName}`
                : o.is_open
                  ? `Using studio date override: ${fmt(o.open_time, timeFormat)} – ${fmt(o.close_time, timeFormat)}`
                  : "Using studio date override: Closed"}
            </span>
            {o.source === "practitioner_override" && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () => upsertResetOverride(fd, o.effective_date),
                    "Reset the date override to the studio behaviour.",
                  )
                }
                className="underline text-neutral-500 disabled:opacity-50"
              >
                Reset to studio
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
        <label className="flex flex-col text-xs">
          Date
          <input
            type="date"
            value={date}
            aria-label="Override date"
            onChange={(e) => setDate(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isOpen} onChange={(e) => setIsOpen(e.target.checked)} aria-label="Open on this date" />
          Open
        </label>
        {isOpen && (
          <>
            <input type="time" value={open} aria-label="Override open time" onChange={(e) => setOpen(e.target.value)} className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800" />
            <span aria-hidden="true">–</span>
            <input type="time" value={close} aria-label="Override close time" onChange={(e) => setClose(e.target.value)} className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800" />
          </>
        )}
        <button
          type="button"
          disabled={pending || !date}
          onClick={() =>
            run(
              () =>
                upsertScopedOverrideAction(
                  fd({
                    effective_date: date,
                    is_open: String(isOpen),
                    open_time: open,
                    close_time: close,
                  }),
                ),
              `Saved a date override for ${practitionerName}.`,
            )
          }
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Saving…" : `Save override for ${practitionerName}`}
        </button>
      </div>
    </div>
  );
}

function upsertResetOverride(
  fd: (fields: Record<string, string>) => FormData,
  effectiveDate: string,
): Promise<AvailabilityActionResult> {
  return resetPractitionerOverrideAction(fd({ effective_date: effectiveDate }));
}
