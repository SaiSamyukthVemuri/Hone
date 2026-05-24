"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type {
  StudioAvailabilityDefault,
  StudioAvailabilityOverride,
  StudioBlockout,
} from "@/lib/types/database";
import { BookingLinkCard } from "../booking/BookingLinkCard";
import {
  createBlockoutAction,
  deleteBlockoutAction,
  deleteOverrideAction,
  saveWeeklyDefaultsAction,
  upsertDayDefaultAction,
  upsertOverrideAction,
} from "./actions";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_NAMES_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// Visible grid window. Locks 6am-10pm; out-of-window hours still save but
// won't render as a block, which is fine for v1.
const GRID_START_MIN = 6 * 60;
const GRID_END_MIN = 22 * 60;
const HOUR_HEIGHT_PX = 32;
const GRID_HEIGHT = ((GRID_END_MIN - GRID_START_MIN) / 60) * HOUR_HEIGHT_PX;

const DEFAULT_OPEN = "10:00";
const DEFAULT_CLOSE = "18:00";

const PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  days: ReadonlyArray<{
    dow: number;
    is_open: boolean;
    open?: string;
    close?: string;
  }>;
}> = [
  {
    id: "weekdays-9-5",
    label: "Weekdays 9–5",
    description: "Mon–Fri 09:00–17:00, weekends closed.",
    days: [
      { dow: 0, is_open: false },
      { dow: 1, is_open: true, open: "09:00", close: "17:00" },
      { dow: 2, is_open: true, open: "09:00", close: "17:00" },
      { dow: 3, is_open: true, open: "09:00", close: "17:00" },
      { dow: 4, is_open: true, open: "09:00", close: "17:00" },
      { dow: 5, is_open: true, open: "09:00", close: "17:00" },
      { dow: 6, is_open: false },
    ],
  },
  {
    id: "weekdays-10-6",
    label: "Weekdays 10–6",
    description: "Mon–Fri 10:00–18:00, weekends closed.",
    days: [
      { dow: 0, is_open: false },
      { dow: 1, is_open: true, open: "10:00", close: "18:00" },
      { dow: 2, is_open: true, open: "10:00", close: "18:00" },
      { dow: 3, is_open: true, open: "10:00", close: "18:00" },
      { dow: 4, is_open: true, open: "10:00", close: "18:00" },
      { dow: 5, is_open: true, open: "10:00", close: "18:00" },
      { dow: 6, is_open: false },
    ],
  },
  {
    id: "tue-thu-10-6",
    label: "Tue / Thu 10–6",
    description: "Just Tuesday and Thursday 10:00–18:00.",
    days: [
      { dow: 0, is_open: false },
      { dow: 1, is_open: false },
      { dow: 2, is_open: true, open: "10:00", close: "18:00" },
      { dow: 3, is_open: false },
      { dow: 4, is_open: true, open: "10:00", close: "18:00" },
      { dow: 5, is_open: false },
      { dow: 6, is_open: false },
    ],
  },
];

function trimTime(t: string | null): string {
  if (!t) return "";
  return t.slice(0, 5);
}

