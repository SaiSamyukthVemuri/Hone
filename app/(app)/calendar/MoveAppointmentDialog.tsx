"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  formatTimeForStudio,
  localDateString,
  localLongDate,
  localTimeString,
  utcInstantFromLocal,
} from "@/lib/booking/tz";
import {
  loadMoveSlotsAction,
  moveAppointmentAction,
  type MoveSlot,
} from "./move-appointment-actions";

// Practitioner Move appointment — ONE shared responsive dialog + state machine used by
// mobile, tablet, and desktop (responsive by Tailwind; no separate mobile/desktop paths).
// Mobile: full-width bottom sheet (<= 90dvh, safe-area padding, sticky header/footer,
// 44px tap targets, 2-col time grid). Tablet/desktop: centered modal (wider time grid,
// keyboard-operable, focus trapped, Escape closes when idle, focus returns to the opener).
//
// Two modes share the same state machine + the same server action:
//   * "available_slot" (default) — pick a generated available time (server-verified).
//   * "custom_time" (OWNER ONLY) — enter a studio-local time that may be outside regular
//     operating hours; still conflict-safe (the DB reservations/constraints reject
//     overlaps). The custom option renders ONLY when the SERVER says the caller is an
//     owner (canUseCustomTime from loadMoveSlotsAction); the action re-authorizes on submit.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export type MoveDialogAppointment = {
  id: string;
  startsAt: string; // ISO UTC
  endsAt: string; // ISO UTC
  durationMinutes: number;
  clientName: string | null;
  serviceName: string | null;
  practitionerName?: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onMoved: (r: { startsAt: string; endsAt: string; notificationStatus: string; message: string }) => void;
  appointment: MoveDialogAppointment;
  studioTimezone: string;
  timeFormat: "12h" | "24h";
};

type Mode = "available_slot" | "custom_time";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function MoveAppointmentDialog({ open, onClose, onMoved, appointment, studioTimezone, timeFormat }: Props) {
  const tz = studioTimezone;
  const currentLocalDate = useMemo(() => localDateString(new Date(appointment.startsAt), tz), [appointment.startsAt, tz]);
  const todayLocal = useMemo(() => localDateString(new Date(), tz), [tz]);

  const [date, setDate] = useState(currentLocalDate);
  const [slots, setSlots] = useState<MoveSlot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MoveSlot | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [loadingSlots, startLoad] = useTransition();
  const [submitting, startSubmit] = useTransition();

  // Custom-time mode (owner only). `canUseCustomTime` is authoritative from the server.
  const [mode, setMode] = useState<Mode>("available_slot");
  const [canUseCustomTime, setCanUseCustomTime] = useState(false);
  const [customTime, setCustomTime] = useState(""); // studio-local "HH:MM"
  const [ackOverride, setAckOverride] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const currentDayLabel = useMemo(() => localLongDate(new Date(appointment.startsAt), tz), [appointment.startsAt, tz]);
  const currentTimeLabel = useMemo(() => formatTimeForStudio(new Date(appointment.startsAt), tz, timeFormat), [appointment.startsAt, tz, timeFormat]);
  const newDayLabel = useMemo(() => (selected ? localLongDate(new Date(selected.start), tz) : null), [selected, tz]);

  // Studio-tz instant for the custom date+time (DST-correct), for the confirm summary.
  const customInstant = useMemo(() => {
    if (!DATE_RE.test(date) || !TIME_RE.test(customTime)) return null;
    const d = utcInstantFromLocal(date, customTime, tz);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [date, customTime, tz]);
  const customDayLabel = customInstant ? localLongDate(customInstant, tz) : null;
  const customTimeLabel = customInstant ? formatTimeForStudio(customInstant, tz, timeFormat) : null;

  // Load authorized available times for a given local date. Preserves the current
  // selection only when the new list still contains it (else clears the incompatible time).
  const load = useCallback(
    (forDate: string) => {
      setLoadError(null);
      startLoad(async () => {
        const res = await loadMoveSlotsAction({ appointmentId: appointment.id, localDate: forDate });
        if (!res.ok) {
          setSlots([]);
          setLoadError(res.error);
          setSelected(null);
          return;
        }
        setSlots(res.slots);
        setCanUseCustomTime(res.canUseCustomTime); // server-authoritative owner flag
        setSelected((prev) => (prev && res.slots.some((s) => s.start === prev.start) ? prev : null));
      });
    },
    [appointment.id],
  );

  // On open: reset to the appointment's current date + default (available) mode and
  // load its times; capture the opener.
  useEffect(() => {
    if (!open) return;
    openerRef.current = (document.activeElement as HTMLElement) ?? null;
    setDate(currentLocalDate);
    setSelected(null);
    setMoveError(null);
    setMode("available_slot");
    setCustomTime("");
    setAckOverride(false);
    setCanUseCustomTime(false);
    load(currentLocalDate);
    const t = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus trap + Escape (idle only). This effect re-runs whenever `submitting`
  // flips, so its cleanup must NOT move focus (that would yank focus out of the
  // dialog mid-submit); focus return lives in its own open-scoped effect below.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  // Return focus to the opener ONLY when the dialog actually closes/unmounts —
  // keyed on `open` alone so a mid-flight `submitting` change never steals focus.
  useEffect(() => {
    if (!open) return;
    return () => {
      openerRef.current?.focus?.();
    };
  }, [open]);

  const onPickDate = (d: string) => {
    setDate(d);
    setMoveError(null);
    // In available mode a slot chosen on the previous date is never valid for the new
    // date; clear it synchronously and reload. In custom mode the date is independent
    // of the generated slot list, so no reload/clear is needed.
    if (mode === "available_slot") {
      setSelected(null);
      load(d);
    }
  };

  // Mode switches clear incompatible state so stale state from one mode can never
  // submit through the other (§13).
  const switchToAvailable = () => {
    if (submitting || mode === "available_slot") return;
    setMode("available_slot");
    setCustomTime("");
    setAckOverride(false);
    setMoveError(null);
    load(date); // reload current available slots
  };
  const switchToCustom = () => {
    if (submitting || mode === "custom_time" || !canUseCustomTime) return;
    setMode("custom_time");
    setSelected(null); // clear generated slot
    setMoveError(null); // clear generated-slot conflict errors
  };

  const canConfirm =
    mode === "available_slot"
      ? !!selected && !loadingSlots
      : TIME_RE.test(customTime) && ackOverride;

  const confirmMove = () => {
    if (submitting || !canConfirm) return;
    let localTime: string;
    let ack = false;
    if (mode === "available_slot") {
      if (!selected) return;
      localTime = localTimeString(new Date(selected.start), tz); // 24h HH:MM in the studio tz
    } else {
      if (!TIME_RE.test(customTime) || !ackOverride) return;
      localTime = customTime;
      ack = true;
    }
    const submitMode = mode;
    setMoveError(null);
    startSubmit(async () => {
      const res = await moveAppointmentAction({
        appointmentId: appointment.id,
        expectedStartsAt: appointment.startsAt,
        expectedEndsAt: appointment.endsAt,
        localDate: date,
        localTime,
        mode: submitMode,
        outsideAvailabilityConfirmed: ack,
      });
      if (res.ok) {
        onMoved(res);
        return;
      }
      if (res.code === "conflict") {
        setMoveError(res.error);
        if (submitMode === "available_slot") {
          setSelected(null);
          load(date); // refresh the times; the appointment did NOT move
        }
        // custom mode stays selected; the error marks the entered time invalid.
        return;
      }
      // stale / no_change / generic — keep the dialog open, show safe copy.
      setMoveError(res.error);
      if (res.code === "stale" && submitMode === "available_slot") load(date);
    });
  };

  if (!open) return null;

  const segClass = (active: boolean) =>
    `min-h-[44px] rounded-lg border px-3 py-2 text-sm font-medium transition ${
      active
        ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
        : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Move appointment">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => { if (!submitting) onClose(); }}
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
      />
      <div
        ref={panelRef}
        className="relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl dark:bg-neutral-950 sm:max-h-[85vh] sm:w-[540px] sm:rounded-2xl"
      >
        {/* Sticky header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-200 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950">
          <h2 className="font-serif text-lg font-semibold">Move appointment</h2>
          <button type="button" onClick={() => { if (!submitting) onClose(); }} disabled={submitting} aria-label="Close" className="min-h-[44px] min-w-[44px] rounded-lg px-2 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-900">✕</button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Current appointment */}
          <section className="rounded-xl bg-neutral-50 p-4 text-sm dark:bg-neutral-900">
            <div className="font-medium">{appointment.clientName ?? "Client"} · {appointment.serviceName ?? "Appointment"}</div>
            <div className="mt-1 text-neutral-600 dark:text-neutral-400">Currently {currentDayLabel} at {currentTimeLabel}</div>
            <div className="mt-0.5 text-neutral-500">{appointment.durationMinutes} min{appointment.practitionerName ? ` · ${appointment.practitionerName}` : ""}</div>
          </section>

          {/* Owner-only mode selector. Rendered ONLY when the server says the caller
              is an owner; a non-owner never sees the custom-time option. */}
          {canUseCustomTime && (
            <div className="mt-5" role="group" aria-label="How to choose the time">
              <span className="text-sm font-medium">How to choose the time</span>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" onClick={switchToAvailable} aria-pressed={mode === "available_slot"} disabled={submitting} className={segClass(mode === "available_slot")}>
                  Available times
                </button>
                <button type="button" onClick={switchToCustom} aria-pressed={mode === "custom_time"} disabled={submitting} className={segClass(mode === "custom_time")}>
                  Custom time
                </button>
              </div>
            </div>
          )}

          {/* Choose date (shared by both modes) */}
          <label className="mt-5 block">
            <span className="text-sm font-medium">New date</span>
            <input
              type="date"
              value={date}
              min={todayLocal}
              onChange={(e) => onPickDate(e.target.value)}
              disabled={submitting}
              className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-3 text-base focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          {mode === "available_slot" ? (
            /* Available-times mode */
            <div className="mt-5">
              <span className="text-sm font-medium">New time</span>
              {loadingSlots ? (
                <p className="mt-3 text-sm text-neutral-500">Loading available times…</p>
              ) : loadError ? (
                <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  {loadError}{" "}
                  <button type="button" onClick={() => load(date)} className="underline">Try again</button>
                </div>
              ) : slots && slots.length === 0 ? (
                <p className="mt-3 text-sm text-neutral-500">No available times on this date.</p>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {(slots ?? []).map((s) => {
                    const isSel = selected?.start === s.start;
                    return (
                      <button
                        key={s.start}
                        type="button"
                        onClick={() => { setSelected(s); setMoveError(null); }}
                        disabled={submitting}
                        aria-pressed={isSel}
                        className={`min-h-[44px] rounded-lg border px-2 py-2 text-sm transition ${isSel ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"}`}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Custom-time mode (owner override) */
            <div className="mt-5">
              <label className="block">
                <span className="text-sm font-medium">Custom time</span>
                <input
                  type="time"
                  step={900}
                  value={customTime}
                  onChange={(e) => { setCustomTime(e.target.value); setMoveError(null); }}
                  disabled={submitting}
                  aria-label="Custom time"
                  className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-3 text-base focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <p className="mt-1 text-xs text-neutral-500">Studio time zone: {tz}</p>
              <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                Custom time can be outside regular operating hours. Existing appointments, buffers and blocked time still apply.
              </p>
              <label className="mt-3 flex min-h-[44px] items-center gap-3">
                <input
                  type="checkbox"
                  checked={ackOverride}
                  onChange={(e) => { setAckOverride(e.target.checked); setMoveError(null); }}
                  disabled={submitting}
                  className="h-5 w-5 flex-shrink-0 rounded border-neutral-400 disabled:opacity-50"
                />
                <span className="text-sm">I understand this time overrides regular availability.</span>
              </label>
            </div>
          )}

          {/* Confirm summary */}
          {mode === "available_slot" && selected && (
            <section className="mt-5 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
              <div className="font-medium">Confirm move</div>
              <div className="mt-2 flex flex-col gap-1 text-neutral-600 dark:text-neutral-400">
                <span>From: {currentDayLabel} at {currentTimeLabel}</span>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">To: {newDayLabel} at {selected.label}</span>
                <span>Duration unchanged: {appointment.durationMinutes} min</span>
              </div>
            </section>
          )}
          {mode === "custom_time" && customInstant && (
            <section className="mt-5 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">Confirm move</div>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">Custom-time override</span>
              </div>
              <div className="mt-2 flex flex-col gap-1 text-neutral-600 dark:text-neutral-400">
                <span>{appointment.clientName ?? "Client"} · {appointment.serviceName ?? "Appointment"}</span>
                <span>From: {currentDayLabel} at {currentTimeLabel}</span>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">To: {customDayLabel} at {customTimeLabel}</span>
                <span>Duration unchanged: {appointment.durationMinutes} min</span>
              </div>
            </section>
          )}

          {moveError && (
            <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">{moveError}</div>
          )}
        </div>

        {/* Sticky footer (safe-area padded on mobile) */}
        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-neutral-200 bg-white px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] dark:border-neutral-800 dark:bg-neutral-950 sm:pb-4">
          <button type="button" onClick={() => { if (!submitting) onClose(); }} disabled={submitting} className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900">Keep current time</button>
          <button type="button" onClick={confirmMove} disabled={!canConfirm || submitting} className="min-h-[44px] rounded-lg bg-neutral-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
            {submitting ? "Moving appointment…" : "Move appointment"}
          </button>
        </div>
      </div>
    </div>
  );
}