function timeToMin(t: string): number | null {
  if (!/^\d{2}:\d{2}/.test(t)) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function formatTimeLabel(t: string): string {
  const min = timeToMin(t);
  if (min == null) return t;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ampm = h < 12 ? "AM" : "PM";
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatOverrideDate(iso: string): string {
  // iso = "YYYY-MM-DD"
  const d = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

function formatBlockoutRange(starts: string, ends: string): string {
  const s = new Date(`${starts}T12:00:00Z`);
  const e = new Date(`${ends}T12:00:00Z`);
  const sameMonth =
    s.getUTCFullYear() === e.getUTCFullYear() &&
    s.getUTCMonth() === e.getUTCMonth();
  if (starts === ends) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(s);
  }
  if (sameMonth) {
    const month = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "long",
    }).format(s);
    return `${month} ${s.getUTCDate()} – ${e.getUTCDate()}, ${s.getUTCFullYear()}`;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
  return `${fmt.format(s)} – ${fmt.format(e)}, ${e.getUTCFullYear()}`;
}

function daysBetweenInclusive(starts: string, ends: string): number {
  const s = Date.parse(`${starts}T00:00:00Z`);
  const e = Date.parse(`${ends}T00:00:00Z`);
  return Math.max(1, Math.round((e - s) / 86_400_000) + 1);
}

type DayState = {
  is_open: boolean;
  open_time: string;
  close_time: string;
};

type Props = {
  studioSlug: string;
  appOrigin: string;
  defaults: StudioAvailabilityDefault[];
  overrides: StudioAvailabilityOverride[];
  blockouts: StudioBlockout[];
};

export function AvailabilityClient({
  studioSlug,
  appOrigin,
  defaults,
  overrides,
  blockouts,
}: Props) {
  const initialDays = useMemo(() => {
    const map = new Map<number, DayState>();
    for (let i = 0; i < 7; i++) {
      const row = defaults.find((d) => d.day_of_week === i);
      map.set(i, {
        is_open: row?.is_open ?? false,
        open_time: trimTime(row?.open_time ?? null) || "",
        close_time: trimTime(row?.close_time ?? null) || "",
      });
    }
    return map;
  }, [defaults]);

  const [days, setDays] = useState<Map<number, DayState>>(() => initialDays);
  const [editingDow, setEditingDow] = useState<number | null>(null);
  const [draft, setDraft] = useState<DayState | null>(null);
  const [savingDow, setSavingDow] = useState<number | null>(null);
  const [savedFor, setSavedFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingPreset, setPendingPreset] = useState<
    (typeof PRESETS)[number] | null
  >(null);
  const [presetPending, startPresetTransition] = useTransition();

  // Keep local map in sync if server props change after a revalidation.
  useEffect(() => {
    setDays(initialDays);
  }, [initialDays]);

  function openEditor(dow: number) {
    const current = days.get(dow);
    setEditingDow(dow);
    setError(null);
    setSavedFor(null);
    // Click a closed day to default into "Open" mode with sensible hours;
    // the user can still toggle Open off and save to keep it closed.
    setDraft({
      is_open: true,
      open_time: current?.open_time || DEFAULT_OPEN,
      close_time: current?.close_time || DEFAULT_CLOSE,
    });
  }

  function closeEditor() {
    setEditingDow(null);
    setDraft(null);
    setError(null);
  }

  async function saveDay() {
    if (editingDow == null || !draft) return;
    setError(null);
    if (draft.is_open) {
      if (!draft.open_time || !draft.close_time) {
        setError("Open and close times are required.");
        return;
      }
      const o = timeToMin(draft.open_time);
      const c = timeToMin(draft.close_time);
      if (o == null || c == null || o >= c) {
        setError("Close must be after open.");
        return;
      }
    }
    setSavingDow(editingDow);
    try {
      const fd = new FormData();
      fd.set("day_of_week", String(editingDow));
      fd.set("is_open", String(draft.is_open));
      if (draft.is_open) {
        fd.set("open_time", draft.open_time);
        fd.set("close_time", draft.close_time);
      }
      await upsertDayDefaultAction(fd);
      // Update local map so the grid refreshes instantly.
      setDays((m) => {
        const next = new Map(m);
        next.set(editingDow, {
          is_open: draft.is_open,
          open_time: draft.is_open ? draft.open_time : "",
          close_time: draft.is_open ? draft.close_time : "",
        });
        return next;
      });
      setSavedFor(editingDow);
      window.setTimeout(() => setSavedFor(null), 1500);
      closeEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSavingDow(null);
    }
  }

  function closeDayInEditor() {
    if (!draft) return;
    setDraft({ ...draft, is_open: false });
  }

  function copyHoursFrom(sourceDow: number) {
    if (!draft) return;
    const src = days.get(sourceDow);
    if (!src || !src.is_open) return;
    setDraft({
      ...draft,
      is_open: true,
      open_time: src.open_time,
      close_time: src.close_time,
    });
  }

  function requestApplyPreset(preset: (typeof PRESETS)[number]) {
    setPendingPreset(preset);
  }

  function cancelPreset() {
    setPendingPreset(null);
  }

  function confirmApplyPreset() {
    if (!pendingPreset) return;
    const preset = pendingPreset;
    startPresetTransition(async () => {
      try {
        const fd = new FormData();
        for (const d of preset.days) {
          fd.set(`is_open_${d.dow}`, String(d.is_open));
          if (d.is_open && d.open && d.close) {
            fd.set(`open_time_${d.dow}`, d.open);
            fd.set(`close_time_${d.dow}`, d.close);
          }
        }
        await saveWeeklyDefaultsAction(fd);
        const next = new Map<number, DayState>();
        for (const d of preset.days) {
          next.set(d.dow, {
            is_open: d.is_open,
            open_time: d.is_open ? (d.open ?? "") : "",
            close_time: d.is_open ? (d.close ?? "") : "",
          });
        }
        setDays(next);
        setPendingPreset(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not apply preset.");
        setPendingPreset(null);
      }
    });
  }

  const openDaysForCopy = useMemo(() => {
    const out: { dow: number; label: string; range: string }[] = [];
    for (let i = 0; i < 7; i++) {
      if (i === editingDow) continue;
      const d = days.get(i);
      if (d?.is_open && d.open_time && d.close_time) {
        out.push({
          dow: i,
          label: DAY_NAMES_LONG[i],
          range: `${formatTimeLabel(d.open_time)} – ${formatTimeLabel(d.close_time)}`,
        });
      }
    }
    return out;
  }, [days, editingDow]);

  const upcomingChanges = useMemo(() => {
    const todayIso = new Date().toISOString().slice(0, 10);
    type Item =
      | {
          kind: "override";
          when: string;
          label: string;
          detail: string;
        }
      | {
          kind: "blockout";
          when: string;
          label: string;
          detail: string;
        };
    const items: Item[] = [];
    for (const o of overrides) {
      if (o.effective_date < todayIso) continue;
      items.push({
        kind: "override",
        when: o.effective_date,
        label: formatOverrideDate(o.effective_date),
        detail: o.is_open
          ? `${formatTimeLabel(trimTime(o.open_time))} – ${formatTimeLabel(trimTime(o.close_time))}`
          : "Closed",
      });
    }
    for (const b of blockouts) {
      if (b.ends_on < todayIso) continue;
      items.push({
        kind: "blockout",
        when: b.starts_on,
        label: formatBlockoutRange(b.starts_on, b.ends_on),
        detail: b.reason ?? "Blockout",
      });
    }
    items.sort((a, b) => a.when.localeCompare(b.when));
    return items.slice(0, 5);
  }, [overrides, blockouts]);

  return (
    <div className="flex flex-col gap-10">
      <BookingLinkCard
        slug={studioSlug}
        origin={appOrigin}
        variant="inline"
      />

      {upcomingChanges.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Upcoming changes
          </h3>
          <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {upcomingChanges.map((item, i) => (
              <li
                key={`${item.kind}-${item.when}-${i}`}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm"
              >
                <span className="flex items-baseline gap-3">
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
                    {item.kind === "override" ? "Override" : "Blockout"}
                  </span>
                  <span className="font-medium">{item.label}</span>
                </span>
                <span className="text-neutral-500">{item.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-xl font-medium">Weekly hours</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Click a day to set or change its hours.
            </p>
          </div>
        </div>

        {editingDow != null && draft && (
          <DayEditor
            dow={editingDow}
            draft={draft}
            saving={savingDow === editingDow}
            error={error}
            openDaysForCopy={openDaysForCopy}
            onChangeOpen={(v) => setDraft({ ...draft, open_time: v })}
            onChangeClose={(v) => setDraft({ ...draft, close_time: v })}
            onToggleOpen={() =>
              setDraft({ ...draft, is_open: !draft.is_open })
            }
            onCloseDay={closeDayInEditor}
            onCopyFrom={copyHoursFrom}
            onCancel={closeEditor}
            onSave={saveDay}
          />
        )}

        <WeeklyGrid
          days={days}
          editingDow={editingDow}
          savedFor={savedFor}
          onPick={openEditor}
        />

        <div className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Quick set
          </p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => requestApplyPreset(p)}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
              >
                {p.label}
              </button>
            ))}
          </div>
          {pendingPreset && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-100">
              <span>
                Replace current hours with{" "}
                <span className="font-medium">{pendingPreset.label}</span>?{" "}
                <span className="text-amber-700 dark:text-amber-300">
                  {pendingPreset.description}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={confirmApplyPreset}
                  disabled={presetPending}
                  className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                >
                  {presetPending ? "Applying…" : "Replace"}
                </button>
                <button
                  type="button"
                  onClick={cancelPreset}
                  className="rounded-md border border-amber-400 px-3 py-1 text-xs hover:bg-white/50 dark:border-amber-700 dark:hover:bg-amber-900/40"
                >
                  Cancel
                </button>
              </span>
            </div>
          )}
        </div>
      </section>

      <OverridesSection overrides={overrides} />

      <BlockoutsSection blockouts={blockouts} />
    </div>
  );
}

function WeeklyGrid({
  days,
  editingDow,
  savedFor,
  onPick,
}: {
  days: Map<number, DayState>;
  editingDow: number | null;
  savedFor: number | null;
  onPick: (dow: number) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div className="min-w-[640px]">
        <div className="grid grid-cols-[48px_repeat(7,_minmax(0,1fr))] border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
          <div />
          {DAY_LABELS.map((label) => (
            <div
              key={label}
              className="border-l border-neutral-200 px-3 py-2 text-center text-xs font-medium dark:border-neutral-800"
            >
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-[48px_repeat(7,_minmax(0,1fr))]">
          <div className="border-r border-neutral-200 dark:border-neutral-800">
            {Array.from(
              {
                length: Math.ceil((GRID_END_MIN - GRID_START_MIN) / 60 / 2),
              },
              (_, i) => GRID_START_MIN + i * 120,
            ).map((m) => (
              <div
                key={m}
                style={{ height: 2 * HOUR_HEIGHT_PX }}
                className="border-b border-neutral-200 px-1 pt-1 text-right text-[10px] uppercase tracking-wider text-neutral-500 dark:border-neutral-800"
              >
                {formatTimeLabel(minToTime(m))}
              </div>
            ))}
          </div>
          {Array.from({ length: 7 }, (_, i) => i).map((dow) => {
            const day = days.get(dow);
            const isOpen = day?.is_open ?? false;
            const isEditing = editingDow === dow;
            const justSaved = savedFor === dow;
            const open = day?.open_time ? timeToMin(day.open_time) : null;
            const close = day?.close_time ? timeToMin(day.close_time) : null;
            const blockTop =
              open != null
                ? ((Math.max(open, GRID_START_MIN) - GRID_START_MIN) / 60) *
                  HOUR_HEIGHT_PX
                : 0;
            const blockHeight =
              open != null && close != null
                ? ((Math.min(close, GRID_END_MIN) - Math.max(open, GRID_START_MIN)) /
                    60) *
                  HOUR_HEIGHT_PX
                : 0;

            return (
              <button
                key={dow}
                type="button"
                onClick={() => onPick(dow)}
                style={{ height: GRID_HEIGHT }}
                className={
                  "relative border-l border-neutral-200 text-left transition-colors dark:border-neutral-800 " +
                  (isEditing
                    ? "bg-neutral-100 dark:bg-neutral-900"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-900")
                }
                aria-label={`Edit ${DAY_NAMES_LONG[dow]}`}
              >
                {Array.from(
                  {
                    length: (GRID_END_MIN - GRID_START_MIN) / 60,
                  },
                  (_, i) => i,
                ).map((row) => (
                  <div
                    key={row}
                    style={{
                      top: row * HOUR_HEIGHT_PX,
                      height: HOUR_HEIGHT_PX,
                    }}
                    className="absolute inset-x-0 border-b border-neutral-200/60 dark:border-neutral-800/60"
                  />
                ))}
                {isOpen && open != null && close != null && blockHeight > 0 ? (
                  <div
                    style={{ top: blockTop, height: blockHeight }}
                    className="absolute inset-x-1 z-10 rounded-md border border-neutral-900 bg-neutral-900 px-1.5 py-1 text-[11px] font-medium text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  >
                    {formatTimeLabel(day!.open_time)}
                    <br />
                    {formatTimeLabel(day!.close_time)}
                  </div>
                ) : (
                  <div className="absolute inset-0 z-10 flex items-center justify-center">
                    <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] uppercase tracking-wider text-neutral-500 dark:bg-neutral-900 dark:text-neutral-500">
                      Closed
                    </span>
                  </div>
                )}
                {justSaved && (
                  <span className="absolute right-1 top-1 z-20 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300">
                    Saved
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DayEditor({
  dow,
  draft,
  saving,
  error,
  openDaysForCopy,
  onChangeOpen,
  onChangeClose,
  onToggleOpen,
  onCloseDay,
  onCopyFrom,
  onCancel,
  onSave,
}: {
  dow: number;
  draft: DayState;
  saving: boolean;
  error: string | null;
  openDaysForCopy: { dow: number; label: string; range: string }[];
  onChangeOpen: (v: string) => void;
  onChangeClose: (v: string) => void;
  onToggleOpen: () => void;
  onCloseDay: () => void;
  onCopyFrom: (sourceDow: number) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-300 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-950">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{DAY_NAMES_LONG[dow]}</h3>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.is_open}
            onChange={onToggleOpen}
          />
          Open
        </label>
      </div>

      {draft.is_open ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Opens
            </span>
            <TimePicker value={draft.open_time} onChange={onChangeOpen} />
          </div>
          <span className="pb-2 text-neutral-400">to</span>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Closes
            </span>
            <TimePicker value={draft.close_time} onChange={onChangeClose} />
          </div>
          {openDaysForCopy.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Copy from
              </span>
              <select
                defaultValue=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) onCopyFrom(Number(v));
                  e.target.value = "";
                }}
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              >
                <option value="">Pick a day…</option>
                {openDaysForCopy.map((d) => (
                  <option key={d.dow} value={d.dow}>
                    {d.label} ({d.range})
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            onClick={onCloseDay}
            className="ml-auto self-end text-xs text-neutral-500 hover:text-neutral-900 hover:underline dark:hover:text-neutral-100"
          >
            Close this day
          </button>
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          This day is closed. Toggle Open above to set hours.
        </p>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Custom dropdown picker for HH:MM values in 15-min increments between
// GRID_START_MIN and GRID_END_MIN. Falls back to typing if the user prefers.
function TimePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const options = useMemo(() => {
    const out: string[] = [];
    for (let m = GRID_START_MIN; m <= GRID_END_MIN; m += 15) {
      out.push(minToTime(m));
    }
    return out;
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="min-w-[110px] rounded-md border border-neutral-300 bg-white px-3 py-2 text-left text-sm tabular-nums hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950"
      >
        {value ? formatTimeLabel(value) : "Pick time"}
      </button>
      {open && (
        <ul className="absolute z-20 mt-1 max-h-64 w-44 overflow-y-auto rounded-md border border-neutral-300 bg-white py-1 text-sm shadow-md dark:border-neutral-700 dark:bg-neutral-950">
          {options.map((t) => {
            const selected = t === value;
            return (
              <li key={t}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(t);
                    setOpen(false);
                  }}
                  className={
                    "w-full px-3 py-1.5 text-left tabular-nums " +
                    (selected
                      ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                      : "hover:bg-neutral-100 dark:hover:bg-neutral-900")
                  }
                >
                  {formatTimeLabel(t)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function OverridesSection({
  overrides,
}: {
  overrides: StudioAvailabilityOverride[];
}) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-xl font-medium">Overrides</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Set different hours for a specific date (extra day open, shorter
            day, etc.).
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            + Add override
          </button>
        )}
      </div>

      {adding && <AddOverrideForm onDone={() => setAdding(false)} />}

      {overrides.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          No overrides yet. Add one to handle a specific date.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {overrides.map((o) => (
            <li
              key={o.id}
              className="flex flex-wrap items-baseline justify-between gap-3 rounded-md border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">
                  {formatOverrideDate(o.effective_date)}
                </span>
                <span className="text-xs text-neutral-500">
                  {o.is_open
                    ? `${formatTimeLabel(trimTime(o.open_time))} – ${formatTimeLabel(trimTime(o.close_time))}`
                    : "Closed"}
                  {o.note ? ` · ${o.note}` : ""}
                </span>
              </div>
              <form action={deleteOverrideAction}>
                <input type="hidden" name="id" value={o.id} />
                <button
                  type="submit"
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddOverrideForm({ onDone }: { onDone: () => void }) {
  const [date, setDate] = useState("");
  const [isOpenToggle, setIsOpenToggle] = useState(true);
  const [openTime, setOpenTime] = useState(DEFAULT_OPEN);
  const [closeTime, setCloseTime] = useState(DEFAULT_CLOSE);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!date) {
      setError("Pick a date.");
      return;
    }
    if (isOpenToggle) {
      const o = timeToMin(openTime);
      const c = timeToMin(closeTime);
      if (o == null || c == null || o >= c) {
        setError("Close must be after open.");
        return;
      }
    }
    const fd = new FormData();
    fd.set("effective_date", date);
    fd.set("is_open", String(isOpenToggle));
    if (isOpenToggle) {
      fd.set("open_time", openTime);
      fd.set("close_time", closeTime);
    }
    if (note) fd.set("note", note);
    startTransition(async () => {
      try {
        await upsertOverrideAction(fd);
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed.");
      }
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-md border border-neutral-300 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-950"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Date
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="inline-flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            checked={isOpenToggle}
            onChange={() => setIsOpenToggle((v) => !v)}
          />
          Open
        </label>
        {isOpenToggle && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Opens
              </span>
              <TimePicker value={openTime} onChange={setOpenTime} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Closes
              </span>
              <TimePicker value={closeTime} onChange={setCloseTime} />
            </div>
          </>
        )}
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving…" : "Save override"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function BlockoutsSection({ blockouts }: { blockouts: StudioBlockout[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-xl font-medium">Blockouts</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Date ranges with no bookings (vacation, sick days, etc.).
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            + Add blockout
          </button>
        )}
      </div>

      {adding && <AddBlockoutForm onDone={() => setAdding(false)} />}

      {blockouts.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          No blockouts.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {blockouts.map((b) => (
            <li
              key={b.id}
              className="flex flex-wrap items-baseline justify-between gap-3 rounded-md border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">
                  {formatBlockoutRange(b.starts_on, b.ends_on)}
                </span>
                <span className="text-xs text-neutral-500">
                  {daysBetweenInclusive(b.starts_on, b.ends_on)} days
                  {b.reason ? ` · ${b.reason}` : ""}
                </span>
              </div>
              <form action={deleteBlockoutAction}>
                <input type="hidden" name="id" value={b.id} />
                <button
                  type="submit"
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddBlockoutForm({ onDone }: { onDone: () => void }) {
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!starts || !ends) {
      setError("Pick start and end dates.");
      return;
    }
    if (ends < starts) {
      setError("End must be on or after start.");
      return;
    }
    const fd = new FormData();
    fd.set("starts_on", starts);
    fd.set("ends_on", ends);
    if (reason) fd.set("reason", reason);
    startTransition(async () => {
      try {
        const result = await createBlockoutAction(fd);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed.");
      }
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-md border border-neutral-300 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-950"
    >
      <div className="grid gap-3 md:grid-cols-[10rem_10rem_minmax(0,1fr)]">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Starts
          </span>
          <input
            type="date"
            value={starts}
            onChange={(e) => setStarts(e.target.value)}
            required
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Ends
          </span>
          <input
            type="date"
            value={ends}
            onChange={(e) => setEnds(e.target.value)}
            required
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Reason
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving…" : "Save blockout"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
